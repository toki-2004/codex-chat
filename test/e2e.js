'use strict';
/* ---------------------------------------------------------------------------
 * Codex Chat offline end-to-end tests.
 *
 * Spawns a TEMP server instance (own port/data dir/config/server.pid) with a
 * stub codex CLI (test/codex-stub.js) via the CCX_CODEX_JS hook, then walks
 * the whole product surface without touching the production instance on 3100
 * and without consuming any real API quota:
 *   health/probe -> auth gates -> setup -> login -> socket auth -> users CRUD
 *   -> conversations -> chat turn (JSONL parse) -> command_execution process
 *   -> resume -> resume-failure fallback -> message truncation
 *   -> model-options / model-settings -> persistence -> delete + thread cleanup
 *
 * Run: npm test   (or: node test/e2e.js)
 * --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const io = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3170 + (process.pid % 80);
const BASE = 'http://127.0.0.1:' + PORT;

/* ---------------- tiny assert/runner ---------------- */
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else {
    console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : ''));
    failures.push(name);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function api(method, p, body, cookie) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-json */ }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, json, setCookies };
}
function cookieFrom(setCookies) {
  const c = (setCookies || []).find((x) => String(x).startsWith('cc_session='));
  return c ? c.split(';')[0] : null;
}

/* ---------------- environment ---------------- */
const tmp = path.join(ROOT, '_test_temp', 'run-' + Date.now());
const dataDir = path.join(tmp, 'data');
const codexHome = path.join(tmp, '.codex');
const stubPath = path.join(tmp, 'codex-stub.js');
const stubLog = path.join(tmp, 'stub.log');

function prepare() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(tmp, 'index.html'));
  fs.copyFileSync(path.join(__dirname, 'codex-stub.js'), stubPath);

  const catalog = path.join(tmp, 'catalog-base.json');
  fs.writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'stub-model' }] }));
  fs.writeFileSync(path.join(codexHome, 'config.toml'),
    'model = "stub-model"\nmodel_catalog_json = "' + catalog.replace(/\\/g, '/') + '"\n');
  const catalogFake = path.join(tmp, 'catalog-fake.json');
  fs.writeFileSync(catalogFake, JSON.stringify({ models: [{ slug: 'fake-model' }] }));
  fs.writeFileSync(path.join(codexHome, 'fakeprofile.config.toml'),
    'model = "fake-model"\nmodel_catalog_json = "' + catalogFake.replace(/\\/g, '/') + '"\n');

  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    port: PORT,
    host: '127.0.0.1',
    cwd: tmp,
    maxMessageLen: 40,
    maxHistory: 10,
    turnTimeoutMs: 20000,
    systemPrompt: 'SYS-MARKER cwd={cwd} home={codexHome}',
  }, null, 2));
}

function startServer() {
  const proc = spawn(process.execPath, [path.join(tmp, 'server.js')], {
    cwd: tmp,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      CCX_CODEX_JS: stubPath,
      CCX_STUB_LOG: stubLog,
      CODEX_HOME: codexHome,
    }),
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return proc;
}

async function waitHealthy() {
  let last = null;
  for (let i = 0; i < 75; i++) {
    try {
      const r = await api('GET', '/api/health');
      if (r.status === 200 && r.json && r.json.ok) {
        last = r.json;
        // codex 探测是异步的：等它就位，避免 S1 出现假失败
        if (r.json.codex && r.json.codex.ok === true) return r.json;
      }
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server not healthy (codex probe pending?): ' + JSON.stringify(last));
}

/* ---------------- socket helpers ---------------- */
function connectSocket(cookie) {
  return new Promise((resolve, reject) => {
    const sock = io(BASE, {
      extraHeaders: { cookie },
      autoConnect: false,
      reconnection: false,
      timeout: 5000,
    });
    const events = { 'chat-message': [], 'chat-process': [], 'codex-status': [], 'model-changed': [], welcome: [], members: [] };
    for (const key of Object.keys(events)) {
      sock.on(key, (payload) => events[key].push(payload));
    }
    sock.once('connect', () => resolve({ sock, events }));
    sock.once('connect_error', (err) => { try { sock.close(); } catch (e) {} reject(Object.assign(new Error('connect_error: ' + err.message), { code: 'CONNECT_ERROR' })); });
    sock.connect();
  });
}

function waitFor(arr, pred, label, ms) {
  const timeout = ms || 10000;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = arr.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout waiting for ' + label));
      setTimeout(tick, 40);
    };
    tick();
  });
}

const ack = (sock, event, payload) => new Promise((resolve) => sock.emit(event, payload, resolve));

/* ---------------- cleanup ---------------- */
function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode != null) return resolve();
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { try { proc.kill(); } catch (e2) {} }
    const t = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve(); }, 5000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

/* =========================================================================
 * Main
 * ========================================================================= */
(async () => {
  let server = null;
  let adminSock = null;
  try {
    prepare();
    server = startServer();
    const health = await waitHealthy();

    /* ---- S1 health & codex probe (stub) ---- */
    console.log('S1 health & codex probe');
    check('health ok', health.ok === true);
    check('health cwd = temp dir', health.cwd === path.resolve(tmp));
    check('zero conversations at start', health.conversations === 0);
    check('codex probe uses stub', health.codex && health.codex.ok === true && /0\.0\.0-test/.test(health.codex.version || ''), health.codex);

    /* ---- S2 auth gates ---- */
    console.log('S2 auth gates');
    for (const [m, p] of [['GET', '/api/config'], ['GET', '/api/messages'], ['GET', '/api/conversations'], ['POST', '/api/conversations'], ['GET', '/api/model-options']]) {
      const r = await api(m, p, m === 'POST' ? {} : undefined);
      check('401 without session: ' + m + ' ' + p, r.status === 401, r.status);
    }

    /* ---- S3 setup admin ---- */
    console.log('S3 setup admin');
    let r = await api('GET', '/api/me');
    check('needsSetup true initially', r.json && r.json.needsSetup === true);
    r = await api('POST', '/api/setup', { username: 'admin', password: '123' });
    check('weak password rejected', r.status === 400, r.status);
    r = await api('POST', '/api/setup', { username: 'x', password: 'secret123' });
    check('short username rejected', r.status === 400, r.status);
    r = await api('POST', '/api/setup', { username: 'admin', password: 'secret123', displayName: 'Boss' });
    check('setup ok', r.status === 200 && r.json && r.json.ok === true && r.json.user.role === 'admin', r.json);
    const adminCookie = cookieFrom(r.setCookies);
    check('setup sets cc_session cookie', !!adminCookie);
    r = await api('GET', '/api/me', undefined, adminCookie);
    check('me returns admin', r.json && r.json.user && r.json.user.username === 'admin', r.json);
    r = await api('POST', '/api/setup', { username: 'evil', password: 'secret123' });
    check('second setup rejected', r.status === 400, r.status);
    r = await api('POST', '/api/login', { username: 'admin', password: 'wrong-password' });
    check('wrong password 401', r.status === 401, r.status);
    r = await api('POST', '/api/login', { username: 'ADMIN', password: 'secret123' });
    check('login is case-insensitive on username', r.status === 200, r.status);

    /* ---- S4 socket auth ---- */
    console.log('S4 socket auth');
    let gotConnectError = null;
    try { await connectSocket('cc_session=bogus-token'); } catch (e) { gotConnectError = e.message; }
    check('bogus cookie socket rejected', gotConnectError === 'connect_error: unauthorized', gotConnectError);
    const admin = await connectSocket(adminCookie);
    adminSock = admin.sock;
    const welcome = await waitFor(admin.events.welcome, () => true, 'welcome', 3000);
    check('welcome carries cwd', welcome.config && welcome.config.cwd === path.resolve(tmp), welcome.config);
    check('welcome carries maxMessageLen 40', welcome.config && welcome.config.maxMessageLen === 40);
    const members1 = await waitFor(admin.events.members, (m) => m.some((x) => x.name === 'Boss'), 'members(self)', 3000);
    check('members includes self', !!members1);
    const setColor = await ack(adminSock, 'set-user', { color: '#123456' });
    check('set-user ack ok', setColor && setColor.ok === true, setColor);

    /* ---- S5 user management ---- */
    console.log('S5 user management');
    r = await api('POST', '/api/users', { username: 'alice', password: 'alice123' }, adminCookie);
    check('admin creates user', r.status === 200 && r.json.user.role === 'user', r.json);
    const aliceId = r.json && r.json.user && r.json.user.id;
    r = await api('POST', '/api/users', { username: 'alice', password: 'alice123' }, adminCookie);
    check('duplicate username rejected', r.status === 400, r.status);
    r = await api('POST', '/api/login', { username: 'alice', password: 'alice123' });
    const aliceCookie = cookieFrom(r.setCookies);
    check('alice can login', r.status === 200 && !!aliceCookie);
    r = await api('GET', '/api/users', undefined, aliceCookie);
    check('normal user blocked from user list', r.status === 403, r.status);
    r = await api('POST', '/api/users', { username: 'mallory', password: 'mallory123' }, aliceCookie);
    check('normal user cannot create users', r.status === 403, r.status);
    r = await api('PATCH', '/api/users/' + aliceId, { password: 'newpass99', currentPassword: 'WRONG' }, aliceCookie);
    check('self password change requires correct current', r.status === 403, r.status);
    r = await api('PATCH', '/api/users/' + aliceId, { password: 'newpass99', currentPassword: 'alice123' }, aliceCookie);
    check('self password change ok', r.status === 200, r.json);
    r = await api('POST', '/api/login', { username: 'alice', password: 'newpass99' });
    check('login with new password', r.status === 200, r.status);
    r = await api('GET', '/api/users', undefined, adminCookie);
    check('user list shows both', r.status === 200 && Array.isArray(r.json) && r.json.length === 2, r.json);
    r = await api('DELETE', '/api/users/' + aliceId, undefined, adminCookie);
    check('admin deletes user', r.status === 200, r.status);
    r = await api('GET', '/api/config', undefined, aliceCookie);
    check('deleted user session revoked', r.status === 401, r.status);
    const meAdmin = await api('GET', '/api/me', undefined, adminCookie);
    const adminId = meAdmin.json && meAdmin.json.user && meAdmin.json.user.userId;
    check('me exposes userId', !!adminId, meAdmin.json);
    r = await api('DELETE', '/api/users/' + adminId, undefined, adminCookie);
    check('admin cannot delete self', r.status === 400, r.status);

    /* ---- S6 conversations ---- */
    console.log('S6 conversations');
    r = await api('POST', '/api/conversations', {}, adminCookie);
    const conv1 = r.json && r.json.conversation;
    check('create conversation 1', r.status === 200 && conv1 && conv1.id, r.json);
    r = await api('POST', '/api/conversations', {}, adminCookie);
    const conv2 = r.json && r.json.conversation;
    check('create conversation 2 becomes active', r.status === 200 && conv2 && conv2.id !== conv1.id);
    r = await api('GET', '/api/conversations/' + conv1.id, undefined, adminCookie);
    check('switch back to conversation 1', r.status === 200 && r.json.conversation.id === conv1.id);
    r = await api('GET', '/api/conversations', undefined, adminCookie);
    check('list activeId = conv1', r.json && r.json.activeId === conv1.id, r.json);
    r = await api('GET', '/api/conversations/does-not-exist', undefined, adminCookie);
    check('unknown conversation 404', r.status === 404, r.status);

    /* ---- S7 chat turn: JSONL parse + persistence ---- */
    console.log('S7 chat turn');
    const ack1 = await ack(adminSock, 'chat-message', { text: 'PING' });
    check('chat-message ack ok', ack1 && ack1.ok === true, ack1);
    const userMsg = await waitFor(admin.events['chat-message'], (m) => m.role === 'user', 'user msg', 5000);
    check('user message broadcast with conversationId', userMsg.conversationId === conv1.id && userMsg.text === 'PING', userMsg);
    await waitFor(admin.events['codex-status'], (s) => s.busy === true, 'busy', 5000).catch(() => {});
    const agentMsg = await waitFor(admin.events['chat-message'], (m) => m.role === 'agent', 'agent msg', 15000);
    check('agent reply PONG (stub exec path)', agentMsg.text === 'PONG', agentMsg.text);
    check('agent reply marked stream + routed to conv', agentMsg.stream === true && agentMsg.conversationId === conv1.id, agentMsg);
    check('turn ends with busy=false', await waitFor(admin.events['codex-status'], (s) => s.busy === false, 'idle', 10000).then(() => true, () => false));
    const convsFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf8'));
    const conv1Stored = convsFile.conversations.find((c) => c.id === conv1.id);
    check('thread id persisted', conv1Stored && /^T[0-9a-f]{8}$/.test(conv1Stored.sessionId || ''), conv1Stored && conv1Stored.sessionId);
    check('first message became title', conv1Stored.title === 'PING', conv1Stored.title);
    const thread1 = conv1Stored.sessionId;

    /* ---- S8 command_execution process events ---- */
    console.log('S8 command execution process');
    const ack2 = await ack(adminSock, 'chat-message', { text: 'CCX_CMDTEST' });
    check('cmd turn accepted', ack2 && ack2.ok === true, ack2);
    const procStart = await waitFor(admin.events['chat-process'], (p) => p.type === 'cmd' && p.status === 'start', 'cmd start', 10000);
    check('chat-process cmd start routed', procStart.conversationId === conv1.id && procStart.command === 'echo hi', procStart);
    const procDone = await waitFor(admin.events['chat-process'], (p) => p.type === 'cmd' && p.status === 'done', 'cmd done', 10000);
    check('chat-process cmd done carries output', procDone.output === 'hi' && procDone.exitCode === 0, procDone);
    const cmdAgent = await waitFor(admin.events['chat-message'], (m) => m.role === 'agent' && m.conversationId === conv1.id && m.id !== agentMsg.id, 'cmd agent msg', 15000);
    check('final message replays process array', Array.isArray(cmdAgent.process) && cmdAgent.process.some((p) => p.type === 'cmd' && p.command === 'echo hi' && p.output === 'hi'), cmdAgent.process);

    /* ---- S9 resume path ---- */
    console.log('S9 resume');
    const ack3 = await ack(adminSock, 'chat-message', { text: 'PING2' });
    check('second turn accepted', ack3 && ack3.ok === true, ack3);
    const resumeMsg = await waitFor(admin.events['chat-message'], (m) => m.role === 'agent' && m.text === 'RESUMED-PONG', 'resume reply', 15000);
    check('resume reply received', !!resumeMsg);
    const stubCalls = fs.readFileSync(stubLog, 'utf8');
    check('stub was called with resume + thread id', stubCalls.indexOf('"resume","' + thread1 + '"') >= 0, stubCalls.slice(-300));
    const convsFile2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf8'));
    const conv1b = convsFile2.conversations.find((c) => c.id === conv1.id);
    check('thread id unchanged across resume', conv1b.sessionId === thread1, conv1b.sessionId);

    /* ---- S10 resume failure falls back to new thread ---- */
    console.log('S10 resume failure fallback');
    const ack4 = await ack(adminSock, 'chat-message', { text: 'CCX_FAILRESUME' });
    check('failure turn accepted', ack4 && ack4.ok === true, ack4);
    const recovered = await waitFor(admin.events['chat-message'], (m) => m.role === 'agent' && m.text === 'RECOVERED', 'recovered reply', 15000);
    check('requeued turn answered after resume failure', !!recovered);
    await waitFor(admin.events['codex-status'], (s) => s.busy === false, 'idle after fallback', 10000).catch(() => {});
    const convsFile3 = JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf8'));
    const conv1c = convsFile3.conversations.find((c) => c.id === conv1.id);
    check('session id rotated after resume failure', conv1c.sessionId && conv1c.sessionId !== thread1, conv1c.sessionId);

    /* ---- S11 message length clamp + empty message ---- */
    console.log('S11 input clamps');
    const long = 'A'.repeat(60);
    const ack5 = await ack(adminSock, 'chat-message', { text: long });
    check('oversize message accepted but clamped', ack5 && ack5.ok === true, ack5);
    const clampedUser = await waitFor(admin.events['chat-message'], (m) => m.role === 'user' && m.text === 'A'.repeat(40), 'clamped user msg', 5000);
    check('stored text <= maxMessageLen(40)', clampedUser.text.length <= 40 && clampedUser.text.length > 0, clampedUser.text.length);
    // 40 个 A 不含任何桩标记 -> 固定回复 'STUB-REPLY ' + 末 30 字符
    const clampedAgentReply = 'STUB-REPLY ' + 'A'.repeat(30);
    await waitFor(admin.events['chat-message'], (m) => m.role === 'agent' && m.text === clampedAgentReply, 'agent for clamped', 15000);
    await waitFor(admin.events['codex-status'], (s) => s.busy === false, 'idle after clamp turn', 10000).catch(() => {});
    const ackEmpty = await ack(adminSock, 'chat-message', { text: '   ' });
    check('empty message rejected', ackEmpty && ackEmpty.ok === false, ackEmpty);

    /* ---- S12 model options / settings ---- */
    console.log('S12 model options & settings');
    r = await api('GET', '/api/model-options', undefined, adminCookie);
    check('profiles scanned from CODEX_HOME', r.status === 200 && r.json.profiles.includes('fakeprofile'), r.json);
    check('base catalog models exposed', r.json.models.includes('stub-model'), r.json.models);
    r = await api('POST', '/api/model-settings', { profile: 'no-such-profile', model: null }, adminCookie);
    check('unknown profile rejected 400', r.status === 400, r.status);
    r = await api('POST', '/api/model-settings', { profile: 'default', model: 'stub-model' }, adminCookie);
    check('switch to default ok', r.status === 200 && r.json.profile === 'default', r.json);
    const mcEvent = await waitFor(admin.events['model-changed'], () => true, 'model-changed', 3000);
    check('model-changed broadcast', mcEvent && mcEvent.profile === 'default', mcEvent);
    r = await api('POST', '/api/model-settings', { profile: 'fakeprofile', model: 'fake-model' }, adminCookie);
    check('switch to fakeprofile ok', r.status === 200 && r.json.profile === 'fakeprofile' && r.json.model === 'fake-model', r.json);
    const tmpConfig = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    check('selection persisted to temp config.json', tmpConfig.profile === 'fakeprofile' && tmpConfig.model === 'fake-model', tmpConfig);

    /* ---- S13 security: no plaintext passwords on disk ---- */
    console.log('S13 persistence security');
    const usersRaw = fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8');
    check('no plaintext admin password', usersRaw.indexOf('secret123') < 0);
    check('no plaintext alice passwords', usersRaw.indexOf('alice123') < 0 && usersRaw.indexOf('newpass99') < 0);
    check('password hashes stored', usersRaw.indexOf('passwordHash') > 0 && usersRaw.indexOf(':') > 0);

    /* ---- S14 delete conversation cleans thread ---- */
    console.log('S14 delete conversation');
    r = await api('DELETE', '/api/conversations/' + conv1.id, undefined, adminCookie);
    check('delete idle conversation ok', r.status === 200, { status: r.status, body: r.json });
    await sleep(600); // thread cleanup is fire-and-forget
    const stubLogNow = fs.readFileSync(stubLog, 'utf8');
    const delLine = stubLogNow.split('\n').find((l) => l.startsWith('DELETED '));
    check('codex thread cleanup invoked', !!delLine && delLine.indexOf('T') > 0, delLine);
    r = await api('GET', '/api/conversations', undefined, adminCookie);
    check('deleted conversation gone from list', r.json.conversations.every((c) => c.id !== conv1.id), r.json.activeId);
    r = await api('DELETE', '/api/conversations/does-not-exist', undefined, adminCookie);
    check('unknown conversation delete 404', r.status === 404, r.status);
  } catch (e) {
    failures.push('FATAL: ' + e.message);
    console.log('  FATAL ' + e.stack);
  } finally {
    if (adminSock) { try { adminSock.close(); } catch (e) {} }
    await stopServer(server);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
      console.log('  WARN temp dir not removed: ' + tmp);
    }
  }

  console.log('');
  console.log('=========================================');
  console.log(' RESULT: ' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) console.log(' FAILED: ' + failures.join(' | '));
  console.log('=========================================');
  process.exit(failures.length ? 1 : 0);
})();
