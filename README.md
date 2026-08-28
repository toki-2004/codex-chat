# Codex Chat

自托管的 Codex 远程聊天：把本机安装的 Codex CLI 变成一个网页聊天服务。手机、平板、任意电脑在同一局域网（或经端口转发）下用浏览器即可与本机 Codex 对话，使用手感与直接使用 Codex CLI 一致。

## 设计原则：单线会话

客户端与服务端的 Codex 之间只有**一条会话**，就像直接与 Codex 对话一样：

- 任何设备发的消息都进入同一条 Codex 会话（线程），回复实时广播给所有在线设备；
- Codex 使用本机默认配置（`~/.codex/config.toml`）运行，自动读取 `~/.codex/skills/` 下的技能（Skill），沿用你的既有使用习惯与偏好；
- 工作根目录是本机真实项目目录（默认 `D:\pythonitems`），Codex 可读写本机所有项目、文件与环境，与使用何种客户端无关；
- 会话持久化，服务重启后仍可继续（`codex exec resume` 续聊）。

## 功能

- **一条 Codex 会话**：多设备共享同一对话上下文，像聊天一样连续追问、让 Codex 动手改本机文件。
- **账号登录**：首次启动时创建管理员账号，之后所有使用必须登录；管理员可在界面中添加/删除用户、重置密码，普通用户可自行修改密码。密码以 scrypt 加盐哈希存储，不保存明文。
- **与 CLI 一致的能力**：读取 Skill、遵循 AGENTS.md/HANDOVER.md 约定、使用 git/gh/node 等本机工具、沿用你的模型与账号配置。
- **实时同步**：所有设备实时看到消息流与在线设备列表，Codex 忙碌时显示打字指示。
- **移动端优先**：全屏聊天界面，适配手机安全区，无需安装任何 App。

## 快速开始

前置条件：本机已安装并登录 Codex CLI（`codex --version`、`codex login` 可用即可；模型/账号配置继承自本机 `~/.codex/config.toml`）。

```bash
npm install
node server.js
```

Windows 下也可直接双击 `start.bat`（可见控制台，关闭窗口即停服）；`stop.bat` 按 `server.pid` 结束进程。

启动后：

- 本机访问：<http://localhost:3100>
- 局域网其他设备：访问 `http://<本机IP>:3100`（例如 `http://192.168.1.5:3100`；Windows 查看本机 IP：`ipconfig`）
- 公网访问：配合 ngrok / frp 等端口转发工具把本地 3100 端口映射出去
- **首次打开**会看到"创建管理员账号"页面（系统尚无账号时），创建后自动登录；之后所有设备都需输入账号密码登录。

## 账号与登录

- 账号数据保存在 `data/users.json`（密码为 scrypt 加盐哈希），会话数据保存在 `data/sessions.json`（有效期 7 天，服务重启后仍有效）。
- 登录后浏览器持有 httpOnly 会话 Cookie，聊天 WebSocket 同样校验会话，未登录无法查看/发送任何消息。
- **管理员**：首个创建的账号即为管理员。管理员可在聊天页「☰ 菜单 → 用户管理」中：
  - 添加用户（账号 + 密码 + 可选显示名）；
  - 重置任意用户的密码；
  - 删除用户（被删用户立即失效）；
  - 注意：管理员不能删除自己，新添加的用户都是普通用户。
- **普通用户**：可登录聊天、修改自己的密码（需验证当前密码）。
- 忘记管理员密码时：停止服务，删除 `data/users.json` 后重启，会重新进入"创建管理员"流程（原聊天记录保留在 `data/conversation.json`）。

## 配置（config.json）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `3100` | 监听端口 |
| `host` | `0.0.0.0` | 监听地址（0.0.0.0 允许局域网访问） |
| `cwd` | `D:\pythonitems` | Codex 工作根目录（本机项目根） |
| `model` | `null` | Codex 模型名；留空使用 Codex 默认配置 |
| `sandbox` | `danger-full-access` | Codex 沙箱：`read-only` / `workspace-write` / `danger-full-access` |
| `bypassApprovals` | `true` | true 时跳过审批直接执行命令（等同 CLI 全自动） |
| `skipGitRepoCheck` | `true` | 允许在非 git 目录运行 Codex |
| `turnTimeoutMs` | `900000` | 单轮回复超时（毫秒，默认 15 分钟） |
| `maxMessageLen` | `500` | 单条消息最大长度 |
| `maxHistory` | `500` | 会话保留最近消息数 |
| `systemPrompt` | 内置 | 会话首轮注入的系统提示词，可用 `{cwd}`、`{codexHome}` 占位符 |

环境变量 `PORT`、`HOST` 可覆盖 `config.json`。

## 工作原理

1. 任意设备发消息 → 服务端写入会话 JSON 并广播；
2. 若 Codex 空闲，执行 `codex exec --json -C <cwd> --dangerously-bypass-approvals-and-sandbox`（首次，注入系统提示词 + 消息）或 `codex exec resume <thread_id> --json --dangerously-bypass-approvals-and-sandbox`（续聊，沙箱参数需每次显式重传，否则回落默认只读沙箱）；
3. 服务端解析 JSONL 事件，`thread.started` 里的 `thread_id` 持久化到 `data/conversation.json`，回复经 Socket.io 广播给所有设备；
4. 消息严格串行处理（先进先出），保证单线会话不冲突；若续接失败（会话失效）自动重开新线程。

## 安全说明

- **默认配置下 Codex 可访问并修改本机任意文件、执行任意命令**（等同你本人在终端使用 Codex CLI），任何能访问该端口的人都能让 Codex 在本机做事。**请仅在可信网络（家庭/办公局域网）使用**，公网暴露前务必加反代 + HTTPS + 访问控制。
- 登录只控制"谁能使用"，不改变 Codex 的权限等级：普通用户登录后同样能让 Codex 在本机做事。**只把账号交给信任的人。**
- 无注册入口：账号只能由管理员创建，杜绝陌生人自助注册。
- 服务无限流；不要长期对公网开放 3100 端口。
- API 密钥等凭据沿用本机 Codex 配置，不会下发到浏览器。
- 如需收紧权限，可把 `sandbox` 改为 `workspace-write`、`bypassApprovals` 改为 `false`（此时 Codex 只能读写 `cwd` 目录，且需要审批的操作会失败并提示）。

## 技术栈

- 后端：Node.js + Express + Socket.io，数据存本地 JSON 文件
- 前端：单文件 SPA（原生 JS + CSS），零第三方 UI 库
- 桥接：本机 Codex CLI 非交互模式（`codex exec` / `codex exec resume`），沿用 `~/.codex` 全部配置与技能

## 目录结构

```text
codex-chat/
├─ server.js       # 后端全部逻辑（REST + Socket.io + 账号鉴权 + Codex 桥接）
├─ index.html      # 前端全部逻辑（单文件）
├─ config.json     # 服务配置
├─ data/           # 运行时数据（不入库）：conversation.json / users.json / sessions.json
├─ start.bat       # Windows 启动脚本
├─ stop.bat        # Windows 停止脚本
└─ package.json    # 依赖：express、socket.io
```

## License

MIT
