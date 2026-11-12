# 浏览器版开发与部署

此分支**只支持桌面浏览器**；服务端运行 Node Manager 和 Rust Host，世界模拟与 AI Agent 仍由 Rust 执行。原生 App 与 Rust Manager 已移除。

## 开发环境

需要 Node.js >= 22.18、pnpm（通过 Corepack）、Rust 1.88.0。

```sh
corepack pnpm install --frozen-lockfile
cargo +1.88.0 build -p host --bins
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
```

首次从原仓库精简后需要更新 `Cargo.lock`；**首次编译不加 --locked**，成功后提交新的 `Cargo.lock`，之后可恢复锁定构建。

开发：`corepack pnpm dev`，正式构建后运行：

```sh
AI_TOWN_HOME=/srv/ai-town-data TOWN_BIND=0.0.0.0 TOWN_ALWAYS_ON=1 \
  node scripts/start-client.mjs preview --port 8788
```

通过 Tailscale 或仅对受信任私网开放端口 8788；Rust Host 的端口只监听 127.0.0.1。首次创建小镇、设置常驻后，才考虑加 `TOWN_ONLY_RESIDENT=1`。

## 内置模型

Linux/macOS 可执行 `node scripts/builtin-model/build.mjs` 构建本机 `llama-server`；模型权重仍由游戏按原有逻辑下载。无需安装和构建 Android、macOS、Windows 原生应用壳。也可以直接配置在线 AI API。

## 兼容性和安全提醒

登录 Cookie 已改为随机 Session，旧 Cookie 会失效；原账号、存档和密码哈希仍保留。请在升级前备份 `AI_TOWN_HOME`。

仅限私人服使用，建议 VPN/HTTPS 反向代理，限制暴露端口。点击移动与村民插值调整属于基于代码的缓解方案，仍须人工联机验收。具体审查见仓库根目录 `AUDIT_REPORT.md`。
