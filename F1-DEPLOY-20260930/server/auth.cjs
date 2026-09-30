'use strict';
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, createHash, createHmac, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { readFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const derive = promisify(scrypt);
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicUser = row => ({ id: row.id, nickname: row.nickname });

function createAuthServer({ dbPath, pepper, origin, production = false,
  htmlPath = path.resolve(__dirname, '../outputs/index.html'), now = Date.now }) {
  if (typeof pepper !== 'string' || pepper.length < 32) throw Error('AUTH_PEPPER must contain at least 32 random characters.');
  const site = new URL(origin);
  if (site.origin !== origin || (production && site.protocol !== 'https:')) throw Error('APP_ORIGIN must be an exact origin, HTTPS in production.');
  if (dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name_key TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL,
      salt TEXT NOT NULL, pin_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const cookieName = production ? '__Host-apex_session' : 'apex_session';
  const circuitIds=['monza','silverstone','monaco'];
  db.exec(`CREATE TABLE IF NOT EXISTS time_runs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),circuit TEXT NOT NULL,started INTEGER NOT NULL,finished INTEGER);
    CREATE TABLE IF NOT EXISTS time_bests(circuit TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),time_ms INTEGER NOT NULL,achieved INTEGER NOT NULL,PRIMARY KEY(circuit,user_id));`);
  function leaders(){return Object.fromEntries(circuitIds.map(c=>[c,db.prepare('SELECT u.nickname,b.time_ms AS timeMs FROM time_bests b JOIN users u ON u.id=b.user_id WHERE b.circuit=? ORDER BY b.time_ms,b.achieved,b.user_id LIMIT 1').get(c)||null]));}
  const hashSecret = value => createHmac('sha256', pepper).update(value).digest('hex');
  let hashesInFlight = 0;
  async function pinHash(pin, salt) {
    if (hashesInFlight >= 4) throw fail(503, '접속이 몰리고 있어요. 잠시 후 다시 시도해 주세요.');
    hashesInFlight++;
    try { return (await derive(hashSecret(pin), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex'); }
    finally { hashesInFlight--; }
  }
  const equals = (a, b) => timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
  function nickname(value) {
    if (typeof value !== 'string') throw fail(400, '닉네임을 입력해 주세요.');
    const name = value.normalize('NFKC').trim();
    if (!/^[\p{L}\p{N}_-]{2,14}$/u.test(name)) throw fail(400, '닉네임은 2~14자, 한글·영문·숫자·밑줄·하이픈만 사용할 수 있어요.');
    return { name, key: name.toLowerCase() };
  }
  function pin(value) {
    if (typeof value !== 'string' || !/^\d{6}$/.test(value)) throw fail(400, 'PIN은 숫자 6자리로 입력해 주세요.');
    return value;
  }
  const sessionToken = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
  function currentUser(req) {
    const token = sessionToken(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(sha(token), now()) || null;
  }
  function cookie(res, token, maxAge) {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax${production ? '; Secure' : ''}${maxAge === undefined ? '' : '; Max-Age=' + maxAge}`);
  }
  function session(req, res, user, remember) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(sessionToken(req)));
    const token = randomBytes(32).toString('hex'), seconds = remember ? 30 * 86400 : 12 * 3600;
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), user.id, now() + seconds * 1000);
    cookie(res, token, remember ? seconds : undefined);
  }
  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'JSON 요청이 필요합니다.');
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw fail(413, '요청이 너무 큽니다.');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      return value;
    } catch { throw fail(400, '올바르지 않은 요청입니다.'); }
  }
  const rooms = require('./rooms.cjs')({currentUser,body,send,origin,now});
  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, origin);
      if(await rooms(req,res,url))return;
      if (url.pathname === '/healthz') { send(res, 200, { status: 'ok' }); return; }
      if(url.pathname.startsWith('/api/time-trial/')){
        const action=url.pathname.slice('/api/time-trial/'.length);
        if(action==='leaders'&&req.method==='GET'){send(res,200,{leaders:leaders(),laps:1});return;}
        if(req.method!=='POST')throw fail(405,'허용하지 않는 요청입니다.');
        if(req.headers.origin!==origin)throw fail(403,'다른 사이트에서 보낸 요청은 허용하지 않습니다.');
        const user=currentUser(req);if(!user)throw fail(401,'기록 저장을 위해 로그인해 주세요.');
        const data=await body(req);
        db.prepare('DELETE FROM time_runs WHERE started<?').run(now()-86400000);
        if(action==='start'){
          if(!circuitIds.includes(data.circuit))throw fail(400,'올바르지 않은 서킷입니다.');
          const id=randomBytes(24).toString('hex');
          db.prepare('INSERT INTO time_runs VALUES(?,?,?,?,NULL)').run(id,user.id,data.circuit,now());
          send(res,201,{runId:id});return;
        }
        if(action==='finish'){
          if(typeof data.runId!=='string'||!Number.isSafeInteger(data.timeMs)||data.timeMs<1000||data.timeMs>86400000)throw fail(400,'올바르지 않은 기록입니다.');
          const run=db.prepare('SELECT * FROM time_runs WHERE id=? AND user_id=?').get(data.runId,user.id);
          if(!run)throw fail(400,'레이스 등록이 없거나 만료되었습니다.');
          if(run.finished!==null&&run.finished!==data.timeMs)throw fail(409,'이미 제출한 레이스입니다.');
          if(data.timeMs>now()-run.started+1000)throw fail(400,'레이스 경과 시간과 기록이 일치하지 않습니다.');
          if(run.finished===null){
            db.exec('BEGIN IMMEDIATE');
            try{
              db.prepare('UPDATE time_runs SET finished=? WHERE id=?').run(data.timeMs,run.id);
              db.prepare(`INSERT INTO time_bests VALUES(?,?,?,?) ON CONFLICT(circuit,user_id) DO UPDATE SET time_ms=excluded.time_ms,achieved=excluded.achieved WHERE excluded.time_ms<time_bests.time_ms`).run(run.circuit,user.id,data.timeMs,now());
              db.exec('COMMIT');
            }catch(error){db.exec('ROLLBACK');throw error;}
          }
          send(res,200,{leaders:leaders()});return;
        }
        throw fail(404,'찾을 수 없습니다.');
      }
      if (!url.pathname.startsWith('/api/auth/')) {
        // Explicit allowlist: never serve the database, source, secrets or backups.
        if (req.method === 'GET' && ['/', '/index.html', '/outputs/index.html'].includes(url.pathname)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(readFileSync(htmlPath)); return;
        }
        throw fail(404, '찾을 수 없습니다.');
      }
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(now());
      const action = url.pathname.slice('/api/auth/'.length);
      if (action === 'me' && req.method === 'GET') { const u = currentUser(req); send(res, 200, { user: u ? publicUser(u) : null }); return; }
      if (req.method !== 'POST') throw fail(405, '허용하지 않는 요청입니다.');
      // No CORS credentials. All mutations require the exact public website origin.
      if (req.headers.origin !== origin) throw fail(403, '다른 사이트에서 보낸 요청은 허용하지 않습니다.');
      if (!['register', 'login', 'logout'].includes(action)) throw fail(404, '찾을 수 없습니다.');
      const data = await body(req);
      if (action === 'logout') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(sessionToken(req)));
        cookie(res, '', 0); send(res, 200, { user: null }); return;
      }
      const { name, key } = nickname(data.nickname);
      const existing = db.prepare('SELECT * FROM users WHERE name_key=?').get(key);
      if (action === 'register') {
        pin(data.pin);
        if (existing) throw fail(409, '이미 사용 중인 닉네임입니다.');
        const user = { id: randomBytes(16).toString('hex'), nickname: name };
        const salt = randomBytes(16).toString('hex'), hash = await pinHash(data.pin, salt);
        // Keep the legacy schema to preserve existing accounts. Recovery is no longer exposed.
        try { db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(user.id, key, name, salt, hash, '', now()); }
        catch (error) { if (String(error.message).includes('UNIQUE')) throw fail(409, '이미 사용 중인 닉네임입니다.'); throw error; }
        session(req, res, user, data.remember === true);
        send(res, 201, { user }); return;
      }
      if (action === 'login') {
        pin(data.pin);
        const hash = await pinHash(data.pin, existing?.salt || '00000000000000000000000000000000');
        if (!existing || !equals(hash, existing.pin_hash)) throw fail(401, '닉네임 또는 PIN이 올바르지 않습니다.');
        // Do not mint a session if the account changed during async hashing.
        const fresh = db.prepare('SELECT * FROM users WHERE id=? AND pin_hash=?').get(existing.id, existing.pin_hash);
        if (!fresh) throw fail(401, 'PIN이 변경되었습니다. 다시 로그인해 주세요.');
        session(req, res, fresh, data.remember === true);
        send(res, 200, { user: publicUser(fresh) }); return;
      }
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      // Never log request bodies, PINs or cookies.
      if (!error.status) console.error('Account service error:', error.code || error.name);
      send(res, error.status || 500, { error: error.status ? error.message : '서버 오류입니다. 잠시 후 다시 시도해 주세요.' });
    }
  }
  const server = http.createServer(handler);
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('close', () => db.close());
  return server;
}
module.exports = { createAuthServer };
