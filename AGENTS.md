玩家说明见根目录 `README.md`，启动和检查见 `docs/README.md`。以源码、测试和数据为准；允许本次精简审查附带 `BROWSER_ONLY.md` 和 `AUDIT_REPORT.md`；日常改动减少临时文档。实现说明写在必要的源码注释里，验证结果写在提交信息或 PR 描述中。

测试只保留关键行为与数据安全的回归，优先走完整调用路径；同一规则不在多层重复覆盖，不保留细小实现、界面排列和批量参数变体测试。

## 项目边界

- `crates/` 是 Rust 世界内核、Agent、协议与服务；`frontend/` 是客户端；`scripts/` 是本机管理服务和 HD-2D 建镇生成器。
- 本分支只支持**桌面浏览器访问私人服务器**：Node 管理服务（`scripts/town-manager.mjs`）与 Rust 世界进程（`crates/host`）同机运行，前端通过管理服务的 `/ws/<id>` 连接世界。
- 已移除 `android/`、`macos/`、`windows/`、`crates/manager/` 以及相关 App 构建脚本；不恢复原生应用，不把 Node 管理逻辑重复实现到 Rust。
- 模型预设取消 302.AI、OpenCode Zen；OpenCode Go 使用单独套餐端点，并要求 `x-opencode-session`。原始配置中的旧记录不自动迁移 API Key。
- 客户端只提供 HD-2D，立体渲染位于 `frontend/town-2d/src/map/hd2d/`，不恢复独立 3D 客户端和研究工具。
- 玩法（有自己的目标、时间表和输赢的一套规则，如大逃杀的潮水圈）不往本体里加开关：内核在 `crates/kernel/src/game_mode/` 实现 `Rules` 并登记，线上类型在 `crates/protocol/src/game_mode/`，画面在 `frontend/town-2d/src/map/hd2d/gameModes/`。加一个玩法：在这三个目录各写它自己的文件，再补登记（内核的 `GameMode`、协议的三个枚举、服务打开玩法时的回执、前端 `protocol.ts` 的类型和 `gameModeLooks`），漏了哪处编译器和协议样本测试会提示；接入点不够就改接入点，不在本体里为某个玩法写专门的判断。一个世界同时最多开一个玩法，没开时存档、协议和给模型的题面与没有玩法时一字不差。所有玩法都用得到的能力（天气、生理、陌生环境等）留在本体。选了就玩某个玩法的预制小镇登记在 `frontend/town-shared/src/prefabs/`。
- `data/maps/2d-town/map.json` 是发布的默认地图；`data/mapgen/` 是公共生成模板；`data/props/` 是公共道具定义。玩家地图、道具、居民存档、记忆和日志属于用户目录 `towns/<小镇 ID>/`，不迁入仓库的数据目录。
- `config/` 是应用配置和村民库；密钥位于被忽略的 `config/credentials.json`。
- 不从废弃项目重新生成地图。维护默认图时检查逻辑与坐标，用 `scripts/mapgen/document.mjs` 的 `seal` 更新摘要，再运行 `target/debug/town-map validate < data/maps/2d-town/map.json`。
- `data/scene-assets/` 的清单用于 HD-2D 空间校验和旧地图指纹，历史模型名不代表发布 GLB。不要因清理名称改变清单；修改参数或版本前先解决已有地图与存档的兼容。
- 旧 3D 存档不自动转换或删除；删除用户数据须有明确指令。
