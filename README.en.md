# Codex Chat

> **Language:** English | [简体中文](README.md)

Self-hosted remote chat for Codex: it turns the Codex CLI installed on your machine into a web chat service. Phones, tablets, and any computer on the same LAN (or via port forwarding) can talk to your local Codex from a browser, with the same feel as using the Codex CLI directly.

## Design Principle: Multiple Conversations, One Session Per Conversation

Each conversation maps to an independent Codex session (thread) with its own queue and its own Codex process: while one conversation is replying you can switch to another one and keep chatting, and several conversations can run at the same time:

- Messages sent from any device go into the Codex session of the currently active conversation, and replies are broadcast in real time to all online devices;
- Conversations never block each other: a long task in one of them does not hold up the others, and the working animation only follows the conversation that is actually replying;
- **Conversations can be created / switched / renamed / deleted**: creating a conversation opens a brand-new Codex thread; deleting one cleans up both the local record and the corresponding Codex thread; titles are summarized by the AI (and can be renamed by hand);
- Codex runs with your machine's default configuration (`~/.codex/config.toml`) and automatically reads the skills under `~/.codex/skills/`, preserving your existing habits and preferences;
- The working root is a real project directory on your machine (default `D:\pythonitems`); Codex can read and write all projects, files, and the environment on that machine, regardless of which client you use;
- Sessions are persisted and survive service restarts (`codex exec resume` continues the conversation).
- Each reply is **rendered as Markdown the moment it arrives** (text and code blocks come out correct immediately); while Codex is working the UI shows a "working" animation whose state is pushed by the server, so it stays accurate across reloads and devices.

## Features

- **Multi-conversation management**: create, switch, and delete conversations; each has its own context and Codex thread.
- **Conversation titles**: after a conversation's first reply, Codex summarizes a short title for it automatically; you can also rename any conversation with the ✎ button in the conversation list (a manually set title is never overwritten by the summary).
- **Conversations in parallel**: each conversation has its own Codex session and queue, so while one is running you can keep sending messages in another one; within a single conversation messages stay strictly first-in, first-out.
- **Replies render instantly**: a Codex reply lands in its final form — Markdown text and code blocks at once (no per-character animation, so long replies never end up half-rendered).
- **Copy buttons**: every code block has one at its top-right corner and every message has one at its tail (bottom-right); when the page is opened over plain http on a LAN a fallback path kicks in, so phones can copy with one tap too.
- **Stop at any time**: a "stop" button appears next to the input while a reply is running; clicking it aborts the current turn and drops the queued messages.
- **Live execution visibility**: every command Codex runs is shown in real time with its command, output, and exit code, alongside streaming process text; after the turn ends it can be expanded and replayed — you see the process, not just the result.
- **Always follows the latest output**: every piece of output (reply, command, process text) pulls the view back to the bottom, so a long reply never leaves you stuck at its top; if you scroll up to read history it does not yank you back — a "new messages ↓" pill appears, and clicking it (or scrolling back down) resumes following.
- **Message queueing**: messages sent while Codex is replying are queued automatically and processed in order once the reply finishes; nothing is lost.
- **No reply timeout**: reply duration is unlimited by default (`turnTimeoutMs: 0`), so long tasks are never cut off midway.
- **Account login**: create an administrator account on first launch, after which all usage requires signing in; the admin can add/remove users and reset passwords in the UI, and regular users can change their own password. Passwords are stored as scrypt salted hashes, never in plain text. Sessions last 7 days by default and are extended automatically while in use (renewed once half the lifetime is spent), so you are not kicked back to the login page mid-conversation.
- **Switch API and model on the fly**: profiles and models can be switched from the menu panel; changes sync to all devices in real time and are persisted to `config.json`, taking effect on the next reply. Profiles are `~/.codex/*.config.toml` files (e.g. the `zcode.config.toml` layered in by `codex -p zcode`) and are discovered by automatic scanning; model candidates are read automatically from the current configuration's `model_catalog_json` (the default profile reads the `models.json` referenced by `~/.codex/config.toml`, and the zcode profile reads `zcode-models.json`). The API is decided entirely by the profile: the default profile keeps `~/.codex/config.toml`, and choosing the zcode profile routes to BigModel — no default configuration is modified.
- **Live model list refresh**: the "↻ Refresh" button next to the model dropdown asks the current profile's provider for its real `/models` list (provider and key come from that profile's `model_provider` / `[model_providers.<name>]`; the key is only used for that request — never logged, never sent to the browser). Switching profiles refreshes automatically as well. If the request fails (timeout / 401 / offline) the dropdown never goes empty: it falls back to the local catalog and shows the reason underneath.
- **Same capabilities as the CLI**: reads skills, follows AGENTS.md/HANDOVER.md conventions, uses local tools such as git/gh/node, and inherits your model and account configuration.
- **Real-time sync**: every device sees the message stream and the list of online devices live; the working animation belongs to the conversation that is actually replying (other conversations are unaffected and immediately usable), and any new connection (page reload, another device) syncs the per-conversation busy state right away.
- **Mobile-first, desktop-aware**: a full-screen chat UI adapted to phone safe areas that widens its column and scales up type on laptops and desktops; no app installation required.

## Quick Start

Prerequisite: the Codex CLI is installed and logged in on your machine (`codex --version` and `codex login` work; model/account configuration is inherited from the local `~/.codex/config.toml`).

```bash
npm install
node server.js
```

On Windows you can also double-click `start.bat` (visible console; closing the window stops the service); `stop.bat` kills the process recorded in `server.pid`.

After starting:

- Local access: <http://localhost:3100>
- Other LAN devices: open `http://<本机IP>:3100` (e.g. `http://192.168.1.5:3100`; find the machine's IP on Windows with `ipconfig`)
- Public internet access: use a port-forwarding tool such as ngrok / frp to expose local port 3100
- **On first open** you will see the "create administrator account" page (when the system has no accounts yet); after creating it you are signed in automatically; from then on, every device must sign in with an account and password.

## Accounts and Login

- Account data is stored in `data/users.json` (passwords as scrypt salted hashes); session data is stored in `data/sessions.json` (valid for 7 days and preserved across service restarts).
- After login the browser holds an httpOnly session cookie; the chat WebSocket validates the session too, so nothing can be viewed or sent without signing in.
- **Administrator**: the first account created becomes the admin. From the chat page's "☰ Menu → User Management", the admin can:
  - Add users (username + password + optional display name);
  - Reset any user's password;
  - Delete users (deleted users are invalidated immediately);
  - Note: the admin cannot delete themselves, and newly added users are regular users.
- **Regular users**: can sign in to chat and change their own password (requires verifying the current password).
- If you forget the admin password: stop the service, delete `data/users.json`, and restart — you will go through the "create administrator" flow again (existing chat history is preserved in `data/conversation.json`).

## Configuration (config.json)

| Field | Default | Description |
|---|---|---|
| `port` | `3100` | Port to listen on |
| `host` | `0.0.0.0` | Listen address (`0.0.0.0` allows LAN access) |
| `cwd` | `D:\pythonitems` | Codex working root (local project root) |
| `model` | `null` | Codex model name; leave empty to use Codex's default configuration |
| `profile` | `null` | Codex profile name (`-p`, layers `~/.codex/<name>.config.toml`); leave empty to not use one |
| `profiles` | `[]` | Extra candidates for the web UI "Profile" dropdown (auto-scans `~/.codex/*.config.toml`) |
| `models` | `[]` | Candidate list for the web UI "Model" dropdown |
| `sandbox` | `danger-full-access` | Codex sandbox: `read-only` / `workspace-write` / `danger-full-access` |
| `bypassApprovals` | `true` | When true, skip approvals and execute commands directly (equivalent to fully automatic CLI mode) |
| `skipGitRepoCheck` | `true` | Allow running Codex outside a git repository |
| `turnTimeoutMs` | `0` | Per-turn reply timeout in milliseconds; `0` = unlimited (default) |
| `maxMessageLen` | `500` | Maximum length of a single message |
| `maxHistory` | `500` | Number of recent messages kept per conversation |
| `systemPrompt` | built-in | System prompt injected on a conversation's first turn; supports the `{cwd}` and `{codexHome}` placeholders |

The environment variables `PORT` and `HOST` override `config.json`.

Tip: drop a file such as `zcode.config.toml` into `~/.codex/` and it becomes directly selectable in the web menu's "Profile" dropdown, equivalent to `codex -p zcode` on the command line; pre-filling the `models` array in `config.json` adds candidates for profiles without a model catalog.

## How It Works

1. Any device sends a message → it is written to the active conversation's JSON and broadcast (a conversation is created automatically if none exists);
2. If Codex is idle, it runs `codex exec --json -C <cwd> --dangerously-bypass-approvals-and-sandbox` (first message of a conversation, injecting the system prompt + message) or `codex exec resume <thread_id> --json --dangerously-bypass-approvals-and-sandbox` (continuation; the sandbox flag must be passed explicitly every time, otherwise it falls back to the default read-only sandbox);
3. The server parses JSONL events: the `thread_id` from `thread.started` is persisted to the corresponding conversation (`data/conversations.json`); `command_execution` commands/output are broadcast in real time as `chat-process` so the frontend can show the execution process; replies are broadcast via Socket.io (whole Markdown plus process replay);
4. Within one conversation messages are processed strictly serially (first in, first out), while different conversations run on their own and never block each other; a turn ends on the CLI's `turn.completed` event (not on process exit, so a lagging process cannot leave the animation spinning); if resuming fails (session expired), a new thread is opened automatically for that conversation.

## Security Notes

- **With the default configuration, Codex can access and modify any file on the machine and execute any command** (equivalent to you using the Codex CLI in a terminal yourself), so anyone who can reach the port can make Codex act on your machine. **Use it only on trusted networks (home/office LAN)**; before exposing it to the public internet, be sure to add a reverse proxy + HTTPS + access control.
- Login only controls "who can use it" and does not change Codex's privilege level: a regular user, once signed in, can equally make Codex act on the machine. **Only give accounts to people you trust.**
- No self-registration: accounts can only be created by the admin, so strangers cannot sign up on their own.
- The service has no rate limiting; do not leave port 3100 open to the public internet long-term.
- Credentials such as API keys come from the local Codex configuration and are never sent down to the browser.
- To tighten permissions, set `sandbox` to `workspace-write` and `bypassApprovals` to `false` (Codex will then only be able to read/write the `cwd` directory, and operations requiring approval will fail with a message).

## Tech Stack

- Backend: Node.js + Express + Socket.io, data stored in local JSON files
- Frontend: single-file SPA (vanilla JS + CSS), zero third-party UI libraries
- Bridge: local Codex CLI in non-interactive mode (`codex exec` / `codex exec resume`), inheriting the entire `~/.codex` configuration and skills

## Directory Layout

```text
codex-chat/
├─ server.js       # 后端全部逻辑（REST + Socket.io + 账号鉴权 + Codex 桥接）
├─ index.html      # 前端全部逻辑（单文件）
├─ config.json     # 服务配置
├─ data/           # 运行时数据（不入库）：conversations.json / users.json / sessions.json
├─ test/           # 离线端到端测试（e2e.js + codex-stub.js，不消耗 API 额度）
├─ start.bat       # Windows 启动脚本
├─ stop.bat        # Windows 停止脚本
└─ package.json    # 依赖：express、socket.io；开发依赖：socket.io-client
```

## Development and Testing

Built-in offline end-to-end tests that consume no Codex/API quota and do not depend on a real Codex CLI:

```bash
npm install   # 含开发依赖 socket.io-client
npm test
```

The tests spin up a temporary service instance under `_test_temp/` with its own port and data directory (leaving the production service on port 3100 untouched), and replace the codex CLI via the `CCX_CODEX_JS` hook with the `test/codex-stub.js` stub script (faking `exec`/`resume`/`delete`/`--version` according to the JSONL protocol), covering 120 assertions across account and Socket authentication, multi-conversation management, JSONL event parsing, command process broadcasting, resume and failure fallback, message truncation, profile/model switching, conversation titles (AI summary + manual rename), persistence safety, running several conversations in parallel (one busy while another replies), ending a turn at `turn.completed`, stopping a running turn, session auto-renewal, and deletion cleanup.

## License

MIT
