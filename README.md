# Codex Chat

> **语言：** 简体中文 | [English](README.en.md)

自托管的 Codex 远程聊天：把本机安装的 Codex CLI 变成一个网页聊天服务。手机、平板、任意电脑在同一局域网（或经端口转发）下用浏览器即可与本机 Codex 对话，使用手感与直接使用 Codex CLI 一致。

## 设计原则：多对话 + 单线会话

每个对话对应一条独立的 Codex 会话（线程），同一时间只有一个对话处于活跃状态，所有设备共享当前活跃对话，就像直接与 Codex 对话一样：

- 任何设备发的消息都进入当前活跃对话对应的 Codex 会话，回复实时广播给所有在线设备；
- **可新建/切换/删除对话**：新建对话会开启一条全新的 Codex 线程；删除对话会同时清理对应的本地记录与 Codex 线程；
- Codex 使用本机默认配置（`~/.codex/config.toml`）运行，自动读取 `~/.codex/skills/` 下的技能（Skill），沿用你的既有使用习惯与偏好；
- 工作根目录是本机真实项目目录（默认 `D:\pythonitems`），Codex 可读写本机所有项目、文件与环境，与使用何种客户端无关；
- 会话持久化，服务重启后仍可继续（`codex exec resume` 续聊）。
- 回复以**打字机流式效果**逐步显示（当前 DeepSeek 提供方整段返回、CLI 无增量事件，故采用客户端渐进显示；代码已兼容未来的 delta 流式事件）。

## 功能

- **多对话管理**：新建、切换、删除对话，每个对话独立上下文与 Codex 线程。
- **单线会话**：同一时间只有一个活跃对话，多设备共享，像聊天一样连续追问、让 Codex 动手改本机文件。
- **流式显示**：Codex 回复以打字机效果逐步呈现，不再只是加载动画。
- **执行过程实时可见**：Codex 每执行一条命令都会实时显示命令、输出与退出码，过程文本同步展示，回合结束后可展开回放——不只看到结果，还能看到过程。
- **消息排队**：Codex 回复期间发送的消息自动排队，回复完成后依次处理，不会丢失。
- **无回复超时**：默认不限制回复时长（`turnTimeoutMs: 0`），长任务不会被中途掐断。
- **账号登录**：首次启动时创建管理员账号，之后所有使用必须登录；管理员可在界面中添加/删除用户、重置密码，普通用户可自行修改密码。密码以 scrypt 加盐哈希存储，不保存明文。
- **在线切换 API 与模型**：菜单面板中可切换配置档（Profile）与模型，全设备实时同步，选择持久化到 `config.json`，下一轮回复生效。配置档即 `~/.codex/*.config.toml`（如 `codex -p zcode` 叠加的 `zcode.config.toml`），自动扫描发现；模型候选自动读取当前配置的 `model_catalog_json`（默认档读 `~/.codex/config.toml` 指向的 `models.json`，zcode 档读 `zcode-models.json`）。API 完全由配置档决定：默认档沿用 `~/.codex/config.toml`，选 zcode 档即走 BigModel——不修改任何默认配置。
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
| `profile` | `null` | Codex 配置档名（`-p`，叠加 `~/.codex/<name>.config.toml`）；留空不使用 |
| `profiles` | `[]` | 网页端"配置档"下拉框的补充候选（自动扫描 `~/.codex/*.config.toml`） |
| `models` | `[]` | 网页端"模型"下拉框候选列表 |
| `sandbox` | `danger-full-access` | Codex 沙箱：`read-only` / `workspace-write` / `danger-full-access` |
| `bypassApprovals` | `true` | true 时跳过审批直接执行命令（等同 CLI 全自动） |
| `skipGitRepoCheck` | `true` | 允许在非 git 目录运行 Codex |
| `turnTimeoutMs` | `0` | 单轮回复超时（毫秒）；`0` = 不限制（默认） |
| `maxMessageLen` | `500` | 单条消息最大长度 |
| `maxHistory` | `500` | 会话保留最近消息数 |
| `systemPrompt` | 内置 | 会话首轮注入的系统提示词，可用 `{cwd}`、`{codexHome}` 占位符 |

环境变量 `PORT`、`HOST` 可覆盖 `config.json`。

提示：把 `zcode.config.toml` 这类文件放进 `~/.codex/`，网页菜单的"配置档"下拉框即可直接选择，等价于命令行 `codex -p zcode`；在 `config.json` 中预填 `models` 数组可为无模型目录的配置档补充候选。

## 工作原理

1. 任意设备发消息 → 写入当前活跃对话的 JSON 并广播（无对话时自动新建）；
2. 若 Codex 空闲，执行 `codex exec --json -C <cwd> --dangerously-bypass-approvals-and-sandbox`（对话首条，注入系统提示词 + 消息）或 `codex exec resume <thread_id> --json --dangerously-bypass-approvals-and-sandbox`（续聊，沙箱参数需每次显式重传，否则回落默认只读沙箱）；
3. 服务端解析 JSONL 事件：`thread.started` 里的 `thread_id` 持久化到对应对话（`data/conversations.json`）；`command_execution` 命令/输出实时广播 `chat-process` 供前端展示执行过程；回复经 Socket.io 广播（带流式标记与过程回放，前端打字机显示）；
4. 消息严格串行处理（先进先出）；若续接失败（会话失效）自动为该对话重开新线程。

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
├─ data/           # 运行时数据（不入库）：conversations.json / users.json / sessions.json
├─ test/           # 离线端到端测试（e2e.js + codex-stub.js，不消耗 API 额度）
├─ start.bat       # Windows 启动脚本
├─ stop.bat        # Windows 停止脚本
└─ package.json    # 依赖：express、socket.io；开发依赖：socket.io-client
```

## 开发与测试

内置离线端到端测试，不消耗任何 Codex/API 额度、不依赖真实 Codex CLI：

```bash
npm install   # 含开发依赖 socket.io-client
npm test
```

测试会在 `_test_temp/` 下用独立端口与独立数据目录拉起临时服务实例（不影响
3100 生产服务），并通过 `CCX_CODEX_JS` 钩子用 `test/codex-stub.js` 桩脚本替代
codex CLI（按 JSONL 协议伪造 `exec`/`resume`/`delete`/`--version`），覆盖账号与
Socket 鉴权、多对话管理、JSONL 事件解析、命令过程广播、resume 与失败回退、
消息截断、配置档/模型切换、持久化安全、删除清理等 76 项断言。

## License

MIT
