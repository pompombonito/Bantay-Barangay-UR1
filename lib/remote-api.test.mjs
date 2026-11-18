import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRemoteApi, hashPassword } from './remote-api.mjs';

const sql = readFileSync(new URL('../drizzle/0000_slim_corsair.sql', import.meta.url), 'utf8');
const users = await Promise.all(['641', '638', '404'].map(async (barangay) => ({
  username: `barangay${barangay}`, barangay, name: `Barangay ${barangay}`,
  salt: '11111111111111111111111111111111',
  passwordHash: await hashPassword(`testing-${barangay}`, '11111111111111111111111111111111'),
})));

function setup() {
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
    DESKTOP_TOKEN: 'desktop-secret-1234567890123456789012345', ACCOUNT_CREDENTIALS_JSON: JSON.stringify(users) };
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
  const sync = (sequence, values = stations, token = env.DESKTOP_TOKEN) => call('/api/desktop/sync', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: { clientId: 'test-client-1', sequence, stations: values },
  });
  return { sqlite, env, call, login, stations, sync };
}

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
