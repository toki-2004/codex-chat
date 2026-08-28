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
const CONV_FILE = path.join(DATA_DIR, 'conversation.json');
const PID_FILE = path.join(ROOT, 'server.pid');

const DEFAULT_CONFIG = {
  port: 3100,
  host: '0.0.0.0',
  cwd: 'D:\\pythonitems',
  model: null,
  sandbox: 'danger-full-access',
  bypassApprovals: true,
  skipGitRepoCheck: true,
  turnTimeoutMs: 15 * 60 * 1000,
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
const TURN_TIMEOUT = Number(config.turnTimeoutMs) || 15 * 60 * 1000;
const MAX_AGENT_TEXT = 20000; // 单条 Codex 回复上限，防止文件无限膨胀
const SEND_HISTORY = 200;     // 客户端可拉取的最近消息数
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
 * 会话数据（data/conversation.json）：{ sessionId, messages: [...] }
 * ------------------------------------------------------------------------- */
let conversation = null;

function getConversation() {
  if (!conversation) {
    conversation = readJSON(CONV_FILE, { sessionId: null, messages: [] });
    if (!conversation.messages || !Array.isArray(conversation.messages)) conversation.messages = [];
    conversation.messages = conversation.messages.filter((m) => m && m.text != null);
    if (!conversation.sessionId) conversation.sessionId = null;
  }
  return conversation;
}

function saveConversation() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  enqueue('conv', () => writeJSONAtomic(CONV_FILE, getConversation()));
}

function pushMessage(msg) {
  const conv = getConversation();
  conv.messages.push(msg);
  if (conv.messages.length > MAX_HISTORY) conv.messages = conv.messages.slice(-MAX_HISTORY);
  saveConversation();
  io.emit('chat-message', msg);
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
    messages: getConversation().messages.length,
    codex: codexInfo,
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    serverName: 'Codex Chat',
    cwd: CWD,
    model: config.model || 'default',
    sandbox: config.sandbox,
    bypassApprovals: !!config.bypassApprovals,
    maxMessageLen: MAX_MESSAGE_LEN,
  });
});

app.get('/api/messages', (req, res) => {
  res.json({ messages: getConversation().messages.slice(-SEND_HISTORY) });
});

/* ---------------------------------------------------------------------------
 * Socket.io：成员（在线设备）+ 聊天
 * ------------------------------------------------------------------------- */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

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

io.on('connection', (socket) => {
  const defaultUser = {
    id: 'u_' + socket.id.slice(0, 8),
    name: '匿名设备',
    color: '#8a8f98',
  };
  socket.data.user = defaultUser;
  clients.set(socket.id, {
    socketId: socket.id,
    userId: defaultUser.id,
    name: defaultUser.name,
    color: defaultUser.color,
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
    const id = String((payload && payload.id) || socket.data.user.id).slice(0, 64);
    const name = String((payload && payload.name) || '匿名设备').slice(0, 24);
    const color = String((payload && payload.color) || '#8a8f98').slice(0, 16);
    socket.data.user = { id, name, color };
    const m = clients.get(socket.id);
    if (m) {
      m.userId = id;
      m.name = name;
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

    const msg = {
      id: newId('m'),
      userId: user.id,
      name: user.name,
      color: user.color,
      text,
      at: Date.now(),
      role: 'user',
    };
    pushMessage(msg);
    doAck({ ok: true });
    enqueueCodexTurn(msg);
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

function enqueueCodexTurn(msg) {
  if (state.busy) return; // 已在处理中，消息已入队
  state.queue.push(msg);
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
    await runCodexTurn(next);
  }
}

function buildCodexArgs(prompt) {
  const conv = getConversation();
  const base = [];
  if (conv.sessionId) {
    base.push('exec', 'resume', conv.sessionId, '--json');
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

function runCodexTurn(msg) {
  return new Promise((resolve) => {
    const conv = getConversation();
    const firstTurn = !conv.sessionId;
    let prompt = msg.text;
    if (firstTurn) {
      const sys = String(config.systemPrompt || '')
        .replace(/\{cwd\}/g, CWD)
        .replace(/\{codexHome\}/g, CODEX_HOME);
      prompt = sys + '\n\n第一条用户消息：\n' + msg.text;
    }

    const { args, isResume } = buildCodexArgs(prompt);
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
        saveConversation();
      }
      if (text) {
        pushMessage({
          id: newId('m'),
          userId: AGENT_USER.userId,
          name: AGENT_USER.name,
          color: AGENT_USER.color,
          text: text.slice(0, MAX_AGENT_TEXT),
          at: Date.now(),
          role: 'agent',
        });
      } else if (errorInfo) {
        pushMessage({
          id: newId('m'),
          userId: SYSTEM_USER.userId,
          name: SYSTEM_USER.name,
          color: SYSTEM_USER.color,
          text: errorInfo,
          at: Date.now(),
          role: 'system',
        });
      }
      resolve();
    };

    const timer = setTimeout(() => {
      console.error('[codex] 超时，终止进程');
      killProcTree(proc);
      finish(null, 'Codex 回复超时（超过 ' + Math.round(TURN_TIMEOUT / 60000) + ' 分钟），已中断。');
    }, TURN_TIMEOUT);

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
        saveConversation();
        resolve();
        state.queue.unshift(msg); // 放回队首，保持顺序
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
  getConversation();
  saveConversation();
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  probeCodex();

  server.listen(PORT, HOST, () => {
    console.log('------------------------------------------');
    console.log('Codex Chat 已启动（单线会话）');
    console.log('本机访问:   http://localhost:' + PORT);
    console.log('局域网访问: http://<本机IP>:' + PORT);
    console.log('工作目录:   ' + CWD);
    console.log('Codex: ' + (codexInfo.ok ? codexInfo.version : '探测中/不可用'));
    console.log('------------------------------------------');
  });
  server.on('error', (err) => {
    console.error('启动失败：' + err.message);
    if (err.code === 'EADDRINUSE') {
      console.error('端口 ' + PORT + ' 被占用，请修改 config.json 中的 port 后重试。');
    }
    process.exit(1);
  });
}

bootstrap();
