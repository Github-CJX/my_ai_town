//! 应用的命令分派与单拍顺序。保持命令 → 推进 → 模型结果 → roster 的原有时序。
//! 客户端命令不能让进程退出：存盘失败只回错误回执并写日志，内存状态保留，下次检查点重试。
use crate::{
    join::JoinRequest,
    network::{broadcast, broadcast_event, broadcast_snapshot, send_to, Clients},
    owner_keys::OwnerKeys,
    resident_driver::ResidentDriver,
    settings::Settings,
    startup::WorldSetup,
    transaction::Abort,
};
use agent::AgentError;
use host::{
    clock::ClockSave, library::Library, population::Population, tasks::TaskPool,
    world_settings::valid_speed, HostError,
};
use kernel::World;
use protocol::{Alert, ClientMsg, ContentCommand, EventInfo, ServerMsg, WeatherCode};

/// 村民的细节（目标、动作结果、互动、记忆）多少拍算一次：10 拍约一秒，变了才发。
const DETAIL_REFRESH_TICKS: u64 = 10;

pub(crate) struct Runtime {
    /// 建新世界的地图数据与规则；重置时用它再建一次。
    pub setup: WorldSetup,
    /// 每条连接各自的控制权：多页面同时玩时互不顶替。
    pub avatar_controls: std::collections::BTreeMap<u64, crate::avatar::Control>,
    /// 现实时间锚点：存档里记下停摆那一刻，重启用来看这次停了多久。
    pub clock: ClockSave,
    pub world_settings: host::world_settings::WorldSettings,
    pub world: World,
    /// 玩家选定的速度：正常速度（见 base_pace）的倍数，0 为暂停，界面上只有 0 和 1；随存档保存。
    pub speed: f64,
    /// 这一拍实际的推进速度（模拟分钟 / 现实秒）：大家都在做一件还要好一阵的事时比正常速度快
    /// （自动快进），不存档。
    pub pace: f64,
    pub driver: ResidentDriver,
    pub settings: Settings,
    pub store: Option<host::persistence::SaveStore>,
    pub population: Population,
    pub library: Library,
    pub prop_library: host::props::PropLibrary,
    /// 连接测试、模板生成这类一次性模型调用的有界池。
    pub tasks: TaskPool,
    /// 村民自己账号里填的密钥（只在内存里；世界重启后由管理服务重发）。
    pub owner_keys: OwnerKeys,
    /// 谁是谁的化身：按票面账号编号记，存在存档旁边的文件里（见 owners.rs）。
    pub owners: host::owners::Owners,
    /// 上一次存盘是否失败；只在状态变化时写日志，避免每秒刷屏。
    pub save_failed: bool,
    /// 已经发出去的村民细节（序列化后比对）：变了才发，不跟着每拍的名册走。
    pub details_sent: std::collections::BTreeMap<String, String>,
    /// 走过的拍数：细节不每拍都算。
    pub ticks: u64,
}

/// 一条消息发给谁。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum To {
    /// 发出命令的连接：命令的回执、查询结果与错误。
    Sender,
    /// 所有连接：命令改动后的世界与设定状态。
    All,
}

/// 一条命令的处理结果：按顺序要发出的消息与各自发给谁，以及是否改动了需要存盘的状态。
/// 自己完成存盘（含回滚）的事务性命令不标存盘。
pub(crate) struct Outcome {
    pub messages: Vec<(To, ServerMsg)>,
    pub persist: bool,
}

impl Outcome {
    /// 不发消息。
    pub fn none() -> Self {
        Self {
            messages: Vec::new(),
            persist: false,
        }
    }
    /// 一条只回给发出者的消息。
    pub fn reply(message: ServerMsg) -> Self {
        Self::none().and_reply(message)
    }
    /// 后面再回给发出者一条。
    pub fn and_reply(mut self, message: ServerMsg) -> Self {
        self.messages.push((To::Sender, message));
        self
    }
    /// 后面再广播一条。
    pub fn and_all(mut self, message: ServerMsg) -> Self {
        self.messages.push((To::All, message));
        self
    }
    /// 改动了需要存盘的状态，发完消息后存盘。
    pub fn persisted(mut self) -> Self {
        self.persist = true;
        self
    }
}

/// 通用错误；发给发出者时由 `Runtime::command` 填上引起它的命令编号。
pub(crate) fn error_msg(message: String) -> ServerMsg {
    ServerMsg::Error {
        request_id: None,
        message,
    }
}

impl Runtime {
    /// 执行一条来自 `connection` 的命令：回执、查询结果与错误只发给它，状态变化广播给所有连接。
    pub(crate) fn command(&mut self, connection: u64, msg: ClientMsg, clients: &Clients) {
        let request_id = msg.request_id().map(str::to_owned);
        let outcome = match self.gate(&msg) {
            Some(rejection) => Outcome::reply(rejection),
            None => self.dispatch(msg, connection, clients),
        };
        let reply = |message: &mut ServerMsg| {
            if let ServerMsg::Error { request_id: id, .. } = message {
                if id.is_none() {
                    id.clone_from(&request_id);
                }
            }
            send_to(clients, connection, message);
        };
        for (to, mut message) in outcome.messages {
            match to {
                To::Sender => reply(&mut message),
                To::All => broadcast(clients, &message),
            }
        }
        if outcome.persist {
            if let Err(error) = self.checkpoint(true) {
                reply(&mut error_msg(kept_in_memory(&error)));
            }
        }
    }

    /// 世界标识与就绪门槛统一在这里：命令自带 world_id 的必须对上当前世界；改世界的命令必须先设世界观。
    fn gate(&self, msg: &ClientMsg) -> Option<ServerMsg> {
        if world_id_of(msg).is_some_and(|id| id != self.population.world_id) {
            return Some(self.rejection(msg, "世界已重置，请刷新页面后重试"));
        }
        if requires_ready(msg) && !self.world_settings.ready() {
            return Some(self.rejection(msg, "请先设置世界观"));
        }
        None
    }

    /// 按命令自己的回执类型退回；没有专用回执的用通用错误。
    fn rejection(&self, msg: &ClientMsg, message: &str) -> ServerMsg {
        let message = message.to_string();
        match msg {
            ClientMsg::SetWeather {
                request_id,
                world_id,
                ..
            } => {
                let code = if world_id != &self.population.world_id {
                    WeatherCode::WorldMismatch
                } else {
                    WeatherCode::WorldNotReady
                };
                self.weather_failed(request_id.clone(), code, message)
            }
            ClientMsg::SetWorldview { request_id, .. }
            | ClientMsg::SetPhysiology { request_id, .. }
            | ClientMsg::SetMiracles { request_id, .. }
            | ClientMsg::SetStrangers { request_id, .. }
            | ClientMsg::SetGameMode { request_id, .. } => ServerMsg::WorldSettingsSaved {
                request_id: request_id.clone(),
                ok: false,
                message,
            },
            ClientMsg::Content { request_id, .. }
            | ClientMsg::RemoveProp { request_id, .. }
            | ClientMsg::PlaceProp { request_id, .. } => ServerMsg::PropResult {
                request_id: request_id.clone(),
                ok: false,
                message,
                preview: None,
            },
            ClientMsg::JoinResident { op_id, .. } => ServerMsg::JoinResult {
                op_id: op_id.clone(),
                outcome: Some(self.failed_join(op_id, message)),
            },
            ClientMsg::SetResidentAppearance {
                request_id,
                resident_id,
                ..
            } => self.resident_appearance_reply(
                request_id.clone(),
                resident_id.clone(),
                false,
                message,
            ),
            ClientMsg::SetResidentBody { request_id, .. } => ServerMsg::AgentSaved {
                request_id: request_id.clone(),
                ok: false,
                message,
            },
            ClientMsg::RemoveResident { request_id, .. } => ServerMsg::ResidentRemoved {
                request_id: request_id.clone(),
                ok: false,
                message,
            },
            ClientMsg::SetResidentBudget { request_id, .. } => ServerMsg::ResidentBudgetSaved {
                request_id: request_id.clone(),
                ok: false,
                message,
            },
            // 没有专用回执：门槛只可能拦下其中的 SetSpeed。
            ClientMsg::Avatar { .. }
            | ClientMsg::AvatarInput { .. }
            | ClientMsg::GetChatHistory { .. }
            | ClientMsg::GetWorldSettings
            | ClientMsg::GetProps
            | ClientMsg::GetPlaceGrid { .. }
            | ClientMsg::ValidateProp { .. }
            | ClientMsg::SaveProp { .. }
            | ClientMsg::SetSpeed { .. }
            | ClientMsg::GetModelConfig
            | ClientMsg::SetModelConfig { .. }
            | ClientMsg::SetResidentModel { .. }
            | ClientMsg::SetResidentKey { .. }
            | ClientMsg::RestartBuiltinModel { .. }
            | ClientMsg::TestModelConnection { .. }
            | ClientMsg::GetAgentConfig { .. }
            | ClientMsg::SetPersona { .. }
            | ClientMsg::ResetWorld { .. }
            | ClientMsg::GetPopulation
            | ClientMsg::GetUsage
            | ClientMsg::GetResidentLibrary { .. }
            | ClientMsg::GetResidentTemplate { .. }
            | ClientMsg::SaveResidentTemplate { .. }
            | ClientMsg::PreviewTemplatePersona { .. }
            | ClientMsg::GenerateResidentTemplate { .. }
            | ClientMsg::ArchiveResidentTemplate { .. }
            | ClientMsg::PreviewResidentJoin { .. }
            | ClientMsg::GetResidentJoinResult { .. }
            | ClientMsg::GetDiary { .. }
            | ClientMsg::GetNotebook { .. }
            | ClientMsg::GetNotebookDetail { .. }
            | ClientMsg::GetAgentLimits
            | ClientMsg::SetAgentLimits { .. } => error_msg(message),
        }
    }

    /// 这条连接能不能管这位村民：管理员都行；普通账号只行自己的那一位。
    /// 登记的投放人是空（原有居民、老档、管理服务自己请进来的）时只有管理员能动，免得被随便认领。
    fn allows_owner(&self, clients: &Clients, connection: u64, resident: &str) -> bool {
        if crate::network::allows_admin(clients, connection) {
            return true;
        }
        match (
            crate::network::account_of(clients, connection),
            self.population.owner_of(resident),
        ) {
            (Some(who), Some(owner)) => !owner.is_empty() && who == owner,
            _ => false,
        }
    }

    /// 唯一的分派表：每种客户端消息一行，新增消息编译器会指出漏项。
    fn dispatch(&mut self, msg: ClientMsg, connection: u64, clients: &Clients) -> Outcome {
        use ClientMsg::*;
        // 世界不认账号，只认管理服务签的票：改世界、请人入住这类事要管理员（或管理服务自己）。
        if let Some(what) = admin_action(&msg) {
            if !crate::network::allows_admin(clients, connection) {
                return Outcome::reply(error_msg(format!("只有管理员可以{what}")));
            }
        }
        // 自己的村民自己管：改人设、样子、模型要投放它的那个账号，管理员照样可以。
        if let Some((what, resident)) = owner_action(&msg) {
            if !self.allows_owner(clients, connection, resident) {
                return Outcome::reply(error_msg(format!("只有投放这位村民的账号可以{what}")));
            }
        }
        match msg {
            SetWeather {
                request_id,
                expected_revision,
                mode,
                kind,
                ..
            } => self.save_weather(kernel::weather::WeatherRequest {
                request_id,
                expected_revision,
                mode,
                kind,
            }),
            Avatar { .. } | AvatarInput { .. } => {
                Outcome::reply(error_msg("化身命令走专门的入口".into()))
            }
            GetWorldSettings => Outcome::reply(self.world_settings_msg()),
            SetWorldview {
                request_id,
                expected_revision,
                text,
                ..
            } => self.save_worldview(request_id, expected_revision, &text),
            SetPhysiology {
                request_id,
                expected_revision,
                switches,
                ..
            } => self.save_physiology(request_id, expected_revision, switches),
            SetMiracles {
                request_id,
                enabled,
                ..
            } => self.save_miracles(request_id, enabled),
            SetStrangers {
                request_id,
                enabled,
                ..
            } => self.save_strangers(request_id, enabled),
            SetGameMode {
                request_id,
                game_mode,
                ..
            } => self.save_game_mode(request_id, game_mode),
            SetSpeed { speed, .. } => self.set_speed(speed, clients),
            ResetWorld { .. } => self.reset(),
            GetProps => Outcome::reply(self.props_message()),
            GetPlaceGrid { request_id, locale } => Outcome::reply(ServerMsg::PlaceGrid {
                request_id,
                locale: locale.clone(),
                grid: self.world.placement_grid(&locale),
            }),
            Content {
                request_id,
                command,
                ..
            } => self.content_command(request_id, command),
            ValidateProp {
                request_id,
                definition,
            } => self.validate_prop(request_id, definition),
            SaveProp {
                request_id,
                definition,
            } => self.save_prop(request_id, definition),
            RemoveProp { request_id, id, .. } => self.remove_prop(request_id, &id),
            PlaceProp {
                request_id,
                instance,
                near,
                ..
            } => self.place_prop(request_id, instance, near),
            GetPopulation => Outcome::reply(self.population_msg()),
            SetResidentAppearance {
                request_id,
                expected_revision,
                resident_id,
                appearance,
                ..
            } => {
                self.set_resident_appearance(request_id, expected_revision, resident_id, appearance)
            }
            SetResidentBody {
                request_id,
                resident_id,
                values,
                ..
            } => self.set_resident_body(request_id, &resident_id, values, clients),
            GetResidentLibrary { filter } => Outcome::reply(self.library_msg(&filter)),
            GetResidentTemplate { template_id } => Outcome::reply(self.template_msg(&template_id)),
            SaveResidentTemplate {
                request_id,
                template_id,
                expected_version,
                fields,
            } => self.save_template(request_id, template_id, expected_version, *fields),
            PreviewTemplatePersona { fields } => self.template_persona(&fields),
            GenerateResidentTemplate { request_id, brief } => {
                self.generate_template(request_id, brief, connection, clients)
            }
            ArchiveResidentTemplate {
                request_id,
                template_id,
                expected_version,
                archived,
            } => self.archive_template(request_id, &template_id, expected_version, archived),
            PreviewResidentJoin {
                template_id,
                name,
                home,
            } => self.join_preview(&template_id, name.as_deref(), home.as_deref()),
            JoinResident {
                op_id,
                world_id,
                template_id,
                template_version,
                name,
                home,
                model,
                owner,
            } => self.join(
                JoinRequest {
                    op_id,
                    world_id,
                    template_id,
                    template_version,
                    name,
                    home,
                    model,
                    owner,
                },
                clients,
            ),
            GetResidentJoinResult { world_id, op_id } => self.join_result(&world_id, op_id),
            RemoveResident {
                request_id,
                resident,
            } => self.remove_resident(request_id, &resident, clients),
            GetChatHistory {
                resident,
                request_id,
                chat_id,
                offset,
            } => self.chat_history(&resident, request_id, chat_id, offset),
            GetModelConfig => self.model_config(),
            SetModelConfig {
                request_id,
                active,
                providers,
                keys,
            } => self.set_model_config(request_id, active, providers, keys),
            SetResidentModel {
                request_id,
                resident,
                model,
            } => self.set_resident_model(request_id, &resident, model),
            SetResidentKey {
                request_id,
                resident,
                provider,
                base_url,
                api_key,
            } => self.set_resident_key(request_id, &resident, provider, base_url, api_key),
            RestartBuiltinModel { request_id } => self.restart_builtin_model(request_id),
            TestModelConnection {
                request_id,
                provider,
                model,
                api_key,
            } => self.test_connection(
                crate::settings::ConnectionTest {
                    request_id,
                    provider,
                    model,
                    api_key,
                },
                connection,
                clients,
            ),
            GetAgentConfig { resident } => self.agent_config(resident.as_deref()),
            SetPersona {
                request_id,
                resident,
                text,
            } => self.set_persona(request_id, &resident, text),
            GetDiary { resident } => self.diary(resident.as_deref()),
            GetNotebook {
                resident,
                request_id,
                query,
            } => self.notebook(resident, request_id, &query),
            GetNotebookDetail {
                resident,
                request_id,
                query,
            } => self.notebook_detail(resident, request_id, &query),
            GetAgentLimits => Outcome::reply(self.driver.limits_view(&self.world)),
            GetUsage => Outcome::reply(self.driver.usage_view(&self.world)),
            SetAgentLimits { request_id, limits } => self.set_agent_limits(request_id, limits),
            SetResidentBudget {
                request_id,
                resident,
                calls_per_day,
                tokens_per_day,
                group,
                max_concurrent,
                per_minute,
            } => self.set_resident_budget(
                request_id,
                &resident,
                calls_per_day,
                tokens_per_day,
                group,
                max_concurrent,
                per_minute,
            ),
        }
    }

    fn set_speed(&mut self, speed: f64, clients: &Clients) -> Outcome {
        if !valid_speed(speed) {
            return Outcome::reply(error_msg("速度须在 0 到 600 之间".into()));
        }
        if speed > 0.0 {
            // 点开始就是用户主动继续：清掉额度、故障和过时停止，条件仍在会再次停下。
            let resumed = self.driver.runtime.resume(&self.world);
            if resumed > 0 {
                broadcast_event(
                    clients,
                    &self.world,
                    if resumed == 1 {
                        "停下的村民接着行动了".to_string()
                    } else {
                        format!("{resumed} 位停下的村民接着行动了")
                    },
                    EventInfo::default(),
                );
            }
        }
        self.speed = speed;
        println!("[host] speed = {speed} 模拟分钟/秒");
        Outcome::none().persisted()
    }

    /// 重置世界：人口与历史一起清空，回到第一天并停表；换世界标识，旧模型回复与旧加入命令因此失效。
    /// 没有特殊村民，重置后所有人都要从村民库重新加入；村民库本身不动。
    /// 重置是事务：新世界保存成功才算生效，保存失败时世界、人口、会话都回到重置前。
    fn reset(&mut self) -> Outcome {
        let population = Population::fresh();
        let fresh = match self
            .setup
            .fresh_world(&self.prop_library.catalog, &population.world_id)
        {
            Ok(world) => world,
            Err(error) => return Outcome::reply(error_msg(format!("重置失败：{error}"))),
        };
        let result = self.transact(|rt| {
            rt.driver.runtime.clear_world()?;
            rt.world = fresh;
            rt.avatar_controls.clear();
            rt.population = population;
            rt.world_settings = Default::default();
            rt.speed = 0.0;
            Ok::<_, AgentError>(())
        });
        if let Err(aborted) = result {
            let message = match &aborted.cause {
                Abort::Rejected(_) => format!("重置失败：{aborted}"),
                Abort::SaveFailed(error) => {
                    format!("重置未生效，保存失败：{error}{}", aborted.leftover_note())
                }
            };
            eprintln!("[host] {message}");
            return Outcome::reply(error_msg(message));
        }
        println!("[host] 世界已重置：{}，已暂停", self.world.clock());
        // 旧化身编号全部作废：归属也一起忘掉，免得新世界沿用旧绑定（事务成功之后才动文件）。
        self.owners.clear();
        Outcome::none()
            .and_all(ServerMsg::WorldReset {
                clock: self.world.clock(),
            })
            .and_all(event(&self.world, "已重置：人口、记忆、目标、进度和用量全部清空，回到第一天并暂停；地图布局与村民库保留"))
            .and_all(self.population_msg())
            .and_all(self.world_settings_msg())
    }

    /// 一拍：推进世界、收模型结果、发新请求、广播 roster。存盘或轨迹写入失败只写日志，不中断运行。
    pub(crate) fn tick(&mut self, clients: &Clients) {
        self.avatar_tick(clients);
        let content_before = self.world.contents().revision();
        let inventory_before = self.world.inventory().revision();
        let missing =
            self.driver
                .missing_models(&self.population, &self.settings, &self.owner_keys);
        self.driver.runtime.wait_for_models(&self.world, &missing);
        // 谁都还不能思考（都在等模型）时时间停着，化身照样能走：世界照走的话他们只会一路饿着
        let running = self.speed > 0.0
            && self.world_settings.ready()
            && !self.driver.runtime.nobody_can_think(&self.world);
        self.pace = if running { self.next_pace() } else { 0.0 };
        let events = if running {
            self.world.step(0.1 * self.pace)
        } else {
            Vec::new()
        };
        self.driver.dispatch(&self.world, events, clients);
        let replied = match self.driver.receive(&mut self.world, clients) {
            Ok(replied) => replied,
            Err(error) => {
                eprintln!("[host] {error}");
                true
            }
        };
        let requests = self.driver.runtime.poll(&mut self.world, running);
        let held = self.hold_if_needed(clients);
        let changed = inventory_before != self.world.inventory().revision()
            || content_before != self.world.contents().revision()
            || replied
            || held
            || !requests.is_empty();
        // 周期存盘失败只在刚开始失败时通知客户端，之后每拍重试、不重复刷屏。
        let was_failing = self.save_failed;
        if let Err(error) = self.checkpoint(changed) {
            if !was_failing {
                broadcast(clients, &error_msg(kept_in_memory(&error)));
            }
        }
        if let Err(error) = self.driver.send(
            &mut self.world,
            requests,
            &self.population,
            &self.settings,
            &self.owner_keys,
            clients,
        ) {
            eprintln!("[host] {error}");
        }
        if inventory_before != self.world.inventory().revision() {
            broadcast(clients, &self.props_message());
        }
        // 名册每拍都发，是可合并的整份状态：客户端慢了只给它最新的一份，不排长队。
        broadcast_snapshot(clients, &self.roster());
        self.publish_details(clients);
        self.avatar_publish(clients);
    }

    /// 村民的慢变量（目标、动作结果、互动、记忆）：每 10 拍（约 1 秒）算一次，变了才发。
    /// 名册每拍都发，放不下这些大字段——3 位村民时一份名册 36 KB，10 Hz 就是每位旁观者 360 KB/s。
    fn publish_details(&mut self, clients: &Clients) {
        self.ticks = self.ticks.wrapping_add(1);
        if self.ticks % DETAIL_REFRESH_TICKS != 0 {
            return;
        }
        let details = self.driver.details(&self.world);
        let live: std::collections::BTreeSet<&str> =
            details.iter().map(|(id, _)| id.as_str()).collect();
        // 已经不在小镇里的村民：把上次发的记下来那条删掉，免得下次同名的人被当成「没变」。
        self.details_sent.retain(|id, _| live.contains(id.as_str()));
        for (resident, detail) in details {
            let text = serde_json::to_string(&detail).unwrap_or_default();
            if self
                .details_sent
                .get(&resident)
                .is_some_and(|last| *last == text)
            {
                continue;
            }
            self.details_sent.insert(resident.clone(), text);
            broadcast(clients, &ServerMsg::ResidentDetail { resident, detail });
        }
    }

    /// 这一拍的推进速度。平时按正常速度走，走路、交谈都看得清；只有大家都在做一件还要好一阵的事
    /// （都睡了、都在干活）时才快进：每拍加快一点，最多每秒一小时，离最近一个人做完越近越慢，
    /// 到点时正好回到正常速度，接着出门的人不会一闪而过。
    /// 有人要做决定、玩家在控制化身或有人倒下时不快进，回复也就不会因为世界跑得太快而过时；
    /// 有人还没有能用的模型时也不快进。
    fn next_pace(&self) -> f64 {
        let normal = self.normal_pace();
        let calm = !self.anyone_controlled()
            && !self.world.anyone_collapsed()
            && !self.driver.runtime.thinking(&self.world)
            && !self.driver.runtime.waiting_for_model();
        let quiet = || {
            self.world
                .quiet_minutes(|id| self.driver.runtime.next_thought_in(&self.world, id))
        };
        match calm.then(quiet).flatten() {
            Some(left) if normal < FAST_PACE => (self.pace.max(normal) * FAST_RAMP)
                .min(FAST_PACE)
                .min(normal + left / EASE_SECONDS)
                .max(normal),
            _ => normal,
        }
    }

    /// 正常速度（模拟分钟 / 现实秒）：选定速度乘这张地图的基准。
    pub(crate) fn normal_pace(&self) -> f64 {
        self.speed * self.base_pace()
    }

    /// 选定速度为 1 时世界每秒走几分钟：让村民在画面上每秒走 WALK_UNITS_PER_SECOND 个地图单位。
    /// 步行速度都是每分钟 12 米，但地图的米制比例不同（默认地图每米 12 个单位，新建的地图 60 个），
    /// 按同一个时间比例走，新建地图上的人在画面上快五倍；按画面上的步速定基准，哪张图上都一样自然。
    pub(crate) fn base_pace(&self) -> f64 {
        let units_per_minute = self
            .world
            .walk_map
            .as_ref()
            .map_or(LEGACY_UNITS_PER_MINUTE, |m| {
                m.metres_per_minute * m.svg_units_per_metre
            });
        WALK_UNITS_PER_SECOND / units_per_minute
    }

    /// 额度用尽、故障或回复接连过时：全镇停表并保留位置、活动和用量。
    fn hold_if_needed(&mut self, clients: &Clients) -> bool {
        if self.speed == 0.0 {
            return false;
        }
        let holds = self.town_holds();
        if holds.is_empty() {
            return false;
        }
        self.speed = 0.0;
        for hold in holds {
            let text = format!(
                "全镇已暂停 · {}（{}）：{}",
                hold.resident,
                hold.kind.label(),
                hold.reason
            );
            println!("[host] {text}");
            let info =
                EventInfo::about(&hold.resident_id, &hold.resident).with_alert(Some(Alert::Hold {
                    pause: hold.kind,
                    reason: hold.reason,
                    cause: hold.cause,
                    provider: hold.provider,
                }));
            broadcast_event(clients, &self.world, text, info);
        }
        true
    }

    /// 全镇暂停的原因，补上每位村民用的模型服务名，提示卡据此写「DeepSeek 的密钥用不了了」。
    pub(crate) fn town_holds(&self) -> Vec<protocol::WorldHold> {
        let mut holds = self.driver.runtime.town_holds(&self.world);
        for hold in &mut holds {
            if let Some(choice) = self
                .population
                .residents
                .get(&hold.resident_id)
                .and_then(|r| r.model_binding.as_ref())
            {
                hold.provider = self.settings.provider_name(&choice.provider);
            }
        }
        holds
    }

    /// 存盘。失败时内存状态不动、返回存盘错误；只在失败与恢复的边界写日志。
    pub(crate) fn checkpoint(&mut self, force: bool) -> Result<(), HostError> {
        let Some(store) = &mut self.store else {
            return Ok(());
        };
        let next_clock = self.clock.stamped(self.world.minutes());
        let result = store.checkpoint_bundle(
            host::persistence::Checkpoint {
                world: &self.world,
                speed: self.speed,
                world_settings: &self.world_settings,
                clock: &next_clock,
                population: Some(&self.population),
            },
            || Some(self.driver.save()),
            force,
        );
        if matches!(result, Ok(true)) {
            self.clock = next_clock;
        }
        match &result {
            Ok(true) if self.save_failed => {
                self.save_failed = false;
                eprintln!("[host] 存盘已恢复");
            }
            Err(error) if !self.save_failed => {
                self.save_failed = true;
                eprintln!("[host] {}", kept_in_memory(error));
            }
            _ => {}
        }
        result.map(|_| ())
    }
}

/// 正常速度下村民在画面上每秒走过的地图单位：约小人身高（立牌高约 123 个单位）的八成，
/// 像散步。默认地图按它算是每秒 0.69 分钟。
const WALK_UNITS_PER_SECOND: f64 = 100.0;
/// 没有行走地图时按默认地图的比例（每米 12 个单位、每分钟 12 米）定正常速度。
const LEGACY_UNITS_PER_MINUTE: f64 = 144.0;
/// 自动快进的上限：现实一秒，小镇过一小时。
const FAST_PACE: f64 = 60.0;
/// 快进时每拍加快的比例：三四秒从正常速度加到上限，几分钟的空档只是稍快一点。
const FAST_RAMP: f64 = 1.15;
/// 快进收尾：离最近一个人做完还剩 m 分钟时最多每秒走 m / EASE_SECONDS 分钟，越近越慢，
/// 最后几秒回到正常速度。
const EASE_SECONDS: f64 = 0.8;

/// 不回滚的存盘失败（周期存盘、非事务命令）的说明：改动还在内存里，下次检查点再写。
fn kept_in_memory(error: &HostError) -> String {
    format!("保存失败，内存状态保留，下次检查点重试：{error}")
}

/// 只有投放这位村民的账号（或管理员）能做的事，对应一句「只有投放这位村民的账号可以…」。
/// 世界不认账号，只认票面里的账号编号和登记表里记的投放人，所以两边都得有。
fn owner_action(msg: &ClientMsg) -> Option<(&'static str, &String)> {
    match msg {
        ClientMsg::SetResidentModel { resident, .. } => Some(("改村民用的模型", resident)),
        ClientMsg::SetResidentKey { resident, .. } => Some(("换村民的密钥", resident)),
        ClientMsg::SetPersona { resident, .. } => Some(("改人设", resident)),
        ClientMsg::SetResidentAppearance { resident_id, .. } => Some(("改村民的样子", resident_id)),
        ClientMsg::SetResidentBody { resident_id, .. } => Some(("改村民的身体", resident_id)),
        _ => None,
    }
}

pub(crate) fn event(world: &World, text: &str) -> ServerMsg {
    ServerMsg::Event {
        sim_minutes: world.minutes(),
        clock: world.clock(),
        text: text.into(),
        info: EventInfo::default(),
    }
}

/// 要管理员才能做的事（对应一句「只有管理员可以…」的说明）；其余命令普通账号也能发。
/// 世界自己不知道谁是管理员：这里只看这条连接握手时验过的票（见 ticket.rs）。
fn admin_action(msg: &ClientMsg) -> Option<&'static str> {
    match msg {
        ClientMsg::SetWeather { .. } => Some("改天气"),
        ClientMsg::SetWorldview { .. } => Some("改世界观"),
        ClientMsg::SetPhysiology { .. } => Some("改生理开关"),
        ClientMsg::SetMiracles { .. } => Some("改神力"),
        ClientMsg::SetStrangers { .. } => Some("改陌生人设置"),
        ClientMsg::SetGameMode { .. } => Some("改玩法"),
        ClientMsg::SetSpeed { .. } => Some("调速度"),
        ClientMsg::ResetWorld { .. } => Some("重置世界"),
        ClientMsg::Content { .. } => Some("改世界内容"),
        ClientMsg::SaveProp { .. } => Some("存道具"),
        ClientMsg::RemoveProp { .. } => Some("收道具"),
        ClientMsg::PlaceProp { .. } => Some("摆道具"),
        ClientMsg::SetModelConfig { .. } => Some("改模型设置"),
        ClientMsg::RestartBuiltinModel { .. } => Some("重启内置模型"),
        ClientMsg::TestModelConnection { .. } => Some("试模型连接"),
        ClientMsg::SaveResidentTemplate { .. } => Some("存村民模板"),
        ClientMsg::ArchiveResidentTemplate { .. } => Some("收起村民模板"),
        ClientMsg::GenerateResidentTemplate { .. } => Some("生成村民"),
        ClientMsg::JoinResident { .. } => Some("请村民入住"),
        ClientMsg::RemoveResident { .. } => Some("请村民离开"),
        ClientMsg::SetAgentLimits { .. } => Some("改 agent 限额"),
        ClientMsg::SetResidentBudget { .. } => Some("改 agent 每日额度"),
        ClientMsg::Avatar { .. }
        | ClientMsg::AvatarInput { .. }
        | ClientMsg::GetChatHistory { .. }
        | ClientMsg::ValidateProp { .. }
        | ClientMsg::GetAgentConfig { .. }
        | ClientMsg::GetWorldSettings
        | ClientMsg::GetPopulation
        | ClientMsg::GetProps
        | ClientMsg::GetPlaceGrid { .. }
        | ClientMsg::GetModelConfig
        | ClientMsg::GetAgentLimits
        | ClientMsg::GetUsage
        | ClientMsg::GetResidentLibrary { .. }
        | ClientMsg::GetResidentTemplate { .. }
        | ClientMsg::PreviewTemplatePersona { .. }
        | ClientMsg::PreviewResidentJoin { .. }
        | ClientMsg::GetResidentJoinResult { .. }
        | ClientMsg::GetDiary { .. }
        | ClientMsg::GetNotebook { .. }
        | ClientMsg::GetNotebookDetail { .. }
        // 自己的村民自己管：这几条按登记表里的投放人判，见 owner_action。
        | ClientMsg::SetResidentModel { .. }
        | ClientMsg::SetResidentKey { .. }
        | ClientMsg::SetPersona { .. }
        | ClientMsg::SetResidentAppearance { .. }
        | ClientMsg::SetResidentBody { .. } => None,
    }
}

/// 自带世界标识的命令；标识对不上就是旧页面发来的，一律退回。
fn world_id_of(msg: &ClientMsg) -> Option<&str> {
    match msg {
        ClientMsg::SetWeather { world_id, .. }
        | ClientMsg::Content { world_id, .. }
        | ClientMsg::SetWorldview { world_id, .. }
        | ClientMsg::SetPhysiology { world_id, .. }
        | ClientMsg::SetMiracles { world_id, .. }
        | ClientMsg::SetStrangers { world_id, .. }
        | ClientMsg::SetGameMode { world_id, .. }
        | ClientMsg::RemoveProp { world_id, .. }
        | ClientMsg::PlaceProp { world_id, .. }
        | ClientMsg::JoinResident { world_id, .. }
        | ClientMsg::SetResidentAppearance { world_id, .. }
        | ClientMsg::SetResidentBody { world_id, .. } => Some(world_id),
        // 化身命令自己核对世界，查加入结果按世界编号查不到就返回空。
        ClientMsg::Avatar { .. }
        | ClientMsg::AvatarInput { .. }
        | ClientMsg::GetResidentJoinResult { .. } => None,
        ClientMsg::GetChatHistory { .. }
        | ClientMsg::GetWorldSettings
        | ClientMsg::GetProps
        | ClientMsg::GetPlaceGrid { .. }
        | ClientMsg::ValidateProp { .. }
        | ClientMsg::SaveProp { .. }
        | ClientMsg::SetSpeed { .. }
        | ClientMsg::GetModelConfig
        | ClientMsg::SetModelConfig { .. }
        | ClientMsg::SetResidentModel { .. }
        | ClientMsg::RestartBuiltinModel { .. }
        | ClientMsg::TestModelConnection { .. }
        | ClientMsg::GetAgentConfig { .. }
        | ClientMsg::SetPersona { .. }
        | ClientMsg::ResetWorld { .. }
        | ClientMsg::GetPopulation
        | ClientMsg::GetUsage
        | ClientMsg::GetResidentLibrary { .. }
        | ClientMsg::GetResidentTemplate { .. }
        | ClientMsg::SaveResidentTemplate { .. }
        | ClientMsg::PreviewTemplatePersona { .. }
        | ClientMsg::GenerateResidentTemplate { .. }
        | ClientMsg::ArchiveResidentTemplate { .. }
        | ClientMsg::PreviewResidentJoin { .. }
        | ClientMsg::GetDiary { .. }
        | ClientMsg::GetNotebook { .. }
        | ClientMsg::GetNotebookDetail { .. }
        | ClientMsg::GetAgentLimits
        | ClientMsg::SetAgentLimits { .. }
        | ClientMsg::RemoveResident { .. }
        | ClientMsg::SetResidentKey { .. }
        | ClientMsg::SetResidentBudget { .. } => None,
    }
}

/// 改世界状态的命令都要先有世界观；查询不受限。
fn requires_ready(msg: &ClientMsg) -> bool {
    match msg {
        ClientMsg::SetWeather { .. }
        | ClientMsg::RemoveProp { .. }
        | ClientMsg::PlaceProp { .. }
        | ClientMsg::JoinResident { .. }
        | ClientMsg::SetResidentAppearance { .. }
        | ClientMsg::SetResidentBody { .. } => true,
        ClientMsg::SetSpeed { speed, .. } => *speed > 0.0,
        ClientMsg::Content { command, .. } => !matches!(command, ContentCommand::Detail { .. }),
        ClientMsg::Avatar { .. }
        | ClientMsg::AvatarInput { .. }
        | ClientMsg::GetChatHistory { .. }
        | ClientMsg::GetWorldSettings
        | ClientMsg::SetWorldview { .. }
        | ClientMsg::SetPhysiology { .. }
        | ClientMsg::SetMiracles { .. }
        | ClientMsg::SetStrangers { .. }
        | ClientMsg::SetGameMode { .. }
        | ClientMsg::GetProps
        | ClientMsg::GetPlaceGrid { .. }
        | ClientMsg::ValidateProp { .. }
        | ClientMsg::SaveProp { .. }
        | ClientMsg::GetModelConfig
        | ClientMsg::SetModelConfig { .. }
        | ClientMsg::SetResidentModel { .. }
        | ClientMsg::RestartBuiltinModel { .. }
        | ClientMsg::TestModelConnection { .. }
        | ClientMsg::GetAgentConfig { .. }
        | ClientMsg::SetPersona { .. }
        | ClientMsg::ResetWorld { .. }
        | ClientMsg::GetPopulation
        | ClientMsg::GetUsage
        | ClientMsg::GetResidentLibrary { .. }
        | ClientMsg::GetResidentTemplate { .. }
        | ClientMsg::SaveResidentTemplate { .. }
        | ClientMsg::PreviewTemplatePersona { .. }
        | ClientMsg::GenerateResidentTemplate { .. }
        | ClientMsg::ArchiveResidentTemplate { .. }
        | ClientMsg::PreviewResidentJoin { .. }
        | ClientMsg::GetResidentJoinResult { .. }
        | ClientMsg::GetDiary { .. }
        | ClientMsg::GetNotebook { .. }
        | ClientMsg::GetNotebookDetail { .. }
        | ClientMsg::GetAgentLimits
        | ClientMsg::SetAgentLimits { .. }
        | ClientMsg::RemoveResident { .. }
        | ClientMsg::SetResidentKey { .. }
        | ClientMsg::SetResidentBudget { .. } => false,
    }
}
