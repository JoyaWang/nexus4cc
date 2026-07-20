# PRD — Nexus AI 终端面板 **(v1 Complete / 已完成)**

**版本**: v1.0.0  **状态**: Complete  **锚点**: `docs/NORTH-STAR.md`  **完成日期**: 2026-04-01  **更新**: 2026-07-20（v2 双 token 认证规格）

---

## Problem Statement

开发者需要一个统一入口，让 AI Agent 能在任意项目目录中持续运行，并能在 PC、手机、IM 等任意渠道随时介入——现有工具（ttyd、SSH）在移动端控制字符输入残缺，且缺乏针对 AI Agent 生命周期的管理界面和异步交互能力。

---

## Target Users

**用户即开发者本人**（单用户/个人服务器）
- 同时跑多个 Claude Code Agent，需要随时从任意设备查看进度、发送指令
- 外出时通过手机/Telegram 给 AI 下任务，回家后在 PC 上接续
- 不想保持 SSH 连接，关掉浏览器后 Agent 继续运行

---

## Core Features

### Must（v1 Complete）

| ID | Feature | 验收标准 |
|---|---|---|
| F-01 | WebSocket tmux 桥接 | 浏览器关闭后 tmux 和 Agent 继续运行；重新打开可接续 |
| F-02 | JWT 单密码认证 | 密码 bcrypt hash 存 env，Token 30天有效 |
| F-03 | xterm.js 终端渲染 | 256色/TrueColor/Unicode；scrollback 10000行 |
| F-04 | 移动端控制字符工具栏 | 可发送 Esc/Tab/Ctrl+C/方向键等；触摸不弹软键盘 |
| F-05 | 移动端滚动与缩放 | 单指滑动浏览历史；双指捏合调字号（8–32px） |
| F-06 | Session 管理 API | `POST/GET/DELETE /api/sessions`；tmux 新建/切换/关闭 window |
| F-07 | 工具栏服务端持久化 | 配置存 `data/toolbar-config.json`（volume），跨设备共享 |
| F-08 | PWA 支持 | manifest.json + Service Worker，可添加主屏幕 |
| F-12 | claude -c 会话续接 | 自动检测 `.claude-data/.claude`，`claude -c` 续接历史会话 |

### Should（v1 Complete）

> 对应北极星「轴三：极致 Agent 管理体验」

| ID | Feature | 验收标准 |
|---|---|---|
| F-09 | Tab Bar UI | 顶部实时显示所有 tmux window，点击切换，活跃 tab 高亮 |
| F-10 | 移动端底导航 | 底部 Tab 快速切换 window，支持新建；覆盖顶部 Tab Bar |
| F-11 | 独立 window PTY | `ensurePty(windowId)` Map；`/ws?window=N` 多设备不互扰 |
| F-15 | Agent 状态卡片 | 每个 window 显示最后输出摘要（是否在跑/是否等待输入） |

### Could（v1 Complete）

> 对应北极星「轴二：零摩擦上下文同步」——不限于浏览器终端的交互渠道

| ID | Feature | 场景 |
|---|---|---|
| F-13 | `claude -p` 非交互派发 | 发一条 prompt，AI 在后台处理，前端显示结果卡片；不占用交互 PTY |
| F-14 | 上下文附件同步 | 在移动端将图片/文件/文本片段发送给指定 Agent session |
| F-16 | Telegram Bot 频道 | 外出时在 Telegram 给 AI 下任务，结果回传聊天；调用 `/api/tasks` |
| F-17 | 多输入渠道统一路由 | 任意渠道（Web/IM/CLI）的 prompt 统一进入 task 队列，结果同步回发起方 |

### Nice（v4：直觉化项目管理）

> 对应北极星「轴一：零配置启动」——消灭一切不必要的决策步骤

| ID | Feature | 验收标准 |
|---|---|---|
| **F-19** | **项目-窗口两级结构** | **项目 = 目录，窗口 = 同目录标签**。新建项目时选目录；新窗口自动继承当前目录；消灭「每次新建都要选目录」的重复操作 |
| **F-20** | **统一会话管理界面** | **借鉴 Slack Workspace/Channel 模式**：项目列表（下部）+ 窗口列表（上部），新建按钮分区放置，视觉层次清晰 |

---

## Feature Detail: v3 非交互派发（F-13/F-16/F-17）

```
POST /api/tasks
  body: { session_name, prompt, attachments? }
  → spawn claude -p "<prompt>" --cwd <session.cwd>
  → 流式 SSE 返回结果
  → 前端结果卡片（不占用交互 PTY）
  → 同步回发起方渠道（Web / Telegram / ...）

POST /api/webhooks/telegram
  → 解析消息 + 附件（图片/文件）
  → 调用 POST /api/tasks
  → 结果回传 Telegram 对话
```

**设计原则**：任务派发与交互终端解耦——交互 PTY 继续用于实时 claude 对话，tasks API 用于异步一次性任务，两者共存，各司其职。

---

## Feature Detail: 项目-窗口两级结构（F-19）

**问题**：当前每次新建 window 都要选目录，而用户心智模型是「项目=目录，窗口=同目录下的多个标签」。

**解法**：利用 tmux session 环境变量存储项目目录，实现「新建项目选目录，新建窗口自动继承」。

```
POST /api/windows
  body: { rel_path?, shell_type?, profile? }

  场景 1 - 新项目（提供 rel_path）:
    → tmux set-environment NEXUS_CWD <dir>
    → tmux new-window -c "$dir"

  场景 2 - 新窗口（不提供 rel_path）:
    → cwd=$(tmux show-environment NEXUS_CWD | cut -d= -f2)
    → tmux new-window -c "$cwd"
```

**交互**：
- Sidebar 「+」按钮拆分为二级菜单：「📁 新项目」/「➕ 新窗口」
- 「新项目」→ 弹出 WorkspaceSelector 选目录
- 「新窗口」→ 直接创建，继承当前项目目录

**心智模型**：
- 项目 = 目录（首次需要指定）
- 窗口 = 同目录下的多个终端标签（自动继承目录）

---

## Feature Detail: 统一会话管理界面（F-20）

**核心映射**：直接使用 tmux 原生概念，前端映射更易理解
- **tmux session** → **Project**（工作目录，环境隔离）
- **tmux window** → **Channel**（终端标签，共享目录）

**设计灵感**：Slack 的 Workspace/Channel 两层导航结构
- Channel 列表（上部）：当前 Project 下的多个终端窗口
- Project 列表（下部）：不同的工作目录（每个对应一个 tmux session）

### 界面布局

```
┌─────────────────────────────┐
│  会话管理              [×]   │
├─────────────────────────────┤
│                             │
│  📂 nexus ~/work/nexus      │  ← 标题：当前 Project 名+路径
│  ─────────────────────────  │
│  #general        ●         │  ← Channel 列表（tmux windows）
│  #backend        ○         │
│  #test          ⏳         │
│                             │
│  [+ 新 Channel]            │  ← 在下方，靠近 Channel 列表
│                             │
│  ═════════════════════════  │  ← 粗分隔线
│                             │
│  📁 Projects               │
│  ● nexus           (3)     │  ← Project 列表（tmux sessions）
│  ○ my-app          (1)     │
│  ○ backend-api     (2)     │
│                             │
│  [+ 新 Project]            │  ← 在下方，靠近 Project 列表
│                             │
└─────────────────────────────┘
```

### 关键设计决策

| 概念 | 对应 | 说明 |
|------|------|------|
| Project | tmux session | 每个 session 独立环境变量，有自己的 NEXUS_CWD |
| Channel | tmux window | 同 session 内的多个窗口，共享工作目录 |
| 激活态 | active session/window | 高亮显示当前所在的 project 和 channel |

### 状态指示

```
Channel 列表项（带 # 前缀）：
  #general      ●    ← 绿色点 = 运行中
  #backend      ○    ← 灰色点 = 空闲
  #deploy      ⏳    ← 黄色点 = 等待输入
  #shell       💤    ← 灰色 = shell 状态

Project 列表项：
  ● nexus      (3)   ← 蓝色高亮 = 当前激活，(3)=3个channel
  ○ my-app     (1)   ← 未激活，有1个channel
  ○ backend-api (2)  ← 未激活，有2个channel
  ○ legacy          ← 无括号 = 该session没有窗口（异常）
```

### API 设计（简化版）

```
GET  /api/projects                → 列出所有 tmux sessions（Project 列表）
GET  /api/projects/:name/channels → 列出指定 session 的所有 windows（Channel 列表）

POST /api/projects                → 新建 Project
  body: { name, path, shell_type, profile? }
  → tmux new-session -d -s <name> -c <path>
  → tmux set-environment NEXUS_CWD <path>

POST /api/projects/:name/channels → 新建 Channel
  body: { shell_type, profile? }
  → 在当前 session 内 tmux new-window -c "$NEXUS_CWD"

POST /api/projects/:name/activate → 切换到指定 Project
  → 切换 active tmux session（attach-client 或设置 target）

POST /api/channels/:index/attach  → 切换到指定 Channel（已有接口）
DELETE /api/channels/:index       → 关闭 Channel（已有接口）
```

### 交互流程

**1. 新建 Project**
```
点击「+ 新 Project」
  → 弹出 WorkspaceSelector 选择目录
  → 用户输入 Project 名称（默认目录名）
  → POST /api/projects { name: "my-app", path: "/home/libra/work/my-app" }
  → tmux new-session -d -s my-app -c /home/libra/work/my-app
  → tmux set-environment -t my-app NEXUS_CWD /home/libra/work/my-app
  → 在该 session 创建第一个 window（自动命名为 #general 或目录名）
  → 自动切换到新 Project（Project 列表更新，Channel 列表加载）
```

**2. 新建 Channel**
```
点击「+ 新 Channel」
  → 检查当前是否有激活 Project
  → POST /api/projects/:name/channels { shell_type, profile }
  → 在当前 session 内创建新 window
  → 自动继承该 session 的 NEXUS_CWD
  → Channel 列表更新，自动切换到新 Channel
```

**3. 切换 Project**
```
点击 Project 列表中的某项
  → 设置该 session 为 active
  → Channel 列表区域刷新：显示该 Project 的所有 Channel
  → 自动切换到该 Project 的 active window（或第一个 window）
  → 终端 WebSocket 重连到新的 session:window
```

**4. 切换 Channel**
```
点击 Channel 列表中的某项
  → POST /api/channels/:index/attach
  → 同现有行为：切换到该 window
```

### Channel 命名规则

```
第一个 Channel（创建 Project 时）：
  - 默认：目录名（如 nexus）
  - 或：#general

后续 Channels：
  - 默认：目录名-序号（如 nexus-1, nexus-2）
  - 用户可重命名（重命名 tmux window）
```

### 空状态处理

**无任何 Project 时：**
```
Channel 列表区域：
  「没有活跃的 Project」

Project 列表区域：
  「暂无 Projects」
  [+ 创建第一个 Project]
```

**当前 Project 无 Channel（异常情况）：**
```
Channel 列表区域：
  "📂 nexus ~/work/nexus"
  「该 Project 没有 Channel」
  [+ 创建第一个 Channel]
```

### 向后兼容

- 现有 tmux session 直接显示为 Projects（name 作为 project name）
- 现有 windows 显示为 Channels
- 首次打开界面时，为当前 session 尝试读取 NEXUS_CWD
  - 如果未设置，提示用户「为当前 Project 设置工作目录」
  - 或自动设置为 WORKSPACE_ROOT

### 视觉设计

```css
/* Channel 列表区域（上部）*/
- 标题栏："📂 {project.name} {cwd路径}"（cwd 用灰色小字）
- Channel 项："#{name}" 前缀（Slack 风格）
- 状态点：跟在名字后面
- +按钮：在区域底部，样式与列表项对齐

/* Project 列表区域（下部）*/
- 标题栏："📁 Projects"
- 背景：var(--nexus-bg2) - 稍暗，与 Channel 区形成层次
- Project 项：简洁显示，名称 + 右侧 channel 计数
- +按钮：在区域底部

/* 分隔线 */
- Channel 区标题下：1px solid var(--nexus-border)
- 两区域之间：2px solid var(--nexus-border)
```

### 数据结构（前端状态）

```typescript
// 不再需要独立的 projects.json
// 直接从 tmux 读取

interface Project {
  name: string;           // tmux session name
  path: string;           // NEXUS_CWD (tmux show-environment)
  active: boolean;        // 是否是当前 active session
  channelCount: number;   // window 数量
}

interface Channel {
  index: number;          // tmux window index
  name: string;           // tmux window name
  active: boolean;        // 是否是该 session 的 active window
  status: 'running' | 'idle' | 'waiting' | 'shell'; // 状态推断
}
```

---

## Success Metrics

| Metric | Target |
|---|---|
| 移动端 Esc/Ctrl+C 发送成功率 | 100% |
| 浏览器重连后终端恢复时间 | < 2s |
| 工具栏配置跨设备同步 | 重连后自动加载 |
| 从 Telegram 发出 prompt 到收到首个 token | < 5s |
| PWA 添加主屏并可用 | iOS Safari / Android Chrome |

---

## v2 Feature: access/refresh 双 token 认证（代码与自动化完成，未部署）

> **状态**: 服务端、内置 Web 前端与自动化已完成；运行中的 Nexus4CC 尚未部署此版本。`npm test` 98/98、前端 `tsc && vite build` 已通过；仍需 preview 兼容与真实客户端生命周期验收。

### 背景

v1 使用单一 30 天 JWT `token`，无过期后自动续期能力，无服务端撤消能力。v2 升级为标准双 token 模式，保持单用户语义不变。

### 概要

- **accessToken**: JWT，有效期 15 分钟，含 `sub`（用户标识）、`jti`（唯一 ID）
- **refreshToken**: 不透明随机字符串（crypto.randomBytes），服务端只存 `sha256` 哈希，有效期 90 天
- **Refresh rotation**: 每次使用 refresh token 换新时，同时返回新的 accessToken 和新的 refreshToken，旧 refresh token 作废
- **Revoke**: 客户端可主动撤销 refresh token（登出）
- **Reuse detection**: 若某 refresh token 已被使用后再被使用（被轮换后旧值重放），撤销该 token 的整个 family 中所有未失效 token
- **单用户语义**: login 仍为密码验证，无注册/多用户/角色概念

### API 请求/响应

#### POST /api/auth/login

```
请求: { password: "<cleartext>" }
```

成功响应 (200):
```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<opaque>",
  "expiresIn": 900,
  "token": "<jwt>"
}
```

- `token` 字段与 v1 向后兼容，值与 `accessToken` 相同
- `expiresIn` 为 access token 剩余有效秒数（900 = 15min）
- 失败: 401 `{ error: "invalid_password" }`

#### POST /api/auth/refresh

```
请求: { refreshToken: "<opaque>" }
```

成功响应 (200):
```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<opaque>",
  "expiresIn": 900,
  "token": "<jwt>"
}
```

- 返回全新的 accessToken + refreshToken 对
- 旧 refreshToken 及其 family 中已使用的 token 一并失效
- 若 refreshToken 之前已被使用（reuse detection），触发 family 撤销，返回 401 `{ error: "token_reused", message: "Refresh token reuse detected; all sessions revoked" }`
- refreshToken 过期返回 401 `{ error: "invalid_refresh_token" }`

#### POST /api/auth/revoke

```
请求: { refreshToken: "<opaque>" }
```

成功响应 (200):
```json
{ "message": "token_revoked" }
```

- 撤销指定的 refresh token（登录时需传此值用于撤消）
- 不要求 Bearer accessToken；access token 可能已过期，refreshToken body 本身是撤销凭据
- 空 body 返回 400，不提供无法兑现的 Bearer-only 假成功路径
- 用于登出场景

### 令牌结构

#### accessToken（JWT payload）

```json
{
  "sub": "nexus-user",
  "jti": "<uuid>",
  "iat": 1720000000,
  "exp": 1720000900
}
```

- `sub` 固定为 `nexus-user`（单用户，无 user ID 概念）
- `jti` 为 uuid v4，每次颁发新 access token 时生成
- `exp - iat = 900`（15 分钟）
- 签名算法: HS256，key 为 `JWT_SECRET` env

#### refreshToken（opaque）

- `crypto.randomBytes(48).toString('base64url')`，约 64 字符
- 不存原始值，只存 `sha256` 哈希
- 与 access token 无结构耦合（不嵌 JWT）

### 持久化

#### 文件路径

`data/auth/refresh-tokens.json`

#### Schema

```json
{
  "families": {
    "<familyId>": {
      "tokens": {
        "<sha256(token)>": {
          "status": "active" | "used" | "revoked",
          "createdAt": "<ISO8601>",
          "expiresAt": "<ISO8601>"
        }
      },
      "status": "active" | "revoked"
    }
  }
}
```

- `familyId`: 每次 login 生成一个新的 family（uuid v4），同一次 login 通过 refresh rotation 产生的子 token 属于同一 family
- `status = "used"`: token 已被成功用来换新一次（标记后不可再次使用）
- `status = "revoked"`: 显式撤销或 reuse detection 触发的撤销
- `family.status = "revoked"`: 整个 family 被撤销（reuse detection 结果）

#### 原子写与权限

- 每次写入使用临时文件 `data/auth/refresh-tokens.json.tmp` → `fs.rename(tmp, target)` 保证原子性
- 新文件权限 `0o600`（仅 owner 读写）
- 启动时若 `data/auth/` 目录不存在则自动创建（`mkdirSync` with `0o700`）

#### 清理

- 启动时扫描：删除所有已过期（`expiresAt < now`）且非 `active` 的 token entry
- 启动时扫描：若 family 的 `status` 为 `revoked` 且其所有 token 均已过期，移除整个 family entry
- 运行时每次 refresh 操作后：对当前 family 执行上述清理

### 认证边界

#### REST API

- `POST /api/auth/login` — 无 Auth header
- `POST /api/auth/refresh` — 无 Auth header（用 refreshToken body 认证）
- `POST /api/auth/revoke` — 无 Auth header；必须使用 refreshToken body
- 其他所有 `/api/*` — Bearer `<accessToken>`（同 v1，只是 token 有效期从 30d 变为 15min）

#### WebSocket

- 连接 URL: `wss://host/ws?token=<accessToken>`（同 v1）
- accessToken 过期后 WebSocket 连接不会主动断开；前端应在 ws onclose 时自动 refresh → 新 accessToken → 重连
- 不支持通过 refreshToken 建立 WebSocket 连接

### 环境变量

#### 新增

| 变量 | 必须 | 默认 | 说明 |
|---|---|---|---|
| `ACCESS_TOKEN_EXPIRY_SECONDS` | | `900` | access token 有效期（秒），默认 15 分钟 |
| `REFRESH_TOKEN_EXPIRY_DAYS` | | `90` | refresh token 有效期（天） |

#### 现有变量不变

- `JWT_SECRET` 继续用于 accessToken JWT 签名
- `ACC_PASSWORD_HASH` 继续用于 login 密码验证

### 迁移兼容

- v1 的单一 30d JWT 登录 cookie/流程将被双 token 替换
- **前端平滑迁移**: login 接口响应新增字段 `refreshToken`，旧客户端忽略新字段即可；`token` 字段保留，旧客户端继续使用（但过期时间变为 15min，需通过 401 响应触发重新登录）
- **数据迁移**: 首次启动时 `data/auth/` 目录自动创建；无旧数据需迁移
- **env 兼容**: 现有 `.env` 无需改动；`JWT_SECRET` 和 `ACC_PASSWORD_HASH` 继续有效

### 前端配合（已实现，未部署）

- 登录成功后存储 `accessToken`（同 v1 `token`）和 `refreshToken` 到 localStorage
- 所有 API 请求检测 401 → 自动 `POST /api/auth/refresh` → 重试原请求
- REST 401 通过 single-flight refresh 后精确重放一次；WebSocket 4001 refresh 后用新 access token 重连
- 登出时调用 `POST /api/auth/revoke` 清理 refresh token
- WebSocket `onclose` 事件中自动 refresh → 新 token → 重连
- Web 端因浏览器架构使用 localStorage 保存 access/refresh pair；这不等同于原生 Keychain，XSS 风险必须通过同源部署、CSP与依赖治理控制。MoCode原生客户端使用Keychain/Keystore，仅持久化refresh token。

### 安全属性

| 属性 | 实现 |
|---|---|
| accessToken 短寿命 | 15min JWT，过期不可续 |
| refreshToken 不可猜测 | crypto.randomBytes(48) |
| 服务端不存原始 token | 只存 sha256 哈希 |
| 原子写入防损坏 | tmp file + rename |
| 文件权限隔离 | 0600 / 0700 |
| 重放攻击防护 | reuse detection → family 撤销 |
| 持久化文件不暴露 | data/auth/ 目录不应在 web 路由中可访问；server.js 应显式拒绝 `/api/auth/refresh-tokens` 路径 |

### 测试 / 验收

| 场景 | 预期 |
|---|---|
| 正常 login | 返回 accessToken + refreshToken + token + expiresIn |
| 用 accessToken 调用受保护 API | 200 |
| accessToken 过期后调用 API | 401 → client refresh → 重试成功 |
| 用 refreshToken 调用 /api/auth/refresh | 200，返回全新的 access + refresh 对 |
| 重复使用同一个 refreshToken | 第一次 200；第二次 401 `token_reused`；family 下所有 token 失效 |
| 用已撤销的 refreshToken 调用 refresh | 401 `invalid_refresh_token` |
| revoke 后 refresh | 401 |
| refreshToken 过期（>90d 未用）| 401 `invalid_refresh_token` |
| 启动时 data/auth/ 不存在 | 自动创建 |
| 启动时清理过期 token | 过期 token entry 被删除 |
| WebSocket 使用 accessToken | 连接成功 |
| 旧客户端只读 token 字段 | 仍可工作（15min 后需重登录） |

### 明确不做

- 不做多 user / 多 session 并发管理（仍然是单用户）
- 不做 refreshToken 的 scope / audience 限定
- 不做 PKCE / OAuth 2.0 完整流程
- 不做 token introspection endpoint（RFC 7662）
- 不在 accessToken 的 JWT 中编码用户权限（单用户无权限差异）
- 不做 refreshToken cookie-based httpOnly 模式（保持 Bearer token 一致）

---

## Out of Scope

- 多用户/团队功能、注册系统、权限管理
- 替换 tmux（持久化/scrollback 继续由 tmux 负责）
- 通用 Web SSH 工具（不针对 claude CLI 工作流的功能不做）
- Session 数据库（JSON 文件 + tmux 实时读取）
- Docker socket 暴露给前端

---

## Known Limitations（v1）

| 问题 | 影响 | v2 解法 |
|---|---|---|
| 多客户端 resize 冲突 | 多设备同时连接时 PTY 尺寸以最后收到的为准 | 取最小尺寸策略 + Phase 2 `resizeMode=passive` 隔离移动端 |
| 单 PTY 全局切换 | window 切换所有设备同步跳转 | 独立 window PTY Map（F-11） |
| claude 配置未挂载 | 容器内 claude 使用镜像内配置，非宿主机配置 | docker-compose volumes 增加挂载 |
| 文件权限 | 容器 claude UID ≠ 宿主机 UID 时写文件失败 | Dockerfile usermod -u 1000 |
