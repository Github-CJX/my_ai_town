# 浏览器精简版：安全与移动问题审查报告

审查输入：用户上传的 `my_ai_town-main (2).zip`，非远端 `main` 的自动同步镜像。日期：2026-11-12。

**产物范围**：修改了 39 个原文件、移除 62 个原文件（主要为原生平台），另新增文档、回归测试；保留浏览器前端、Node 管理服务、Rust Host/Kernel/Agent/Protocol、地图、生成器和用户存档格式。删除目录：`android/`, `macos/`, `windows/`, `crates/manager/`, `scripts/android/`, `scripts/macos/`, `scripts/windows/`。

## 1. 已修改的高风险漏洞

| 优先级 | 问题 | 修改位置 | 处理方式 |
|---|---|---|---|
| 高 | `town_user` 直接使用公开账号 ID，可伪造管理员身份 | `scripts/towns/accounts.mjs` | 使用 256 位随机 Session Cookie；文件只保存令牌 SHA-256 摘要、过期时间；PIN 修改/管理员重置撤销旧登录态。原账号 ID 和 PIN 哈希继续有效，旧 Cookie **不再有效**。 |
| 高 | 世界 HMAC 签票密钥在 WebSocket URL 下发给浏览器 | `scripts/towns/hosts.mjs`, `scripts/towns/town-routes.mjs`, `scripts/town-manager.mjs` | 浏览器只得到 `/ws/<id>?ticket=...`；管理服务代理在内网转发时注入 `session` 密钥，Rust Host 仅绑定回环地址。 |
| 高 | `/delete`、`/reset` 路由遗漏管理员认证；`/close` 可无 lease 关闭 | `scripts/towns/town-routes.mjs` | 删除/重置仅管理员；关镇需要登录和有效 lease，常驻镇仍不可随意关。 |
| 中 | `/health` 回传了不应公开的完整用户内容（含 PIN 摘要） | `scripts/town-manager.mjs` | 返回脱敏的 `publicUser` 字段，回归测试覆盖。 |
| 中 | 通过伪造 `x-forwarded-*` 头绕过 Host 检查 | `scripts/town-manager.mjs` | 不凭 forwarded 头放行；若通过域名反代，必须显式设置 `TOWN_ALLOW_HOST`。 |
| 中 | 删除/重置小镇永久递归移除数据 | `scripts/towns/storage.mjs` | 改为移动到 `AI_TOWN_HOME/towns/.trash/`，可人工恢复；仍需异地备份和手动清理回收站。 |

## 2. 三个移动/化身故障

### 2.1 化身点击地图走路时抖动 / 停顿

**静态证据**：服务端方向输入 350ms 后会过期，而 `frontend/town-shared/src/avatar/walkTo.ts` 原先只在收到状态时重发方向；网络突发延迟或主线程暂停超过 350ms 会停走。本地预测随后与服务端位置校正产生抖动。**改动**：`walkTo.ts` 记录最后行走方向，`navigation.ts` 每 100ms 独立续发；不在定时器中重复执行寻路/卡住判断，避免重规划风暴。WASD 原有输入逻辑保留。

**未验证**：弱网条件下的实际位置校正收敛、入口碰撞等，需要真人浏览器测试。

### 2.2 Agent 村民走路偶发“卡一下”

**静态证据**：`frontend/town-2d/src/map/hd2d/villagers.ts` 使用 PlaybackClock 与服务端名册插值；原缓冲 200ms，在 200ms 以上到货抖动时有耗尽风险。原 `crates/host/src/persistence/writer.rs` 已使用独立保存写入器，不能直接断定是“保存阻塞内核”。**改动**：插值缓冲从 200→350ms，重同步阈值 600→900ms；`frontend/town-2d/tests/playback.test.mjs` 的参数同步更新。

**代价**：玩家看到的村民画面比服务端实际状态多滞后约 150ms；未解决极端延迟、图形帧耗时和快照丢包。

### 2.3 进入/退出化身失败

**静态证据**：`frontend/town-shared/src/avatar/commands.ts` 8 秒无确认即返回 false。原 `entry.ts`、`controller.ts` 在不确定失败时可能自动再次进入或更换化身编号；原 `lease.ts` 在恢复超时后删除可用的恢复 Token。**改动**：单次提交按钮防重复、超时后不自动新建第二个化身、保留恢复 Token、发送异常会释放 pending 阻塞、离开时根据服务端已释放状态判定结果。

**局限**：这次优先消除二次进入和永久卡住的风险；**没有证明“进入或退出永不失败”**。跨断线回执、重复操作幂等以及双浏览器争抢同一化身需要专门的真人测试。

## 3. 模型服务调整（新增需求）

- `frontend/town-shared/src/providers.ts`：预置列表移除 `302-ai` / `opencode`（OpenCode Zen），新增 `opencode-go`；地址为 `https://opencode.ai/inference/go/openai/v1`，默认 `glm-5.3-flash`。
- `frontend/town-shared/src/models/connect.ts`：快速连接入口、申请 Key 链接和套餐说明同步调整。
- `crates/host/src/llm.rs`、`crates/host/src/agent_worker.rs`：Go 请求自动加入官方要求的 `x-opencode-session`，同一村民的对话使用稳定标识，连接测试/建镇一次性请求用随机标识；其余厂商请求不附加该头。
- 本项目后端只实现 OpenAI Chat Completions，预设仅选用可通过此协议调用的文本模型，不保证其他 Responses/Anthropic 原生模型兼容。可用模型和额度以官方 OpenCode Go 页面为准。
- **迁移注意**：已有存档或个人配置中的旧 `opencode` / `302-ai` 记录以及密钥不会自动迁移或清除（避免无提示破坏已有玩家模型绑定）。请先手动更换村民和默认模型，然后备份并清理旧配置。Go 是独立套餐，旧 Zen Key 不保证能用。
- **尚未验证**：没有用户 Go API Key，无法实际调用付费端点或验证套餐策略；本地回归测试仅验证目录/调用链的存在。

## 4. 尚未解决或需关注的风险

1. **多人关镇 lease**：当前一个世界的 lease 表示最近一次 open；非常驻模式下多个朋友的 lease 会相互覆盖。私人服建议 `TOWN_ALWAYS_ON=1` 并设置常驻镇，后续可以改按连接数、用户和持有者维护 lease。
2. **短 PIN 的在线猜测**：默认账号 PIN 可为 4 位，目前没有完整登录频率限制。只通过 VPN/Tailscale 开放管理口；后续建议按 IP + 账号节流与登录失败退避。
3. **自定义模型地址的内网访问**：用户填写的 `base_url` 由服务端请求；若允许不完全可信的普通用户自行配置模型服务，可能触发 SSRF/内部端口探测。应限制协议、地址及本机目标访问策略，兼顾实际需要的 Ollama。
4. **OpenCode Go 适用性**：Go 主要是面向编程模型的订阅服务，并有工作区/调用限额约束。游戏高频 Agent 模拟是否符合你的订阅/使用条件，应先核对官方条款和额度；不要把账号密钥直接分发给朋友。
5. **存储**：回收站不能代替外部备份；建议每天打包 `AI_TOWN_HOME` 到另一磁盘，并在升级前备份。
6. **性能**：`/open` 时重复向全镇投放 Key/额度的逻辑尚未重构；大镇反复进入可能产生额外管理消息。
7. **原生清理后的打包脚本**：`scripts/builtin-model/build.mjs` 已移除 Android/Windows 工具链依赖，加入 Linux 本地构建路径，但没有在本环境用 cmake/llama.cpp 验证 Linux 静态链接。

## 5. 运行和测试记录

- 已运行 Node 原生测试的**定向子集**：10 项通过（账号 Session、未经认证删除、路径规划、OpenCode Go 目录与 Header 静态检查、使用量账本）。
- 原始测试套件涉及 Rust `host`/`town-map` 子进程，以及 pnpm 安装的前端依赖。当前执行环境只有 Node 22.16，没有 Rust/Cargo、pnpm 和完整 `node_modules`，所以**未完成** Cargo 编译、Rust 单元测试、TypeScript typecheck、正式前端构建、全量集成测试。
- Go 真实 API 未发起请求（没有 Key），多人、弱网和卡顿修复均仍须浏览器/服务器真实验收；此产物不是已完成全链路验收的正式发行版。

## 6. 你的服务器如何验收

```bash
# 先备份旧 AI_TOWN_HOME，然后解压新代码
corepack pnpm install --frozen-lockfile
cargo +1.88.0 build -p host --bins   # 首次构建先更新 Cargo.lock；再提交锁文件
corepack pnpm typecheck
corepack pnpm build
cargo +1.88.0 test --workspace
corepack pnpm test

# 只对受信任的 VPN / 内网开放 8788
AI_TOWN_HOME=/srv/ai-town-data TOWN_BIND=0.0.0.0 TOWN_ALWAYS_ON=1 \
  node scripts/start-client.mjs preview --port 8788
```

域名反向代理另设置 `TOWN_ALLOW_HOST=实际访问域名`，并保证 HTTPS 和 WebSocket Upgrade 转发。未设置 VPN/HTTPS 前不要暴露给公网。建议用两台桌面浏览器做：连续 2 分钟点地行走、10+ 村民长时间同时移动、切后台 10 秒返回、进入/退出化身 20 次、断网后重连、两人同时开镇/关页面、小镇重启恢复、Go 模型连通测试。
