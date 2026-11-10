//! 化身的每拍处理：控制目标死亡或断线超时就交还，附身的村民走到了就交给玩家，二维地图按方向移动，
//! 交谈轮到玩家太久没说话就代为倾听。每个连接各管自己的控制账本。
use crate::{network::Clients, runtime::Runtime};
use protocol::InteractionCommand;
use std::time::{Duration, Instant};

/// 二维地图的方向输入超过这么久没更新就停下：模拟循环卡了很久之后，也最多按这么久走一段。
const INPUT_TIMEOUT: Duration = Duration::from_millis(350);
/// 交谈轮到玩家后等这么久（或玩家已断线）就代为倾听，不让整场交谈卡住。
const TURN_WAIT: Duration = Duration::from_secs(60);

impl Runtime {
    pub(crate) fn avatar_tick(&mut self, _clients: &Clients) {
        let now = Instant::now();
        // 附身的村民走到了：交给玩家。存盘失败时撤回，下一拍再试；失败日志由检查点记。
        // 每个连接只管自己附身的那一个村民，别人附身的村民走到了不关这一页的事。
        let awaiting = self
            .avatar_controls
            .values()
            .map(|c| c.avatar.clone())
            .filter(|id| self.world.possession_arrived_of(id))
            .collect::<Vec<_>>();
        for id in awaiting {
            let _ = self.transact(|rt| {
                rt.world.activate_possession_of(&id);
                Ok::<_, std::convert::Infallible>(())
            });
        }
        for connection in self.avatar_controls.keys().copied().collect::<Vec<_>>() {
            self.avatar_tick_of(connection, now);
        }
    }

    fn avatar_tick_of(&mut self, connection: u64, now: Instant) {
        let elapsed = match self.avatar_controls.get_mut(&connection) {
            Some(control) => control
                .last_tick
                .replace(now)
                .map(|last| now.duration_since(last))
                .unwrap_or_default(),
            None => return,
        };
        let Some(avatar) = self.controlled_avatar(connection) else {
            return;
        };
        // 控制目标死亡：交还控制。
        if self
            .world
            .actor(&avatar)
            .is_some_and(|a| a.needs.incapacitated() && a.needs.body.dead)
        {
            self.release_player_safely(connection);
            return;
        }
        let lapsed = match self
            .avatar_controls
            .get_mut(&connection)
            .and_then(|c| c.lease.as_mut())
        {
            Some(lease) => lease.lapse(now),
            None => return,
        };
        if lapsed {
            if let Some(control) = self.avatar_controls.get_mut(&connection) {
                control.halt();
            }
        }
        let (expired, online) = match self
            .avatar_controls
            .get_mut(&connection)
            .and_then(|c| c.lease.as_mut())
        {
            Some(lease) => (lease.expired(), lease.online()),
            None => return,
        };
        if expired {
            self.release_player_safely(connection);
            return;
        }
        if !online {
            if let Some(control) = self.avatar_controls.get_mut(&connection) {
                control.halt();
            }
        }
        self.advance_avatar(connection, now);
        if self.save_failed || self.speed <= 0. || !self.world_settings.ready() {
            if let Some(control) = self.avatar_controls.get_mut(&connection) {
                control.halt();
            }
            return;
        }
        self.listen_when_turn_waits(connection, online, elapsed);
    }

    /// 按方向输入把化身走到 until 这一刻：从上次走到的时刻算起，按真实经过的时间走，
    /// 输入到达 INPUT_TIMEOUT 后还没续上就停在那一刻。每拍和每来一条输入各调一次，
    /// 走的路就和玩家按住方向的时长一致，不随模拟循环一拍的长短（实际约 107 毫秒）忽快忽慢。
    /// 暂停、存盘失败、世界没设好时只记下时刻、不走；撞墙之类走不动时原地不动，不需要回执。
    pub(super) fn advance_avatar(&mut self, connection: u64, until: Instant) {
        let Some(control) = self.avatar_controls.get(&connection) else {
            return;
        };
        let avatar = control.avatar.clone();
        let (direction, run, moved_at, input_at) = (
            control.direction,
            control.run,
            control.moved_at,
            control.input_at,
        );
        let Some(from) = moved_at else {
            if let Some(control) = self.avatar_controls.get_mut(&connection) {
                control.moved_at = Some(until);
            }
            return;
        };
        // 上一拍处理期间到的输入，取出来时已经走过它到达的那一刻：从走到的地方接着算，不倒回去重走
        let until = until.max(from);
        if let Some(control) = self.avatar_controls.get_mut(&connection) {
            control.moved_at = Some(until);
        }
        let end = input_at.map_or(from, |at| (at + INPUT_TIMEOUT).min(until));
        if end <= from
            || direction == [0., 0.]
            || self.save_failed
            || self.speed <= 0.
            || !self.world_settings.ready()
        {
            return;
        }
        // 内核一次最多收 10 模拟分钟（最高倍率下一拍约 8 分钟）
        let minutes = ((end - from).as_secs_f64() * self.normal_pace()).min(10.);
        let _ = self.world.avatar_move_of(&avatar, direction, run, minutes);
    }

    /// 交谈轮到玩家：同一次轮到（同一聊天、同一动作版本）累计等待，超时或断线就代为倾听。
    fn listen_when_turn_waits(&mut self, connection: u64, online: bool, elapsed: Duration) {
        let Some(actor) = self.controlled_avatar(connection) else {
            return;
        };
        let turn = self
            .world
            .active_chat(&actor)
            .filter(|_| self.world.chat_turn(&actor))
            .map(|i| {
                let revision = self.world.actor(&actor).map_or(0, |a| a.actions.revision);
                (i.id.clone(), revision)
            });
        let Some((id, revision)) = turn else {
            if let Some(control) = self.avatar_controls.get_mut(&connection) {
                control.turn = None;
            }
            return;
        };
        let waited = match self
            .avatar_controls
            .get(&connection)
            .and_then(|c| c.turn.as_ref())
        {
            Some((old, r, d)) if *old == id && *r == revision => *d + elapsed,
            _ => Duration::ZERO,
        };
        if let Some(control) = self.avatar_controls.get_mut(&connection) {
            control.turn = Some((id.clone(), revision, waited));
        }
        if online && waited < TURN_WAIT {
            return;
        }
        let command_id = format!("control/auto-listen/{:032x}", rand::random::<u128>());
        // 轮次已经过去等情况下倾听会被拒绝，这时什么也不用做。
        let _ = self.world.avatar_interact_of(
            &actor,
            &command_id,
            revision,
            &InteractionCommand::Listen { interaction_id: id },
        );
        if let Some(control) = self.avatar_controls.get_mut(&connection) {
            control.turn = None;
        }
        // 存盘失败由检查点自己记日志，下一拍再存。
        let _ = self.checkpoint(true);
    }
}
