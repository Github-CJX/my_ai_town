//! 化身命令：检查世界与控制代次、按操作编号去重，改动世界后存盘，失败整体回滚；回执带失败类别。
//! 成功时回执的说明一般为空；神力把给玩家看的结果写在这里，页面当提示显示。
use crate::{
    network::{self, Clients},
    runtime::Runtime,
    transaction::Abort,
};
use agent::AgentError;
use kernel::KernelError;
use protocol::{Appearance, AvatarCommand as Command, AvatarResultCode, ServerMsg};
use serde_json::{json, Value};
use std::fmt;

/// 一条化身命令连同它所属的世界、控制代次与操作编号。
pub(crate) struct AvatarRequest {
    pub world_id: String,
    pub request_id: String,
    pub epoch: String,
    pub sequence: u64,
    pub command: Command,
}

/// 化身命令失败的原因；决定回执里的类别与说明。
pub(super) enum AvatarFailure {
    WrongWorld,
    NotReady,
    /// 租约失效、恢复窗口已过或恢复凭据不对。
    ControlLost(&'static str),
    /// 同一操作编号已用于其他内容。
    SequenceConflict,
    /// 上一次存盘失败还没恢复。
    SaveNotRecovered,
    Paused,
    /// 附身的村民还没走到。
    Busy(&'static str),
    /// 另一个页面正在控制。
    Occupied(&'static str),
    /// 内核规则不允许。
    World(KernelError),
    /// 村民会话交接失败。
    Agent(AgentError),
    Rejected(String),
}

impl AvatarFailure {
    fn code(&self) -> AvatarResultCode {
        match self {
            Self::WrongWorld => AvatarResultCode::WrongWorld,
            Self::NotReady => AvatarResultCode::NotReady,
            Self::ControlLost(_) => AvatarResultCode::ControlLost,
            Self::SequenceConflict => AvatarResultCode::Conflict,
            Self::SaveNotRecovered => AvatarResultCode::SaveFailed,
            Self::Paused => AvatarResultCode::Paused,
            Self::Busy(_) => AvatarResultCode::Busy,
            Self::Occupied(_) => AvatarResultCode::Occupied,
            Self::World(_) => AvatarResultCode::World,
            Self::Agent(_) | Self::Rejected(_) => AvatarResultCode::Rejected,
        }
    }
}

impl fmt::Display for AvatarFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongWorld => f.write_str("世界已变化，请重新进入"),
            Self::NotReady => f.write_str("请先设置世界观"),
            Self::SequenceConflict => f.write_str("操作编号已用于其他内容"),
            Self::SaveNotRecovered => f.write_str("保存尚未恢复，请稍后重试"),
            Self::Paused => f.write_str("世界已暂停，请先继续运行"),
            Self::ControlLost(message) | Self::Busy(message) | Self::Occupied(message) => {
                f.write_str(message)
            }
            Self::World(error) => write!(f, "{error}"),
            Self::Agent(error) => write!(f, "{error}"),
            Self::Rejected(message) => f.write_str(message),
        }
    }
}

impl From<KernelError> for AvatarFailure {
    fn from(error: KernelError) -> Self {
        Self::World(error)
    }
}

impl From<AgentError> for AvatarFailure {
    fn from(error: AgentError) -> Self {
        Self::Agent(error)
    }
}

/// 回执里的失败：类别与说明。
struct Rejection {
    code: AvatarResultCode,
    message: String,
}

impl From<AvatarFailure> for Rejection {
    fn from(failure: AvatarFailure) -> Self {
        Self {
            code: failure.code(),
            message: failure.to_string(),
        }
    }
}

/// 命令内容本身，用来比对同号重发、记回执账本和玩家行为记录。
fn fingerprint(command: &Command) -> Value {
    serde_json::to_value(command).expect("化身命令可以序列化")
}

impl Runtime {
    pub(super) fn avatar_command(
        &mut self,
        connection: u64,
        request: AvatarRequest,
        clients: &Clients,
    ) {
        // 回执原样带回请求编号；超长的编号不回显，整条命令丢弃。
        if request.request_id.len() > kernel::ID_MAX_BYTES {
            return;
        }
        let (ok, code, message) =
            match self.run_avatar_command(connection, &request, crate::network::allows_admin(clients, connection))
            {
                Ok(note) => (true, AvatarResultCode::Ok, note),
                Err(rejection) => (false, rejection.code, rejection.message),
            };
        let quiet = matches!(request.command, Command::View | Command::Heartbeat);
        network::send_to(
            clients,
            connection,
            &ServerMsg::AvatarResult {
                request_id: request.request_id,
                ok,
                code,
                message,
                state: self.avatar_session(connection),
            },
        );
        if ok && !quiet {
            network::broadcast(clients, &self.roster());
        }
    }

    /// 世界、就绪、控制代次与去重检查都过了，才进事务。成功时返回给玩家看的说明（多数为空）。
    /// `admin` 是这条连接握手时验过的票：附身村民要管理员。
    fn run_avatar_command(
        &mut self,
        connection: u64,
        request: &AvatarRequest,
        admin: bool,
    ) -> Result<String, Rejection> {
        let AvatarRequest {
            world_id,
            epoch,
            sequence,
            command,
            ..
        } = request;
        if *world_id != self.population.world_id {
            return Err(AvatarFailure::WrongWorld.into());
        }
        match command {
            Command::View => return Ok(String::new()),
            Command::Heartbeat => {
                self.check_control(connection, epoch)?;
                if let Some(lease) = self
                    .avatar_controls
                    .get_mut(&connection)
                    .and_then(|c| c.lease.as_mut())
                {
                    lease.beat();
                }
                return Ok(String::new());
            }
            _ => {}
        }
        if !self.world_settings.ready() {
            return Err(AvatarFailure::NotReady.into());
        }
        // 附身村民＝替他做决定：只有管理员可以（普通人只能当自己那个化身）。
        if matches!(command, Command::Possess { .. }) && !admin {
            return Err(AvatarFailure::Rejected("只有管理员可以附身村民".into()).into());
        }
        let lifecycle = matches!(
            command,
            Command::Enter { .. } | Command::Possess { .. } | Command::Resume { .. }
        );
        if !lifecycle {
            self.check_control(connection, epoch)?;
            if self.already_applied(connection, epoch, *sequence, command)? {
                return Ok(String::new());
            }
        }
        if self.save_failed {
            return Err(AvatarFailure::SaveNotRecovered.into());
        }
        self.commit_avatar_command(connection, *sequence, command, lifecycle)
    }

    /// 同一代次同一序号的命令已经执行过：内容一样算重发成功，不一样拒绝。
    fn already_applied(
        &self,
        connection: u64,
        epoch: &str,
        sequence: u64,
        command: &Command,
    ) -> Result<bool, AvatarFailure> {
        let avatar = self
            .controlled_avatar(connection)
            .ok_or_else(|| AvatarFailure::Rejected("没有玩家控制目标".into()))?;
        let control = self
            .world
            .actor_control(&avatar)
            .ok_or_else(|| AvatarFailure::Rejected("没有玩家控制目标".into()))?;
        match control.receipt(epoch, sequence)? {
            None => Ok(false),
            Some(old) if old == fingerprint(command) => Ok(true),
            Some(_) => Err(AvatarFailure::SequenceConflict),
        }
    }

    /// 改动、记回执与玩家行为、存盘是一个事务；失败时整体回滚，存盘失败时世界停下等保存恢复。
    fn commit_avatar_command(
        &mut self,
        connection: u64,
        sequence: u64,
        command: &Command,
        lifecycle: bool,
    ) -> Result<String, Rejection> {
        let actor_before = self.controlled_avatar(connection);
        let outcome = self.transact(|rt| {
            let note = rt.apply_avatar_command(connection, command)?;
            // 交还之后控制账本已经清掉，不能把村民这条命令记进化身的回执账本。
            let leave = matches!(command, Command::Leave);
            let actor = if leave {
                actor_before.clone()
            } else {
                rt.controlled_avatar(connection)
            }
            .unwrap_or_else(|| rt.world.player_id().to_owned());
            if !lifecycle && !leave {
                rt.world
                    .avatar_remember_of(&actor, sequence, fingerprint(command));
            }
            let event = match command {
                Command::Resume { .. } => json!({"kind":"resume"}),
                _ => fingerprint(command),
            };
            rt.world.record_player_event(&actor, event);
            Ok::<_, AvatarFailure>(note)
        });
        let aborted = match outcome {
            Ok(note) => return Ok(note),
            Err(aborted) => aborted,
        };
        if let Some(control) = self.avatar_controls.get_mut(&connection) {
            control.halt();
        }
        let message = aborted.to_string();
        let code = match &aborted.cause {
            Abort::SaveFailed(_) => {
                self.speed = 0.;
                AvatarResultCode::SaveFailed
            }
            Abort::Rejected(failure) => failure.code(),
        };
        Err(Rejection { code, message })
    }

    /// 执行一条化身命令；成功时返回给玩家看的说明，只有神力写，其他为空。
    fn apply_avatar_command(
        &mut self,
        connection: u64,
        command: &Command,
    ) -> Result<String, AvatarFailure> {
        match command {
            Command::Enter {
                avatar,
                name,
                appearance,
            } => self.enter(connection, avatar.as_deref(), name, appearance),
            Command::Possess { resident } => self.take_over(connection, resident),
            Command::Resume { token } => self.resume_control(connection, token),
            Command::Leave => self.release_player(connection),
            Command::Profile { name, appearance } => {
                let avatar = self.avatar_of_control(connection)?;
                Ok(self
                    .world
                    .avatar_profile_of(&avatar, name, appearance.clone())?)
            }
            Command::Stop => {
                if self.awaiting_arrival(connection) {
                    return Err(AvatarFailure::Busy("等待到达期间请使用交还 AI 取消接管"));
                }
                let avatar = self.avatar_of_control(connection)?;
                self.world.avatar_stop_of(&avatar);
                if let Some(control) = self.avatar_controls.get_mut(&connection) {
                    control.halt();
                }
                Ok(())
            }
            Command::View | Command::Heartbeat => Ok(()),
            Command::Portal { .. }
            | Command::Action { .. }
            | Command::Interact { .. }
            | Command::RequestTurn { .. }
            | Command::Miracle { .. } => return self.act(connection, command),
        }
        .map(|()| String::new())
    }

    /// 这个连接操控的演员编号；没有控制权时报「控制权丢失」。
    fn avatar_of_control(&self, connection: u64) -> Result<String, AvatarFailure> {
        self.controlled_avatar(connection)
            .ok_or(AvatarFailure::ControlLost("你离开了一会儿，已自动退出控制"))
    }

    /// 在世界里做事：穿门、动作、互动、请求发言、施展神力。附身的村民还没走到或世界暂停时不行。
    /// 成功时返回给玩家看的说明（神力的结果），其他为空。
    fn act(&mut self, connection: u64, command: &Command) -> Result<String, AvatarFailure> {
        if self.awaiting_arrival(connection) {
            return Err(AvatarFailure::Busy("等待村民到达后才能操作，可随时交还 AI"));
        }
        if self.speed <= 0. {
            return Err(AvatarFailure::Paused);
        }
        let avatar = self.avatar_of_control(connection)?;
        if let Some(control) = self.avatar_controls.get_mut(&connection) {
            control.halt();
        }
        match command {
            Command::Portal { id } => self.world.avatar_portal_of(&avatar, id)?,
            Command::Action { revision, action } => {
                let id = self.next_action_id(connection)?;
                self.world
                    .avatar_action_of(&avatar, &id, *revision, action)?;
            }
            Command::Interact { revision, command } => {
                let id = self.next_action_id(connection)?;
                self.world
                    .avatar_interact_of(&avatar, &id, *revision, command)?;
            }
            Command::RequestTurn { chat_id, revision } => self
                .world
                .avatar_request_turn_of(&avatar, chat_id, *revision)?,
            Command::Miracle {
                revision,
                recipient,
                miracle,
            } => {
                return Ok(self
                    .world
                    .avatar_miracle_of(&avatar, *revision, recipient, *miracle)?)
            }
            Command::View
            | Command::Heartbeat
            | Command::Enter { .. }
            | Command::Possess { .. }
            | Command::Resume { .. }
            | Command::Leave
            | Command::Profile { .. }
            | Command::Stop => return Err(AvatarFailure::Rejected("化身命令分派出错".into())),
        }
        Ok(String::new())
    }

    fn awaiting_arrival(&self, connection: u64) -> bool {
        self.controlled_avatar(connection)
            .and_then(|avatar| {
                self.world
                    .actor_control(&avatar)
                    .map(|c| c.awaiting_arrival)
            })
            .unwrap_or(false)
    }

    /// 进入化身。同一连接重复进入算成功；这个连接已经在控制别人时拒绝。
    /// 别的连接在控制别的化身不影响这里进场：多人同镇各有各的化身。
    /// 带上编号就接着当那个化身（离开过的回到上次的位置），不带由内核分配。
    fn enter(
        &mut self,
        connection: u64,
        who: Option<&str>,
        name: &str,
        appearance: &Appearance,
    ) -> Result<(), AvatarFailure> {
        if let Some(lease) = self.lease(connection) {
            // 这个连接若正附身某个村民，先交还再进化身：一次只控制一个目标。
            let possessing = self
                .controlled_avatar(connection)
                .is_some_and(|id| self.world.is_possessed(&id));
            if !lease.held_by(connection) || possessing {
                return Err(AvatarFailure::Occupied("这个连接正在控制别的角色"));
            }
            // 已经在场时再报一次名字和样子，就是改名换样子（改名不换人）。
            if let Some(avatar) = self.controlled_avatar(connection) {
                self.world
                    .avatar_profile_of(&avatar, name, appearance.clone())?;
            }
            return Ok(());
        }
        let avatar = match who {
            Some(id) => {
                // 复制标签页会把“我是谁”一起带过去；别让后来者悄悄把别人的化身抢走。
                if self.avatar_held_by_other(connection, id) {
                    return Err(AvatarFailure::Occupied("这个角色正在别的页面手里"));
                }
                self.world.avatar_enter_as(id, name, appearance.clone())?
            }
            None => {
                // 关掉页面又回来，想接着用同一个名字：同名且没人握着的化身就地接着当
                // （在场就留在原地，离场就回上次的位置），免得每次开关标签页都多留一个魂儿在名册里。
                let reuse = self
                    .world
                    .avatars()
                    .find(|a| {
                        a.name.trim() == name.trim()
                            && !self.avatar_held_by_other(connection, &a.id)
                    })
                    .map(|a| a.id.clone());
                match reuse {
                    Some(id) => {
                        // 接管前把断线的旧控制清掉，否则它在恢复窗口到期时会把刚接手的这具身体带走。
                        let stale: Vec<u64> = self
                            .avatar_controls
                            .iter()
                            .filter(|(c, control)| **c != connection && control.avatar == id)
                            .map(|(c, _)| *c)
                            .collect();
                        for dead in stale {
                            self.avatar_controls.remove(&dead);
                        }
                        self.world.avatar_enter_as(&id, name, appearance.clone())?
                    }
                    None => self.world.avatar_enter(name, appearance.clone())?,
                }
            }
        };
        self.grant_control(connection, avatar);
        Ok(())
    }

    /// 附身村民：内核接管，村民会话清掉在途请求与等待。同一连接对同一村民重复附身算成功。
    /// 一个连接一次只控制一个目标；别的页面控制什么不影响这里（附身与化身可以并存）。
    fn take_over(&mut self, connection: u64, resident: &str) -> Result<(), AvatarFailure> {
        if self
            .controlled_avatar(connection)
            .is_some_and(|a| a == resident)
        {
            return Ok(());
        }
        if self.controlled_avatar(connection).is_some() {
            return Err(AvatarFailure::Occupied("请先交还当前控制目标"));
        }
        // 同一个村民只能有一个控制者：别的页面正握着这个村民就等它交还。
        if self.world.is_possessed(resident) {
            return Err(AvatarFailure::Occupied("这个村民正在别的页面手里"));
        }
        self.world.possess_actor(resident)?;
        self.driver
            .runtime
            .player_handover(&mut self.world, resident)?;
        self.grant_control(connection, resident.to_owned());
        Ok(())
    }

    /// 断线后凭恢复凭据接回控制。重连会换一个连接编号，所以要在所有账本里找这个凭据。
    fn resume_control(&mut self, connection: u64, token: &str) -> Result<(), AvatarFailure> {
        if self.avatar_controls.is_empty() {
            return Err(AvatarFailure::ControlLost("恢复窗口已结束，请重新进入"));
        }
        let found = self
            .avatar_controls
            .iter()
            .find(|(_, c)| c.lease.as_ref().is_some_and(|l| l.resumable_with(token)))
            .map(|(old, c)| (*old, c.avatar.clone()));
        let Some((old, avatar)) = found else {
            return Err(AvatarFailure::ControlLost("恢复凭据已失效"));
        };
        if old != connection {
            self.avatar_controls.remove(&old);
        }
        self.grant_control(connection, avatar);
        Ok(())
    }

    /// 交还控制：附身的村民还给 AI，化身离场；这个连接的账本清掉。
    fn release_player(&mut self, connection: u64) -> Result<(), AvatarFailure> {
        let avatar = self.controlled_avatar(connection);
        // 只交还这个连接自己控制的那个目标：附身的村民给回 AI，化身离场。
        if let Some(id) = avatar.clone().filter(|id| self.world.is_possessed(id)) {
            self.world.release_possession_of(&id);
            self.world
                .record_player_event(&id, json!({"kind":"release"}));
            self.driver.runtime.player_handover(&mut self.world, &id)?;
        } else if let Some(avatar) = &avatar {
            self.world.avatar_leave_of(avatar)?;
        }
        self.avatar_controls.remove(&connection);
        Ok(())
    }

    /// 断线超时或控制目标死亡时交还控制；失败时状态已恢复，下一拍再试。
    pub(super) fn release_player_safely(&mut self, connection: u64) {
        if let Err(aborted) = self.transact(|rt| rt.release_player(connection)) {
            if let Some(control) = self.avatar_controls.get_mut(&connection) {
                control.halt();
            }
            // 存盘失败已由检查点记日志，这里只记其他原因，不每拍刷屏。
            if let Abort::Rejected(error) = &aborted.cause {
                eprintln!("[host] 交还控制失败：{error}");
            }
        }
    }

    fn next_action_id(&self, connection: u64) -> Result<String, AvatarFailure> {
        let avatar = self.avatar_of_control(connection)?;
        let p = self
            .world
            .actor_control(&avatar)
            .ok_or_else(|| AvatarFailure::Rejected("没有玩家控制目标".into()))?;
        Ok(format!("control/{}/{}", p.epoch, p.last_sequence + 1))
    }
}
