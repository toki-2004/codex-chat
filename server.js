/* ===========================================================================
 * Codex Chat - 自托管 Codex 远程聊天（单线会话）
 * ---------------------------------------------------------------------------
 * 设计要点：
 *   - 客户端和服务端之间只有一条 Codex 会话（thread），类似用户直接与
 *     Codex CLI 对话：任意设备发的消息都进入同一条会话，回复广播给所有设备。
 *   - Codex 使用本机默认配置运行（~/.codex/config.toml），自动读取
 *     $CODEX_HOME/skills 下的技能、沿用用户使用习惯，并直接操作本机真实
 *     项目/文件/环境，与使用何种客户端无关。
 *   - 首次消息用 codex exec 创建会话，之后用 codex exec resume 续聊；
 *     会话 ID 持久化在 data/conversation.json，服务重启后仍可继续。
 *
 * 启动：
 *   npm install
 *   node server.js            （默认监听 0.0.0.0:3100，见 config.json）
 *
 * 配置（config.json）：
 *   port / host               监听地址
 *   cwd                       Codex 工作根目录（本机项目根，默认 D:\pythonitems）
 *   model                     Codex 模型（null = 使用 Codex 默认配置）
 *   sandbox                   read-only | workspace-write | danger-full-access
 *   bypassApprovals           true = 跳过审批直接执行（等同 CLI 全自动）
 *   skipGitRepoCheck          允许在非 git 目录运行 Codex
 *   turnTimeoutMs             单轮回复超时（毫秒）
 *   maxMessageLen             单条消息最大长度
 *   maxHistory                会话保留最近消息数
 *   systemPrompt              会话首轮注入的系统提示词（{cwd}/{codexHome} 占位符）
 *
 * 依赖本机已安装并登录 Codex CLI（codex --version / codex login）。
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

/* ---------------------------------------------------------------------------
 * 配置与常量
 * ------------------------------------------------------------------------- */
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CONVS_FILE = path.join(DATA_DIR, 'conversations.json');
const LEGACY_CONV_FILE = path.join(DATA_DIR, 'conversation.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PID_FILE = path.join(ROOT, 'server.pid');

const DEFAULT_CONFIG = {
  port: 3100,
  host: '0.0.0.0',
  cwd: 'D:\\pythonitems',
  model: null,
  sandbox: 'danger-full-access',
  bypassApprovals: true,
  skipGitRepoCheck: true,
  turnTimeoutMs: 0, // 0 = 不限制回复时长
  maxMessageLen: 500,
  maxHistory: 500,
  systemPrompt:
    '你是 Codex，运行在用户本机 Windows 11 上，正在通过远程聊天与用户对话。\n' +
    '你拥有与 Codex CLI 完全一致的本机能力：\n' +
    '- 可读写本机所有项目、文件与环境（工作根目录 {cwd}），使用本机安装的工具（git、gh、node、npm 等）；\n' +
    '- 自动读取 {codexHome} 下的 skills 技能与配置，沿用用户的既有使用习惯与偏好；\n' +
    '- 涉及项目时先阅读项目根目录的 HANDOVER.md（若存在）。\n' +
    '请用与用户相同的语言回复，保持简洁直接。',
};

let config = {};
try {
  config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) };
} catch (e) {
  config = { ...DEFAULT_CONFIG };
  console.error('[config] 读取 config.json 失败，使用默认配置：' + e.message);
}

const PORT = Number(process.env.PORT || config.port || 3100);
const HOST = process.env.HOST || config.host || '0.0.0.0';
const CWD = path.resolve(String(config.cwd || ROOT));
const MAX_MESSAGE_LEN = Number(config.maxMessageLen) || 500;
const MAX_HISTORY = Number(config.maxHistory) || 500;
const TURN_TIMEOUT = Number(config.turnTimeoutMs) || 0; // 0 = 不限制回复时长
const MAX_AGENT_TEXT = 20000; // 单条 Codex 回复上限，防止文件无限膨胀
const SEND_HISTORY = 200;     // 客户端可拉取的最近消息数
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 登录会话有效期（7 天）
const MAX_CONVERSATIONS = 50; // 对话数量上限，超出时自动删除最旧的
const AGENT_USER = { userId: 'codex', name: 'Codex', color: '#10a37f' };
const SYSTEM_USER = { userId: 'system', name: '系统', color: '#8a8f98' };
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

/* ---------------------------------------------------------------------------
 * 工具函数：JSON 读写（tmp + rename 原子落盘）、写队列
 * ------------------------------------------------------------------------- */
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSONAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const writeQueues = new Map();
function enqueue(key, fn) {
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(
    key,
    next.catch((e) => console.error('[write] ' + key + ' 失败：' + e.message))
  );
  return next;
}

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/* ---------------------------------------------------------------------------
 * 账号与登录（data/users.json + data/sessions.json）
 * 密码用 scrypt 加盐哈希存储，绝不保存明文；会话为随机 token + httpOnly Cookie
 * ------------------------------------------------------------------------- */
let usersCache = null;
let sessions = null;

function getUsers() {
  if (!usersCache) {
    usersCache = readJSON(USERS_FILE, { users: {} });
    if (!usersCache.users || typeof usersCache.users !== 'object') usersCache.users = {};
  }
  return usersCache;
}

function saveUsers() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJSONAtomic(USERS_FILE, getUsers());
}

function loadSessions() {
  sessions = readJSON(SESSIONS_FILE, {});
  if (!sessions || typeof sessions !== 'object') sessions = {};
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(sessions)) {
    if (!sessions[k] || sessions[k].expires < now) { delete sessions[k]; changed = true; }
  }
  if (changed) saveSessions();
}

function saveSessions() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJSONAtomic(SESSIONS_FILE, sessions);
}

function passwordHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + hash;
}

function passwordVerify(pw, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const salt = parts[0];
  const hash = Buffer.from(parts[1], 'hex');
  if (hash.length !== 32) return false;
  const calc = crypto.scryptSync(String(pw), salt, 32);
  return crypto.timingSafeEqual(hash, calc);
}

function findUserByUsername(username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) return null;
  return Object.values(getUsers().users).find((u) => String(u.username).toLowerCase() === name) || null;
}

function userPublic(u) {
  return { id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role, createdAt: u.createdAt };
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = {
    userId: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    expires: Date.now() + SESSION_TTL,
  };
  saveSessions();
  return token;
}

function sessionFromRequest(req) {
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)cc_session=([^;]+)/.exec(cookie);
  if (!m) return null;
  const s = sessions[m[1]];
  if (!s || s.expires < Date.now()) return null;
  return s;
}

function requireAuth(req, res, next) {
  const s = sessionFromRequest(req);
  if (!s) return res.status(401).json({ error: '未登录或会话已过期' });
  req.sessionUser = s;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.sessionUser.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
    next();
  });
}

function validUsername(name) {
  return /^[A-Za-z0-9_\u4e00-\u9fa5]{2,24}$/.test(String(name || '').trim());
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 6 && pw.length <= 64;
}

/* ---------------------------------------------------------------------------
 * 对话数据（data/conversations.json）：
 * { activeId, conversations: [{ id, sessionId, title, createdAt, updatedAt, messages }] }
 * 旧版单会话 data/conversation.json 首次启动自动迁移。
 * ------------------------------------------------------------------------- */
let conversationsData = null;

function getConversations() {
  if (!conversationsData) {
    conversationsData = readJSON(CONVS_FILE, null);
    if (!conversationsData || !Array.isArray(conversationsData.conversations)) {
      conversationsData = { activeId: null, conversations: [] };
      const legacy = readJSON(LEGACY_CONV_FILE, null);
      if (legacy && Array.isArray(legacy.messages)) {
        const conv = {
          id: newId('c'),
          sessionId: legacy.sessionId || null,
          title: '对话 1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: legacy.messages.filter((m) => m && m.text != null),
        };
        conversationsData.conversations.push(conv);
        conversationsData.activeId = conv.id;
        try { fs.renameSync(LEGACY_CONV_FILE, LEGACY_CONV_FILE + '.bak'); } catch (e) { /* 忽略 */ }
      }
    }
    conversationsData.conversations = conversationsData.conversations.filter(
      (c) => c && c.id && Array.isArray(c.messages)
    );
  }
  return conversationsData;
}

function saveConversations() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  enqueue('conv', () => writeJSONAtomic(CONVS_FILE, getConversations()));
}

function getActiveConversation() {
  const data = getConversations();
  return data.conversations.find((c) => c.id === data.activeId) || null;
}

function convPublic(c) {
  const data = getConversations();
  return {
    id: c.id,
    title: c.title || '新对话',
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messages.length,
    active: c.id === data.activeId,
  };
}

function broadcastConversations() {
  const data = getConversations();
  io.emit('conversations', {
    activeId: data.activeId,
    conversations: data.conversations.map(convPublic),
  });
}

function deleteCodexThread(threadId) {
  // 尽力清理 Codex 线程，不阻塞也不报错
  try {
    const exec = resolveCodexExec();
    spawn(exec.cmd, exec.prefix.concat(['delete', String(threadId), '--force']), {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore',
      shell: exec.shell,
    });
  } catch (e) { /* 忽略 */ }
}

function createConversation() {
  const data = getConversations();
  const now = Date.now();
  const conv = {
    id: newId('c'),
    sessionId: null,
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  data.conversations.push(conv);
  data.activeId = conv.id;
  if (data.conversations.length > MAX_CONVERSATIONS) {
    const olds = data.conversations
      .filter((c) => c.id !== data.activeId)
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    while (data.conversations.length > MAX_CONVERSATIONS && olds.length) {
      const old = olds.shift();
      const idx = data.conversations.findIndex((c) => c.id === old.id);
      if (idx >= 0) data.conversations.splice(idx, 1);
      if (old.sessionId) deleteCodexThread(old.sessionId);
    }
  }
  saveConversations();
  broadcastConversations();
  return conv;
}

function deleteConversation(id) {
  const data = getConversations();
  const idx = data.conversations.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  const [conv] = data.conversations.splice(idx, 1);
  if (data.activeId === conv.id) {
    const rest = [...data.conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    data.activeId = rest.length ? rest[0].id : null;
  }
  saveConversations();
  if (conv.sessionId) deleteCodexThread(conv.sessionId);
  broadcastConversations();
  return true;
}

function pushMessageTo(conv, msg, opts) {
  if (!conv) return;
  conv.messages.push(msg);
  if (conv.messages.length > MAX_HISTORY) conv.messages = conv.messages.slice(-MAX_HISTORY);
  conv.updatedAt = Date.now();
  saveConversations();
  const payload = Object.assign({}, msg, { conversationId: conv.id });
  if (opts && opts.stream) payload.stream = true;
  io.emit('chat-message', payload);
}

function pushMessage(msg) {
  pushMessageTo(getActiveConversation(), msg, null);
}

/* ---------------------------------------------------------------------------
 * REST API
 * ------------------------------------------------------------------------- */
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    cwd: CWD,
    conversations: getConversations().conversations.length,
    messages: (getActiveConversation() || { messages: [] }).messages.length,
    codex: codexInfo,
  });
});

app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    serverName: 'Codex Chat',
    cwd: CWD,
    model: config.model || 'default',
    sandbox: config.sandbox,
    bypassApprovals: !!config.bypassApprovals,
    maxMessageLen: MAX_MESSAGE_LEN,
  });
});

/* ---------- 账号：首次初始化管理员 / 登录 / 登出 / 当前用户 ---------- */
app.post('/api/setup', (req, res) => {
  if (Object.keys(getUsers().users).length > 0) {
    return res.status(400).json({ error: '系统已初始化，不能重复创建管理员' });
  }
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!validUsername(username)) return res.status(400).json({ error: '用户名需为 2-24 位中文/字母/数字/下划线' });
  if (!validPassword(password)) return res.status(400).json({ error: '密码长度需为 6-64 位' });
  const displayName = String((req.body && req.body.displayName) || '').trim().slice(0, 24) || username;
  const id = newId('u');
  const user = {
    id,
    username,
    displayName,
    passwordHash: passwordHash(password),
    role: 'admin',
    createdAt: new Date().toISOString(),
  };
  getUsers().users[id] = user;
  saveUsers();
  const token = createSession(user);
  res.cookie('cc_session', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL });
  console.log('[auth] 初始化管理员 ' + username);
  res.json({ ok: true, user: userPublic(user) });
});

app.post('/api/login', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const user = findUserByUsername(username);
  if (!user || !passwordVerify(password, user.passwordHash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = createSession(user);
  res.cookie('cc_session', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL });
  res.json({ ok: true, user: userPublic(user) });
});

app.post('/api/logout', (req, res) => {
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)cc_session=([^;]+)/.exec(cookie);
  if (m && sessions[m[1]]) {
    delete sessions[m[1]];
    saveSessions();
  }
  res.clearCookie('cc_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const s = sessionFromRequest(req);
  res.json({
    needsSetup: Object.keys(getUsers().users).length === 0,
    user: s ? { ...s, displayName: s.displayName || s.username } : null,
  });
});

/* ---------- 用户管理（仅管理员） ---------- */
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(Object.values(getUsers().users).map(userPublic));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!validUsername(username)) return res.status(400).json({ error: '用户名需为 2-24 位中文/字母/数字/下划线' });
  if (!validPassword(password)) return res.status(400).json({ error: '密码长度需为 6-64 位' });
  if (findUserByUsername(username)) return res.status(400).json({ error: '用户名已存在' });
  const displayName = String((req.body && req.body.displayName) || '').trim().slice(0, 24) || username;
  const id = newId('u');
  const user = {
    id,
    username,
    displayName,
    passwordHash: passwordHash(password),
    role: 'user',
    createdAt: new Date().toISOString(),
  };
  getUsers().users[id] = user;
  saveUsers();
  console.log('[auth] 管理员 ' + req.sessionUser.username + ' 创建用户 ' + username);
  res.json({ ok: true, user: userPublic(user) });
});

app.patch('/api/users/:id', requireAuth, (req, res) => {
  const target = getUsers().users[String(req.params.id || '')];
  if (!target) return res.status(404).json({ error: '用户不存在' });
  const isSelf = req.sessionUser.userId === target.id;
  const isAdmin = req.sessionUser.role === 'admin';
  if (!isSelf && !isAdmin) return res.status(403).json({ error: '无权操作该用户' });

  if (req.body.password != null) {
    if (!validPassword(req.body.password)) return res.status(400).json({ error: '新密码长度需为 6-64 位' });
    // 本人改密必须验证当前密码；管理员重置他人无需当前密码
    if (isSelf && !passwordVerify(String(req.body.currentPassword || ''), target.passwordHash)) {
      return res.status(403).json({ error: '当前密码错误' });
    }
    target.passwordHash = passwordHash(req.body.password);
    console.log('[auth] ' + (isAdmin && !isSelf ? '管理员重置' : '修改') + '用户 ' + target.username + ' 的密码');
  }
  if (req.body.displayName != null) {
    const name = String(req.body.displayName).trim().slice(0, 24);
    if (name) target.displayName = name;
  }
  saveUsers();
  res.json({ ok: true, user: userPublic(target) });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const target = getUsers().users[String(req.params.id || '')];
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.id === req.sessionUser.userId) return res.status(400).json({ error: '不能删除当前登录的管理员' });
  delete getUsers().users[target.id];
  saveUsers();
  // 同步踢出该用户的所有会话
  for (const k of Object.keys(sessions)) {
    if (sessions[k].userId === target.id) { delete sessions[k]; saveSessions(); }
  }
  console.log('[auth] 管理员 ' + req.sessionUser.username + ' 删除用户 ' + target.username);
  res.json({ ok: true });
});

app.get('/api/messages', requireAuth, (req, res) => {
  const conv = getActiveConversation();
  res.json({ messages: conv ? conv.messages.slice(-SEND_HISTORY) : [] });
});

/* ---------- 多对话：列表 / 新建 / 切换 / 删除 ---------- */
app.get('/api/conversations', requireAuth, (req, res) => {
  const data = getConversations();
  res.json({ activeId: data.activeId, conversations: data.conversations.map(convPublic) });
});

app.post('/api/conversations', requireAuth, (req, res) => {
  const conv = createConversation();
  res.json({ ok: true, conversation: conv });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const data = getConversations();
  const conv = data.conversations.find((c) => c.id === String(req.params.id || ''));
  if (!conv) return res.status(404).json({ error: '对话不存在' });
  data.activeId = conv.id;
  saveConversations();
  broadcastConversations();
  res.json({ ok: true, conversation: conv });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  const data = getConversations();
  const target = data.conversations.find((c) => c.id === id);
  if (!target) return res.status(404).json({ error: '对话不存在' });
  if (state.busy && data.activeId === id) {
    return res.status(409).json({ error: '该对话正在回复中，请稍后再删除' });
  }
  deleteConversation(id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------------
 * Socket.io：成员（在线设备）+ 聊天
 * ------------------------------------------------------------------------- */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

// Socket 鉴权：必须携带有效登录 Cookie，身份取自账号
io.use((socket, next) => {
  const cookie = String(socket.handshake.headers.cookie || '');
  const m = /(?:^|;\s*)cc_session=([^;]+)/.exec(cookie);
  const s = m && sessions[m[1]];
  if (!s || s.expires < Date.now()) return next(new Error('unauthorized'));
  socket.data.account = s;
  next();
});

const clients = new Map(); // socketId -> { socketId, userId, name, color, joinedAt }

function memberList() {
  return Array.from(clients.values()).map((m) => ({
    socketId: m.socketId,
    userId: m.userId,
    name: m.name,
    color: m.color,
    joinedAt: m.joinedAt,
  }));
}

function broadcastMembers() {
  io.emit('members', memberList());
}

const USER_COLORS = ['#4c6ef5', '#12b886', '#fa5252', '#f59f00', '#7048e8', '#0ca678', '#e8590c', '#3b5bdb', '#c2255c', '#1098ad'];
function colorOf(userId) {
  let h = 0;
  for (const ch of String(userId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length];
}

io.on('connection', (socket) => {
  const account = socket.data.account;
  socket.data.user = {
    id: account.userId,
    name: account.displayName || account.username,
    color: colorOf(account.userId),
  };
  clients.set(socket.id, {
    socketId: socket.id,
    userId: socket.data.user.id,
    name: socket.data.user.name,
    color: socket.data.user.color,
    joinedAt: Date.now(),
  });
  broadcastMembers();
  socket.emit('welcome', { config: {
    cwd: CWD,
    model: config.model || 'default',
    sandbox: config.sandbox,
    maxMessageLen: MAX_MESSAGE_LEN,
  }});

  socket.on('set-user', (payload, ack) => {
    const doAck = typeof ack === 'function' ? ack : () => {};
    // 身份（名字）固定来自账号，客户端只能改本设备的显示颜色
    const color = String((payload && payload.color) || socket.data.user.color).slice(0, 16);
    socket.data.user.color = color;
    const m = clients.get(socket.id);
    if (m) {
      m.color = color;
    }
    broadcastMembers();
    doAck({ ok: true });
  });

  socket.on('chat-message', (payload, ack) => {
    const doAck = typeof ack === 'function' ? ack : () => {};
    const user = socket.data.user;
    const text = String((payload && payload.text) || '').trim().slice(0, MAX_MESSAGE_LEN);
    if (!text) return doAck({ ok: false, reason: '消息不能为空' });

    let conv = getActiveConversation();
    if (!conv) conv = createConversation();
    // 第一条消息自动作为对话标题
    if (conv.messages.length === 0 && (conv.title === '新对话' || !conv.title)) {
      conv.title = text.length > 14 ? text.slice(0, 14) + '…' : text;
      saveConversations();
      broadcastConversations();
    }

    const msg = {
      id: newId('m'),
      userId: user.id,
      name: user.name,
      color: user.color,
      text,
      at: Date.now(),
      role: 'user',
    };
    pushMessageTo(conv, msg, null);
    doAck({ ok: true });
    enqueueCodexTurn(msg, conv.id);
  });

  socket.on('disconnect', () => {
    clients.delete(socket.id);
    broadcastMembers();
  });
});

/* ---------------------------------------------------------------------------
 * Codex 桥接：全局一条会话，消息串行排队处理
 * ------------------------------------------------------------------------- */
const state = { busy: false, queue: [], proc: null };

/* Windows 下 codex 通常是 npm 安装的 .cmd 包装，Node spawn 直接执行会 ENOENT；
 * 优先解析到 @openai/codex 的 JS 入口，用 node 直接启动 */
let codexExec = null;
function resolveCodexExec() {
  if (codexExec) return codexExec;
  if (process.platform === 'win32') {
    for (const dir of String(process.env.PATH || '').split(';')) {
      const exe = dir ? path.join(dir, 'codex.exe') : '';
      if (exe && fs.existsSync(exe)) {
        codexExec = { cmd: exe, prefix: [], shell: false };
        return codexExec;
      }
    }
    const npmJs = path.join(
      process.env.APPDATA || '',
      'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'
    );
    if (fs.existsSync(npmJs)) {
      codexExec = { cmd: process.execPath, prefix: [npmJs], shell: false };
      return codexExec;
    }
    for (const dir of String(process.env.PATH || '').split(';')) {
      const cmd = dir ? path.join(dir, 'codex.cmd') : '';
      if (cmd && fs.existsSync(cmd)) {
        codexExec = { cmd, prefix: [], shell: true };
        return codexExec;
      }
    }
  }
  codexExec = { cmd: 'codex', prefix: [], shell: false };
  return codexExec;
}

function broadcastCodexStatus(busy) {
  io.emit('codex-status', { busy });
}

function enqueueCodexTurn(msg, convId) {
  if (state.busy) return; // 已在处理中，消息已入队
  state.queue.push({ msg, convId });
  state.busy = true;
  processCodexQueue()
    .catch((e) => {
      console.error('[codex] 队列异常：' + e.message);
    })
    .finally(() => {
      state.busy = false;
      state.proc = null;
      broadcastCodexStatus(false);
    });
}

async function processCodexQueue() {
  while (true) {
    const next = state.queue.shift();
    if (!next) return;
    broadcastCodexStatus(true);
    await runCodexTurn(next.msg, next.convId);
  }
}

function buildCodexArgs(prompt, conv) {
  conv = conv || getActiveConversation() || createConversation();
  const base = [];
  if (conv.sessionId) {
    base.push('exec', 'resume', conv.sessionId, '--json');
    if (config.bypassApprovals) {
      base.push('--dangerously-bypass-approvals-and-sandbox');
    }
  } else {
    base.push('exec', '--json', '-C', CWD);
    if (config.bypassApprovals) {
      base.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      base.push('-s', String(config.sandbox || 'danger-full-access'));
    }
  }
  if (config.model) base.push('-m', String(config.model));
  if (config.skipGitRepoCheck !== false) base.push('--skip-git-repo-check');
  base.push(prompt);
  return { args: base, isResume: !!conv.sessionId };
}

function runCodexTurn(msg, convId) {
  return new Promise((resolve) => {
    const data = getConversations();
    const conv = data.conversations.find((c) => c.id === convId)
      || getActiveConversation()
      || createConversation();
    const firstTurn = !conv.sessionId;
    let prompt = msg.text;
    if (firstTurn) {
      const sys = String(config.systemPrompt || '')
        .replace(/\{cwd\}/g, CWD)
        .replace(/\{codexHome\}/g, CODEX_HOME);
      prompt = sys + '\n\n第一条用户消息：\n' + msg.text;
    }

    const { args, isResume } = buildCodexArgs(prompt, conv);
    console.log('[codex] ' + (isResume ? 'resume ' + conv.sessionId : '新线程') + ' <- ' + msg.text.slice(0, 60));

    const exec = resolveCodexExec();
    const proc = spawn(exec.cmd, exec.prefix.concat(args), {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: exec.shell,
    });
    state.proc = proc;

    let stdoutBuf = '';
    let stderrTail = '';
    let agentText = '';
    let turnDone = false;
    let sessionId = conv.sessionId || null;

    const finish = (text, errorInfo) => {
      if (turnDone) return;
      turnDone = true;
      clearTimeout(timer);
      if (sessionId && sessionId !== conv.sessionId) {
        conv.sessionId = sessionId;
        saveConversations();
      }
      if (text) {
        pushMessageTo(conv, {
          id: newId('m'),
          userId: AGENT_USER.userId,
          name: AGENT_USER.name,
          color: AGENT_USER.color,
          text: text.slice(0, MAX_AGENT_TEXT),
          at: Date.now(),
          role: 'agent',
        }, { stream: true });
      } else if (errorInfo) {
        pushMessageTo(conv, {
          id: newId('m'),
          userId: SYSTEM_USER.userId,
          name: SYSTEM_USER.name,
          color: SYSTEM_USER.color,
          text: errorInfo,
          at: Date.now(),
          role: 'system',
        }, null);
      }
      resolve();
    };

    let timer = null;
    if (TURN_TIMEOUT > 0) {
      timer = setTimeout(() => {
        console.error('[codex] 超时，终止进程');
        killProcTree(proc);
        finish(null, 'Codex 回复超时（超过 ' + Math.round(TURN_TIMEOUT / 60000) + ' 分钟），已中断。');
      }, TURN_TIMEOUT);
    }

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        handleCodexEvent(line, {
          setSession: (id) => { sessionId = id; },
          addDelta: (t) => { agentText += t; },
          setText: (t) => { agentText = t; },
        });
      }
    });

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderrTail = (stderrTail + s).slice(-2000);
      process.stderr.write(s); // 透传给服务控制台，方便排查
    });

    proc.on('error', (err) => {
      console.error('[codex] 启动失败：' + err.message);
      finish(null, '无法启动 Codex：' + err.message + '。请确认本机已安装并登录 Codex CLI。');
    });

    proc.on('close', (code) => {
      if (turnDone) return;
      if (agentText) {
        finish(agentText, null);
        return;
      }
      const tail = stderrTail.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      // 失败时：若本次是 resume，可能是会话已失效，清空后用同一消息重开新线程
      if (isResume && code !== 0) {
        console.error('[codex] resume 失败，回退新线程：' + tail);
        conv.sessionId = null;
        saveConversations();
        resolve();
        state.queue.unshift({ msg, convId: conv.id }); // 放回队首，保持顺序
        return;
      }
      finish(null, 'Codex 调用失败（退出码 ' + code + '）：' + tail);
    });
  });
}

function handleCodexEvent(line, ctx) {
  let ev = null;
  try {
    ev = JSON.parse(line);
  } catch (e) {
    return; // 非 JSON 行（警告等）忽略
  }
  const type = ev.type || ev.method || '';

  if (type === 'thread.started' && ev.thread_id) {
    ctx.setSession(String(ev.thread_id));
    return;
  }
  if (type === 'item.started' && ev.item && ev.item.type === 'agent_message') {
    ctx.setText('');
    return;
  }
  // 兼容多种增量事件形态：{delta} / {params:{delta}} / {item:{delta}}
  if (type.includes('delta')) {
    const d = (ev.params && ev.params.delta) || ev.delta || (ev.item && ev.item.delta);
    if (typeof d === 'string' && d) ctx.addDelta(d);
    return;
  }
  if (type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
    ctx.setText(ev.item.text);
  }
}

function killProcTree(proc) {
  if (!proc || proc.exitCode != null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch (e) {
    try { proc.kill(); } catch (e2) { /* 已退出 */ }
  }
}

/* ---------------------------------------------------------------------------
 * Codex 可用性探测（启动时缓存一次）
 * ------------------------------------------------------------------------- */
const codexInfo = { version: null, ok: false };
function probeCodex() {
  const exec = resolveCodexExec();
  const cmd = exec.shell ? exec.cmd : exec.cmd;
  execFile(cmd, exec.prefix.concat(['--version']), { timeout: 8000, windowsHide: true, shell: exec.shell }, (err, stdout) => {
    if (!err) {
      codexInfo.version = String(stdout || '').trim().split('\n')[0];
      codexInfo.ok = true;
    }
    console.log('[codex] ' + (codexInfo.ok ? '可用：' + codexInfo.version : '不可用：' + (err ? err.message : '未知')));
    if (!codexInfo.ok) console.log('[codex] 解析到的入口：' + exec.cmd + (exec.prefix.length ? ' ' + exec.prefix.join(' ') : ''));
  });
}

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------- */
function bootstrap() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CWD)) {
    console.error('工作目录不存在：' + CWD + '，请在 config.json 中修改 cwd 后重试。');
    process.exit(1);
  }
  getUsers();
  loadSessions();
  getConversations();
  saveConversations();
  probeCodex();

  server.listen(PORT, HOST, () => {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    const userCount = Object.keys(getUsers().users).length;
    console.log('------------------------------------------');
    console.log('Codex Chat 已启动（单线会话）');
    console.log('本机访问:   http://localhost:' + PORT);
    console.log('局域网访问: http://<本机IP>:' + PORT);
    console.log('工作目录:   ' + CWD);
    console.log('Codex: ' + (codexInfo.ok ? codexInfo.version : '探测中/不可用'));
    console.log('账号: ' + (userCount ? '已注册 ' + userCount + ' 个账号' : '尚未初始化，请在浏览器打开后创建管理员账号'));
    console.log('------------------------------------------');
  });
  server.on('error', (err) => {
    console.error('启动失败：' + err.message);
    if (err.code === 'EADDRINUSE') {
      console.error('端口 ' + PORT + ' 已被占用：服务可能已在运行，请先执行 stop.bat 停止后再启动。');
    }
    process.exit(1);
  });
}

bootstrap();
