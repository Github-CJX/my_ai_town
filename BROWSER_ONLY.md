# 桌面浏览器私人服务器版

这个分支由用户提供的源码包精简而来：移除 Android、macOS、Windows 的原生 App 与 Rust Manager；保留 Node 管理服务、浏览器前端、Rust 世界内核、地图生成和内置模型功能。

## 安装与启动（Linux）

- Node.js >= 22.18 / pnpm 10.34.5 (Corepack)；Rust 1.88。
- `corepack pnpm install --frozen-lockfile`
- `cargo +1.88.0 build -p host --bins`（第一次移除 manager 后**不要**用 `--locked`，先重算 Cargo.lock）
- `corepack pnpm build`
- `AI_TOWN_HOME=/srv/ai-town-data TOWN_BIND=0.0.0.0 TOWN_ALWAYS_ON=1 TOWN_ONLY_RESIDENT=1 node scripts/start-client.mjs preview --port 8788`
- 只通过 Tailscale 等私人网络访问管理端口；正式暴露公网需 HTTPS 反代和防火墙。

**首次启动**：从本机安全网络进入页面创建管理员账号、创建或选定小镇、设置为常驻。`TOWN_ONLY_RESIDENT=1` 必须等常驻设置完再启用。

## 改动与兼容

- 浏览器 WebSocket 只接收带用户票据的 `/ws/:town` 地址；世界 HMAC 签票密钥只在 Node 代理和 Rust host 内部传输。世界 host 仅监听 127.0.0.1。
- 账号 Cookie 更换为随机会话令牌（旧版可伪造的账号 ID Cookie **不再接受**）。升级后需要重新用密码登录。
- 删除/重置需管理员，关镇需登录且必须携带有效 lease。
- 点击走路每 100ms 续传方向，避免等服务端状态期间超过 350ms 导致停顿。
- AI 村民缓冲从 200ms 增加到 350ms：减少快照晚到时原地停顿，代价是 NPC 视觉位置稍晚。
- 进入控制命令超时不自动创建第二个化身，提供手动重试。

## 测试

`node --test scripts/tests/account-session.test.mjs` 可独立测试账号会话；完整测试需要先安装依赖与编译 Rust host：`corepack pnpm typecheck && corepack pnpm test && cargo +1.88.0 test --workspace`。

本改动没有改变已有存档结构。但升级前请备份 `AI_TOWN_HOME`，特别是其中的 `accounts.json`、`towns/`、`users/`。

## OpenCode Go 模型服务

模型服务里已移除 OpenCode Zen、302.AI 的**预设项**，新增 **OpenCode Go**（`opencode-go`）。
Go 使用 `https://opencode.ai/inference/go/openai/v1`；世界内核自动设置 `x-opencode-session`（每位居民的会话独立且稳定）。
在设置中填入你自己 Go/Go Plus 订阅对应的 API Key，先测试再选择模型。默认模型为 `glm-5.3-flash`；可用模型会随平台调整。

**迁移说明：** 已经写进存档/账号配置的旧 `opencode` 或 `302-ai` 记录不会因前端移除预设自动删除，也**不会自动挪用旧密钥**。如果曾经使用这两项，先把居民和默认模型换到新的 Go（或其他服务），再从自己的配置文件中清理旧记录与密钥，并备份存档。Go 订阅的工作区及允许用途请以官方条款为准；不要把一人的密钥在朋友之间散发。

反向代理用域名时，请设置 `TOWN_ALLOW_HOST=your.example.com`。不能依赖 `x-forwarded-*` 伪造的信任；默认本机监听不接受陌生 Host。

## 小镇回收站

删镇与重置现在不再立即永久删除目录，而是移动到 `AI_TOWN_HOME/towns/.trash/`。
恢复时先停止管理服务，再把对应目录移动回 `AI_TOWN_HOME/towns/<小镇ID>`。
注意：回收站会持续占用空间，需要定期由管理员手动归档或清理，不能替代异机备份。
