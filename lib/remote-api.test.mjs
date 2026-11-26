import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRemoteApi, hashPassword } from './remote-api.mjs';

const migrations = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const sql = migrations.entries.map((entry) => readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8')).join('\n');
const users = await Promise.all(['641', '638', '404'].map(async (barangay) => ({
  username: `barangay${barangay}`, barangay, name: `Barangay ${barangay}`,
  salt: '11111111111111111111111111111111',
  passwordHash: await hashPassword(`testing-${barangay}`, '11111111111111111111111111111111'),
})));

function setup(envOverrides = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(sql);
  const DB = {
    prepare(query) {
      const statement = sqlite.prepare(query);
      const prepareBound = (args = []) => ({
        bind: (...values) => prepareBound(values),
        first: async () => statement.get(...args) ?? null,
        all: async () => ({ results: statement.all(...args) }),
        run: async () => ({ meta: statement.run(...args) }),
        execute: () => statement.run(...args),
      });
      return prepareBound();
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const env = { DB, SESSION_SECRET: 'session-secret-1234567890123456789012345',
    DESKTOP_TOKEN: 'desktop-secret-1234567890123456789012345', ACCOUNT_CREDENTIALS_JSON: JSON.stringify(users), ...envOverrides };
  const call = async (url, options = {}) => {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    const response = await handleRemoteApi(new Request(`https://desk.test${url}`, { ...options, headers,
      body: options.body ? JSON.stringify(options.body) : undefined }), env);
    return { response, data: await response.json() };
  };
  const login = async (barangay) => {
    const { response } = await call('/api/login', { method: 'POST', body: { username: `barangay${barangay}`, password: `testing-${barangay}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
    return { cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const stations = ['641', '638', '404'].map((barangay) => ({ barangay, sourceId: barangay,
    label: 'MONITOR', type: 'normal', reason: 'Below watch threshold', level: 4, temp: 28, humidity: 60,
    quality: 'valid', source: 'Software simulation' }));
  const sync = (sequence, values = stations, token = env.DESKTOP_TOKEN, extras = {}) => call('/api/desktop/sync', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: { clientId: 'test-client-1', sequence, stations: values, ...extras },
  });
  return { sqlite, env, call, login, stations, sync };
}

test('a stale duplicate session cookie sent first does not block the fresh one', async () => {
  const { call, login } = setup();
  const headers = await login('641');
  const stale = 'bantay_session=eyJ1c2VybmFtZSI6IjY0MSIsImV4cGlyZXMiOjB9.deadbeef';
  const both = await call('/api/session', { headers: { cookie: `${stale}; ${headers.cookie}` } });
  assert.equal(both.response.status, 200);
  assert.equal(both.data.user.username, 'barangay641');
  assert.equal((await call('/api/session', { headers: { cookie: stale } })).response.status, 401);
});

test('login scopes accounts, rejects tampering and clears the browser session', async () => {
  const { call, login } = setup();
  assert.equal((await call('/api/dashboard')).response.status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { username: 'barangay641', password: 'wrong' } })).response.status, 401);
  const headers = await login('641');
  const session = await call('/api/session?barangay=404', { headers });
  assert.equal(session.data.user.barangay, '641');
  assert.equal((await call('/api/session', { headers: { cookie: `${headers.cookie}tampered` } })).response.status, 401);
  const logout = await call('/api/logout', { method: 'POST', headers });
  assert.match(logout.response.headers.get('set-cookie'), /Max-Age=0/);
});

test('accounts see only their barangay and cross-barangay responses are rejected', async () => {
  const { call, login, stations, sync } = setup();
  stations[0] = { ...stations[0], label: 'BENCH ALERT', type: 'alert', level: 17 };
  stations[2] = { ...stations[2], label: 'HEAT REVIEW', type: 'watch', temp: 38 };
  assert.equal((await sync(0)).response.status, 200);
  const headerA = await login('641');
  const headerB = await login('638');
  const a = (await call('/api/dashboard', { headers: headerA })).data;
  const b = (await call('/api/dashboard', { headers: headerB })).data;
  assert.equal(a.station.barangay, '641');
  assert.equal(a.alerts.length, 1);
  assert.equal(b.alerts.length, 0);
  assert.equal(b.station.barangay, '638');
  assert.equal(a.connection.online, true);
  const blocked = await call(`/api/alerts/${a.alerts[0].id}/respond`, { method: 'POST', headers: headerB, body: { decision: 'verify', note: 'Checking' } });
  assert.equal(blocked.response.status, 404);
  const response = await call(`/api/alerts/${a.alerts[0].id}/respond`, { method: 'POST', headers: headerA, body: { decision: 'verify', note: 'Checking', requestId: 'response-request-1' } });
  assert.equal(response.response.status, 200);
  assert.equal(response.data.response.barangay, '641');
  const desktop = await sync(1);
  assert.equal(desktop.data.responses.length, 1);
  assert.equal(desktop.data.responses[0].note, 'Checking');
});

test('duplicate and delayed desktop packets preserve recovery and allow a later new incident', async () => {
  const { call, login, stations, sync, sqlite } = setup();
  const headers = await login('641');
  const high = stations.map((station, index) => index ? station : { ...station, type: 'alert', label: 'BENCH ALERT', level: 17 });
  await sync(1, high);
  await sync(1, high);
  assert.equal(sqlite.prepare('SELECT count(*) count FROM alerts').get().count, 1);
  await sync(2, high.map((station, index) => index ? station : { ...station, quality: 'stale', level: null, label: 'ALERT RETAINED' }));
  let data = (await call('/api/dashboard', { headers })).data;
  assert.equal(data.alerts[0].active, true);
  await sync(3, stations);
  await sync(2, high);
  data = (await call('/api/dashboard', { headers })).data;
  assert.equal(data.station.type, 'normal');
  assert.equal(data.alerts[0].active, false);
  assert.ok(data.alerts[0].resolvedAt);
  const result = await call(`/api/alerts/${data.alerts[0].id}/respond`, { method: 'POST', headers, body: { decision: 'acknowledge', note: '' } });
  assert.equal(result.response.status, 409);
  await sync(4, high);
  assert.equal(sqlite.prepare('SELECT count(*) count FROM alerts').get().count, 2);
  assert.equal(sqlite.prepare('SELECT count(*) count FROM alerts WHERE active=1').get().count, 1);
});

test('response retries are idempotent and credentials cannot be used for the wrong operation', async () => {
  const { call, login, sync, stations, sqlite } = setup();
  assert.equal((await sync(1, stations, 'wrong')).response.status, 401);
  stations[0].type = 'alert';
  await sync(1);
  const headers = await login('641');
  const { alerts } = (await call('/api/dashboard', { headers })).data;
  const options = { method: 'POST', headers, body: { decision: 'acknowledge', note: '', requestId: 'response-retry-1' } };
  const first = await call(`/api/alerts/${alerts[0].id}/respond`, options);
  const retry = await call(`/api/alerts/${alerts[0].id}/respond`, options);
  assert.deepEqual(first.data, retry.data);
  assert.equal(sqlite.prepare('SELECT count(*) count FROM responses').get().count, 1);
  const crossOrigin = await call('/api/logout', { method: 'POST', headers: { ...headers, origin: 'https://evil.test' } });
  assert.equal(crossOrigin.response.status, 403);
});

test('startup cannot clear a warning and public sync rejects invalid/general areas', async () => {
  const { sync, stations, call, login } = setup();
  stations[0].type = 'alert';
  await sync(1);
  stations[0] = { ...stations[0], type: 'unknown', quality: 'startup', level: null };
  await sync(2);
  const headers = await login('641');
  assert.equal((await call('/api/dashboard', { headers })).data.alerts[0].active, true);
  stations[2].barangay = 'ALL';
  assert.equal((await sync(3)).response.status, 400);
});

function operatorDecision(overrides = {}) {
  return {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), barangay: '641',
    school: 'Centro Escolar University Manila', sourceId: 'A', decision: 'Continue monitoring',
    reason: 'School and access route reviewed.', status: 'BENCH ALERT', quality: 'valid',
    campusExposure: 'unexposed', routeExposure: 'unexposed', ...overrides,
  };
}

test('desktop decisions reach their assigned account and preserve the active hazard', async () => {
  const { sync, stations, login, call } = setup();
  stations[0] = { ...stations[0], type: 'alert', label: 'BENCH ALERT', level: 17 };
  const decision = operatorDecision();
  const result = await sync(1, stations, undefined, { decisions: [decision] });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.acceptedDecisionIds, [decision.id]);
  const a = (await call('/api/dashboard', { headers: await login('641') })).data;
  const b = (await call('/api/dashboard', { headers: await login('638') })).data;
  assert.deepEqual(a.decisions, [{ ...decision, mode: null }]);
  assert.equal(a.alerts[0].active, true, 'an operator decision does not clear sensor evidence');
  assert.deepEqual(b.decisions, []);
});

test('decision retries are immutable, idempotent and independent of the station sequence', async () => {
  const { sync, stations, sqlite } = setup();
  const decision = operatorDecision();
  await sync(5, stations, undefined, { decisions: [decision] });
  const stored = sqlite.prepare('SELECT * FROM operator_decisions WHERE id=?').get(decision.id);
  const reordered = Object.fromEntries(Object.entries(decision).reverse());
  const retry = await sync(4, stations, undefined, { decisions: [reordered] });
  assert.equal(retry.response.status, 200);
  assert.deepEqual(retry.data.acceptedDecisionIds, [decision.id]);
  assert.deepEqual(sqlite.prepare('SELECT * FROM operator_decisions WHERE id=?').get(decision.id), stored);
  const offlineDecision = operatorDecision({ decision: 'Verify local route', sourceId: 'Unassigned' });
  const delayed = await sync(3, stations, undefined, { decisions: [offlineDecision] });
  assert.deepEqual(delayed.data.acceptedDecisionIds, [offlineDecision.id]);
  assert.equal(sqlite.prepare('SELECT count(*) count FROM operator_decisions').get().count, 2);
  assert.equal(sqlite.prepare('SELECT sequence FROM desktop_clients').get().sequence, 5);
});

test('invalid decision batches make no partial station or decision writes', async () => {
  const { sync, stations, sqlite } = setup();
  await sync(1);
  const high = stations.map((station, index) => index ? station : { ...station, type: 'alert', level: 17 });
  const decision = operatorDecision();
  for (const invalid of [
    { barangay: 'ALL' }, { id: 'not-a-uuid' }, { createdAt: '2026-02-31T00:00:00.000Z' },
    { reason: 'x'.repeat(1001) }, { school: ' ' }, { campusExposure: 'safe' }, { sourceId: 'D' },
  ]) {
    const result = await sync(2, high, undefined, { decisions: [decision, operatorDecision(invalid)] });
    assert.equal(result.response.status, 400);
  }
  for (const invalidBatch of [null, {}, [decision, decision], Array.from({ length: 51 }, () => operatorDecision())])
    assert.equal((await sync(2, high, undefined, { decisions: invalidBatch })).response.status, 400);
  assert.equal(sqlite.prepare('SELECT type FROM stations WHERE barangay=?').get('641').type, 'normal');
  assert.equal(sqlite.prepare('SELECT sequence FROM desktop_clients').get().sequence, 1);
  assert.equal(sqlite.prepare('SELECT count(*) count FROM operator_decisions').get().count, 0);
});

test('decision identifier conflicts roll back the whole batch for altered payload or another client', async () => {
  const { sync, stations, sqlite } = setup();
  const decision = operatorDecision();
  await sync(1, stations, undefined, { decisions: [decision] });
  const high = stations.map((station, index) => index ? station : { ...station, type: 'alert', level: 17 });
  const unrelated = operatorDecision();
  const altered = await sync(2, high, undefined, { decisions: [unrelated, { ...decision, reason: 'Altered record' }] });
  assert.equal(altered.response.status, 409);
  const replay = await sync(2, high, undefined, { clientId: 'another-client-2', decisions: [decision] });
  assert.equal(replay.response.status, 409);
  assert.equal(sqlite.prepare('SELECT type FROM stations WHERE barangay=?').get('641').type, 'normal');
  assert.equal(sqlite.prepare('SELECT count(*) count FROM operator_decisions').get().count, 1);
  assert.equal(sqlite.prepare('SELECT count(*) count FROM desktop_clients').get().count, 1);
  assert.equal(sqlite.prepare('SELECT reason FROM operator_decisions').get().reason, decision.reason);
});

test('mode changes archive the old incident and keep live and simulation alerts distinct', async () => {
  const { sync, stations, sqlite, login, call } = setup();
  const live = stations.map((station, index) => index ? { ...station, mode: 'live' } : {
    ...station, mode: 'live', source: 'ESP32 potentiometer water simulation', type: 'alert', level: 17,
  });
  await sync(1, live);
  const oldId = sqlite.prepare('SELECT id FROM alerts WHERE active=1').get().id;
  // Existing deployments can have an active, pre-migration row without mode.
  sqlite.prepare('UPDATE alerts SET mode=NULL WHERE id=?').run(oldId);
  const simulated = live.map((station) => ({ ...station, mode: 'simulation', source: 'Synthetic map demonstration' }));
  await sync(2, simulated);
  let old = sqlite.prepare('SELECT * FROM alerts WHERE id=?').get(oldId);
  assert.equal(old.active, 0);
  assert.equal(old.resolution, 'mode_changed');
  let active = sqlite.prepare('SELECT * FROM alerts WHERE active=1').get();
  assert.notEqual(active.id, oldId);
  assert.equal(active.mode, 'simulation');
  const lowSimulated = simulated.map((station) => ({ ...station, type: 'normal', level: 4 }));
  await sync(3, lowSimulated);
  assert.equal(sqlite.prepare('SELECT resolution FROM alerts WHERE id=?').get(active.id).resolution, 'recovered');
  await sync(4, live);
  await sync(3, lowSimulated);
  active = sqlite.prepare('SELECT * FROM alerts WHERE active=1').get();
  assert.equal(active.mode, 'live');
  assert.equal(sqlite.prepare('SELECT count(*) count FROM alerts WHERE active=1').get().count, 1);
  const dashboard = (await call('/api/dashboard', { headers: await login('641') })).data;
  assert.equal(dashboard.station.mode, 'live');
  old = dashboard.alerts.find((alert) => alert.id === oldId);
  assert.equal(old.mode, 'live');
  assert.equal(old.resolution, 'mode_changed');
});

test('legacy decision payloads replay unchanged and retain unknown mode after upgrade', async () => {
  const { sync, stations, sqlite, login, call } = setup();
  const legacy = operatorDecision();
  const payload = JSON.stringify(legacy);
  sqlite.prepare(`INSERT INTO operator_decisions
    (id, client_id, created_at, received_at, barangay, school, source_id, decision, reason, status, quality, campus_exposure, route_exposure, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(legacy.id, 'test-client-1', legacy.createdAt, legacy.createdAt, legacy.barangay, legacy.school,
      legacy.sourceId, legacy.decision, legacy.reason, legacy.status, legacy.quality,
      legacy.campusExposure, legacy.routeExposure, payload);
  const retry = await sync(1, stations, undefined, { decisions: [legacy] });
  assert.equal(retry.response.status, 200);
  assert.deepEqual(retry.data.acceptedDecisionIds, [legacy.id]);
  const stored = sqlite.prepare('SELECT payload, mode FROM operator_decisions WHERE id=?').get(legacy.id);
  assert.equal(stored.payload, payload);
  assert.equal(stored.mode, null);
  const current = operatorDecision({ mode: 'live' });
  await sync(2, stations, undefined, { decisions: [current] });
  const dashboard = (await call('/api/dashboard', { headers: await login('641') })).data;
  assert.equal(dashboard.decisions.find((decision) => decision.id === legacy.id).mode, null);
  assert.equal(dashboard.decisions.find((decision) => decision.id === current.id).mode, 'live');
  const relabel = await sync(3, stations, undefined, { decisions: [{ ...legacy, mode: 'simulation' }] });
  assert.equal(relabel.response.status, 409);
});

function firmwareStation(station, overrides = {}) {
  return {
    ...station, sourceId: 'A', mode: 'live', schema: 'bantay-bench-2', sourceKind: 'ultrasonic',
    source: 'ESP32 ultrasonic water / DHT11 room air / two-joystick rain proxy',
    packetQuality: 'valid', type: 'unknown', label: 'Water input unavailable',
    reason: 'Measure and set the sensor-to-bottom reference.', quality: 'invalid',
    level: null, distanceCm: 14.2, waterCalibrated: false, temp: 30.8, humidity: 61,
    rainAvgIndex: 0, rainPeakIndex: 83.5,
    joystick: { joy1X: 2048, joy1Y: 2150, joy2X: 3210, joy2Y: 1800 }, ...overrides,
  };
}

test('v2 uncalibrated water preserves independent air and rain data for the single CEU account', async () => {
  const { sync, stations, call, login } = setup();
  stations[0] = firmwareStation(stations[0], { adc: 4095 });
  assert.equal((await sync(1)).response.status, 200);
  const a = (await call('/api/dashboard', { headers: await login('641') })).data;
  assert.equal(a.station.level, null, 'legacy ADC cannot supply water in a v2 packet');
  assert.equal(a.station.waterCalibrated, false);
  assert.equal(a.station.distanceCm, 14.2);
  assert.equal(a.station.temp, 30.8);
  assert.equal(a.station.humidity, 61);
  assert.equal(a.station.rainAvgIndex, 0);
  assert.equal(a.station.rainPeakIndex, 83.5);
  assert.equal(a.station.packetQuality, 'valid');
  assert.deepEqual(a.station.joystick, stations[0].joystick);
  const b = (await call('/api/dashboard', { headers: await login('638') })).data;
  assert.equal(b.station.rainAvgIndex, null);
  assert.equal(b.station.joystick, null);
  const c = (await call('/api/dashboard', { headers: await login('404') })).data;
  assert.equal(c.station.rainPeakIndex, null);
  assert.equal(c.station.schema, null);
  stations[0] = { ...stations[1], barangay: '641', sourceId: 'A' };
  await sync(2);
  const legacy = (await call('/api/dashboard', { headers: await login('641') })).data.station;
  assert.equal(legacy.level, 4);
  assert.equal(legacy.schema, null);
  assert.equal(legacy.rainPeakIndex, null, 'switching to a legacy source clears the previous joystick window');
  assert.equal(legacy.joystick, null);
});

test('v2 allows calibrated filter warmup and retains alerts through a missing packet until valid recovery', async () => {
  const { sync, stations, call, login } = setup();
  stations[0] = firmwareStation(stations[0], { quality: 'startup', waterCalibrated: true });
  assert.equal((await sync(1)).response.status, 200);
  stations[0] = { ...stations[0], quality: 'valid', type: 'alert', label: 'Tank water alert', level: 17, distanceCm: 8.1 };
  await sync(2);
  stations[0] = { ...stations[0], quality: 'stale', packetQuality: 'stale', level: null, distanceCm: null,
    waterCalibrated: false, temp: null, humidity: null, rainAvgIndex: null, rainPeakIndex: null, joystick: null };
  await sync(3);
  const headers = await login('641');
  let dashboard = (await call('/api/dashboard', { headers })).data;
  assert.equal(dashboard.alerts[0].active, true);
  assert.equal(dashboard.station.rainPeakIndex, null);
  stations[0] = firmwareStation(stations[0], { quality: 'valid', waterCalibrated: true, level: 4, type: 'normal', label: 'MONITOR' });
  await sync(4);
  dashboard = (await call('/api/dashboard', { headers })).data;
  assert.equal(dashboard.alerts[0].active, false);
  assert.equal(dashboard.station.level, 4);
});

test('v2 rejects inconsistent water, rain, joystick and duplicated station ownership without partial writes', async () => {
  const { sync, stations, sqlite } = setup();
  await sync(1);
  for (const invalid of [
    { level: 7, waterCalibrated: false }, { waterCalibrated: true, distanceCm: null },
    { waterCalibrated: 'yes' }, { sourceKind: 'potentiometer' }, { sourceId: 'B' },
    { rainAvgIndex: -1 }, { rainPeakIndex: 101 }, { rainAvgIndex: 60, rainPeakIndex: 20 },
    { rainAvgIndex: '12' }, { joystick: { joy1X: 2048 } },
    { joystick: { joy1X: 2048, joy1Y: 0, joy2X: 4096, joy2Y: 0 } },
  ]) {
    const values = stations.map((station, index) => index ? station : firmwareStation(station, invalid));
    assert.equal((await sync(2, values)).response.status, 400);
  }
  const duplicate = stations.map((station, index) => index === 1 ? firmwareStation(station) : station);
  assert.equal((await sync(2, duplicate)).response.status, 400);
  assert.equal(sqlite.prepare('SELECT sequence FROM desktop_clients').get().sequence, 1);
  assert.equal(sqlite.prepare('SELECT protocol_schema FROM stations WHERE barangay=?').get('641').protocol_schema, null);
});

test('.dev.vars credentials sign in with barangay name as username and password', async () => {
  const varsFile = new URL('../.dev.vars', import.meta.url);
  let raw;
  try { raw = readFileSync(varsFile, 'utf8'); } catch { return; }
  const env = Object.fromEntries(raw.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => {
    const eq = line.indexOf('=');
    let value = line.slice(eq + 1);
    if ((value[0] === "'" || value[0] === '"') && value.endsWith(value[0])) value = value.slice(1, -1);
    return [line.slice(0, eq), value];
  }));
  const accounts = JSON.parse(env.ACCOUNT_CREDENTIALS_JSON);
  const { call } = setup({ ACCOUNT_CREDENTIALS_JSON: env.ACCOUNT_CREDENTIALS_JSON,
    SESSION_SECRET: env.SESSION_SECRET, DESKTOP_TOKEN: env.DESKTOP_TOKEN });
  for (const barangay of ['641', '638', '404']) {
    const account = accounts.find((item) => item.barangay === barangay);
    assert.ok(account, `account for barangay ${barangay} exists`);
    const { response: bad, data: badData } = await call('/api/login', { method: 'POST', body: { username: barangay, password: 'wrong' } });
    assert.equal(bad.status, 401, `wrong password rejected for ${barangay}: ${JSON.stringify(badData)}`);
    const { response, data } = await call('/api/login', { method: 'POST', body: { username: barangay, password: barangay } });
    assert.equal(response.status, 200, `barangay-name password accepted for ${barangay}: ${JSON.stringify(data)}`);
    assert.equal(data.user.username, account.username);
  }
});

test('heat review can reach the remote desk while calibrated water is warming up', async () => {
  const { sync, stations, call, login } = setup();
  stations[0] = firmwareStation(stations[0], {
    quality: 'startup', waterCalibrated: true, type: 'watch', label: 'HEAT REVIEW',
    reason: 'Valid DHT11 air readings cross the heat review threshold.', temp: 38, humidity: 75,
  });
  await sync(1);
  const dashboard = (await call('/api/dashboard', { headers: await login('641') })).data;
  assert.equal(dashboard.alerts.length, 1);
  assert.equal(dashboard.alerts[0].label, 'HEAT REVIEW');
  assert.equal(dashboard.station.level, null);
  assert.equal(dashboard.station.rainAvgIndex, 0);
});
