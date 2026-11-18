const BARANGAYS = ['641', '638', '404'];
const SESSION_SECONDS = 12 * 60 * 60;
const COOKIE = 'bantay_session';
const encoder = new TextEncoder();
const hex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
const unhex = (text) => Uint8Array.from(text.match(/../g) ?? [], (part) => parseInt(part, 16));
const base64 = (text) => btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode64 = (text) => atob(text.replaceAll('-', '+').replaceAll('_', '/'));
const json = (data, status = 200, headers = {}) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});

function credentials(env) {
  const users = JSON.parse(env.ACCOUNT_CREDENTIALS_JSON ?? '[]');
  if (!Array.isArray(users) || users.length !== 3 ||
    new Set(users.map((user) => user.barangay)).size !== 3 ||
    new Set(users.map((user) => user.username)).size !== 3 ||
    users.some((user) => !BARANGAYS.includes(user.barangay) ||
      !/^[a-z0-9_-]{3,64}$/.test(user.username) ||
      typeof user.name !== 'string' || !/^[a-f0-9]{32}$/.test(user.salt) ||
      !/^[a-f0-9]{64}$/.test(user.passwordHash))) throw new Error('Accounts unavailable');
  return users;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function equal(left, right) {
  let difference = left.length ^ right.length;
  for (let n = 0; n < Math.max(left.length, right.length); n++)
    difference |= (left.charCodeAt(n) || 0) ^ (right.charCodeAt(n) || 0);
  return difference === 0;
}

export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: 100000 }, key, 256));
}

const publicUser = (user) => ({ username: user.username, barangay: user.barangay, name: user.name });

async function session(request, env) {
  const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  if (!cookie || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return null;
  try {
    const [body, signature] = cookie.slice(COOKIE.length + 1).split('.');
    if (!signature || !equal(await hmac(env.SESSION_SECRET, body), signature)) return null;
    const claims = JSON.parse(decode64(body));
    if (claims.expires < Date.now() / 1000) return null;
    const user = credentials(env).find((item) => item.username === claims.username);
    if (!user || !equal(claims.version, await hmac(env.SESSION_SECRET, user.passwordHash))) return null;
    return publicUser(user);
  } catch { return null; }
}

function cookieHeader(request, value, age) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON');
  const text = await request.text();
  if (text.length > 32000) throw new Error('Request too large');
  return JSON.parse(text);
}

function validateStation(value) {
  if (!value || !BARANGAYS.includes(value.barangay) ||
    !['normal', 'watch', 'alert', 'unknown'].includes(value.type) ||
    !['valid', 'startup', 'invalid', 'stale', 'unknown'].includes(value.quality)) return false;
  for (const key of ['sourceId', 'label', 'reason', 'source'])
    if (typeof value[key] !== 'string' || value[key].length > 2000 || !value[key].length) return false;
  for (const key of ['level', 'temp', 'humidity'])
    if (value[key] !== null && (!Number.isFinite(value[key]) || Math.abs(value[key]) > 10000)) return false;
  return true;
}

async function sync(request, env) {
  const authorization = request.headers.get('authorization') ?? '';
  if (!env.DESKTOP_TOKEN || env.DESKTOP_TOKEN.length < 32 || !equal(authorization, `Bearer ${env.DESKTOP_TOKEN}`))
    return json({ error: 'Desktop authentication required' }, 401);
  const input = await body(request);
  if (!input || typeof input.clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.clientId) ||
    !Number.isSafeInteger(input.sequence) || input.sequence < 0 ||
    !Array.isArray(input.stations) || input.stations.length !== 3 ||
    !input.stations.every(validateStation) ||
    new Set(input.stations.map((station) => station.barangay)).size !== 3) return json({ error: 'Invalid station snapshot' }, 400);
  const now = new Date().toISOString();
  const statements = [env.DB.prepare('INSERT OR IGNORE INTO desktop_clients (id, sequence, updated_at) VALUES (?, -1, ?)').bind(input.clientId, now)];
  const gate = 'EXISTS (SELECT 1 FROM desktop_clients WHERE id = ? AND sequence < ?)';
  const gateValues = [input.clientId, input.sequence];
  for (const station of input.stations) {
    statements.push(env.DB.prepare(`INSERT INTO stations (barangay, source_id, client_id, label, type, reason, level, temp, humidity, quality, source, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}
      ON CONFLICT(barangay) DO UPDATE SET source_id=excluded.source_id, client_id=excluded.client_id, label=excluded.label, type=excluded.type, reason=excluded.reason,
      level=excluded.level, temp=excluded.temp, humidity=excluded.humidity, quality=excluded.quality, source=excluded.source, updated_at=excluded.updated_at`)
      .bind(station.barangay, station.sourceId, input.clientId, station.label, station.type, station.reason,
        station.level, station.temp, station.humidity, station.quality, station.source, now, ...gateValues));
    if (station.type === 'normal' && station.quality === 'valid') {
      statements.push(env.DB.prepare(`UPDATE alerts SET active=0, resolved_at=? WHERE barangay=? AND active=1 AND ${gate}`)
        .bind(now, station.barangay, ...gateValues));
    } else if (station.quality !== 'startup') {
      statements.push(env.DB.prepare(`UPDATE alerts SET label=?, type=?, reason=?, source=?, source_id=? WHERE barangay=? AND active=1 AND ${gate}`)
        .bind(station.label, station.type, station.reason, station.source, station.sourceId, station.barangay, ...gateValues));
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO alerts (id, barangay, source_id, label, type, reason, source, active, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 1, ? WHERE ${gate}`)
        .bind(crypto.randomUUID(), station.barangay, station.sourceId, station.label, station.type, station.reason, station.source, now, ...gateValues));
    }
  }
  statements.push(env.DB.prepare('UPDATE desktop_clients SET sequence=?, updated_at=? WHERE id=? AND sequence<?').bind(input.sequence, now, input.clientId, input.sequence));
  await env.DB.batch(statements);
  const responses = await env.DB.prepare(`SELECT r.*, a.label, a.active FROM responses r JOIN alerts a ON a.id=r.alert_id ORDER BY r.created_at DESC, r.id DESC LIMIT 100`).all();
  return json({ syncedAt: now, responses: responses.results.map(responseRecord) });
}

function stationRecord(row) {
  if (!row) return null;
  return { barangay: row.barangay, sourceId: row.source_id, label: row.label, type: row.type,
    reason: row.reason, level: row.level, temp: row.temp, humidity: row.humidity,
    quality: row.quality, source: row.source, updatedAt: row.updated_at };
}

function responseRecord(row) {
  return { id: row.id, alertId: row.alert_id, barangay: row.barangay, username: row.username,
    decision: row.decision, note: row.note, createdAt: row.created_at,
    ...(row.label ? { label: row.label, active: Boolean(row.active) } : {}) };
}

async function dashboard(user, env) {
  const [station, records, responses] = await Promise.all([
    env.DB.prepare('SELECT * FROM stations WHERE barangay=?').bind(user.barangay).first(),
    env.DB.prepare('SELECT * FROM alerts WHERE barangay=? ORDER BY created_at DESC, id DESC LIMIT 50').bind(user.barangay).all(),
    env.DB.prepare('SELECT * FROM responses WHERE barangay=? ORDER BY created_at DESC, id DESC LIMIT 200').bind(user.barangay).all(),
  ]);
  return json({ user, station: stationRecord(station),
    alerts: records.results.map((row) => ({ id: row.id, barangay: row.barangay, sourceId: row.source_id,
      label: row.label, type: row.type, reason: row.reason, source: row.source, active: Boolean(row.active),
      createdAt: row.created_at, resolvedAt: row.resolved_at,
      response: responses.results.find((item) => item.alert_id === row.id) ? responseRecord(responses.results.find((item) => item.alert_id === row.id)) : null,
    })),
    connection: { online: Boolean(station && Date.now() - Date.parse(station.updated_at) < 15000), lastSeen: station?.updated_at ?? null },
  });
}

async function respond(request, env, user, id) {
  const input = await body(request);
  if (!input || !['acknowledge', 'verify', 'escalate'].includes(input.decision) ||
    typeof input.note !== 'string' || input.note.length > 1000 ||
    (input.requestId && !/^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId))) return json({ error: 'Invalid response' }, 400);
  const alert = await env.DB.prepare('SELECT * FROM alerts WHERE id=? AND barangay=?').bind(id, user.barangay).first();
  if (!alert) return json({ error: 'Alert not found' }, 404);
  const responseId = input.requestId ?? crypto.randomUUID();
  const previous = await env.DB.prepare('SELECT * FROM responses WHERE id=?').bind(responseId).first();
  if (previous) {
    if (previous.alert_id !== id || previous.username !== user.username) return json({ error: 'Response identifier already used' }, 409);
    return json({ response: responseRecord(previous) });
  }
  if (!alert.active) return json({ error: 'This alert has already recovered. Refresh to see the latest status.' }, 409);
  await env.DB.prepare(`INSERT OR IGNORE INTO responses (id, alert_id, barangay, username, decision, note, created_at)
    SELECT ?, id, barangay, ?, ?, ?, ? FROM alerts WHERE id=? AND barangay=? AND active=1`)
    .bind(responseId, user.username, input.decision, input.note.trim(), new Date().toISOString(), id, user.barangay).run();
  const saved = await env.DB.prepare('SELECT * FROM responses WHERE id=? AND alert_id=? AND username=?').bind(responseId, id, user.username).first();
  if (!saved) return json({ error: 'Alert recovered while responding. Refresh to see the latest status.' }, 409);
  return json({ response: responseRecord(saved) });
}

export async function handleRemoteApi(request, env) {
  try {
    if (!env.DB || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return json({ error: 'Remote desk is awaiting secure configuration.' }, 503);
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (request.method === 'POST' && url.pathname !== '/api/desktop/sync' && origin && origin !== url.origin)
      return json({ error: 'Cross-origin request denied' }, 403);
    if (url.pathname === '/api/desktop/sync' && request.method === 'POST') return await sync(request, env);
    if (url.pathname === '/api/login' && request.method === 'POST') {
      const input = await body(request);
      if (!input || typeof input.username !== 'string' || typeof input.password !== 'string' || input.password.length > 256)
        return json({ error: 'Enter your username and password.' }, 400);
      const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
      const ip = request.headers.get('cf-connecting-ip') ?? 'local';
      const rateKey = await hmac(env.SESSION_SECRET, `${ip}:${bucket}`);
      await env.DB.prepare(`INSERT INTO login_attempts (key, count, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET count=count+1`).bind(rateKey, (bucket + 1) * 15 * 60 * 1000).run();
      const attempt = await env.DB.prepare('SELECT count FROM login_attempts WHERE key=?').bind(rateKey).first();
      if (attempt.count > 30) return json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }, 429);
      const user = credentials(env).find((item) => item.username === input.username.toLowerCase().trim());
      const hash = await hashPassword(input.password, user?.salt ?? '00000000000000000000000000000000');
      if (!user || !equal(user.passwordHash, hash)) return json({ error: 'Username or password is incorrect.' }, 401);
      const payload = base64(JSON.stringify({ username: user.username, expires: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
        version: await hmac(env.SESSION_SECRET, user.passwordHash) }));
      const value = `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
      await env.DB.prepare('DELETE FROM login_attempts WHERE expires_at<?').bind(Date.now()).run();
      return json({ user: publicUser(user) }, 200, { 'Set-Cookie': cookieHeader(request, value, SESSION_SECONDS) });
    }
    if (url.pathname === '/api/logout' && request.method === 'POST')
      return json({ signedOut: true }, 200, { 'Set-Cookie': cookieHeader(request, '', 0) });
    const user = await session(request, env);
    if (!user) return json({ error: 'Sign in to your assigned barangay account.' }, 401);
    if (url.pathname === '/api/session' && request.method === 'GET') return json({ user });
    if (url.pathname === '/api/dashboard' && request.method === 'GET') return await dashboard(user, env);
    const match = url.pathname.match(/^\/api\/alerts\/([a-zA-Z0-9_-]+)\/respond$/);
    if (match && request.method === 'POST') return await respond(request, env, user, match[1]);
    return json({ error: 'Endpoint not found' }, 404);
  } catch (error) {
    if (error instanceof SyntaxError || error.message === 'Expected JSON' || error.message === 'Request too large')
      return json({ error: error.message === 'Request too large' ? error.message : 'Invalid JSON request' }, 400);
    console.error('Remote API failure:', error.message);
    return json({ error: 'The remote desk could not complete this request. Try again shortly.' }, 503);
  }
}
