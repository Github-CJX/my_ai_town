//! 化身与附身：连接的控制租约、命令事务、方向输入、每拍的超时处理、发给控制者的状态。
//! 网络层不处理世界规则，世界规则在内核。
mod command;
mod input;
mod lease;
mod tick;
mod view;

use crate::{
    network::{self, Clients, NetworkEvent},
    runtime::Runtime,
};
use command::{AvatarFailure, AvatarRequest};
use lease::Lease;
use protocol::{ClientMsg, ServerMsg};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// 一个连接的控制账本：控制谁、最近的方向输入、交谈轮到玩家后等了多久。不存档。
/// 一个连接最多控制一个目标；多个连接各控各的化身，见 `Runtime::avatar_controls`。
#[derive(Clone)]
pub(crate) struct Control {
    lease: Option<Lease>,
    /// 这个连接操控的演员编号：自己的化身（`player_avatar`、`player_avatar@2`…）或附身的村民。
    avatar: String,
    direction: [f64; 2],
    /// 最近的方向输入按住了奔跑键。
    run: bool,
    input_sequence: u64,
    input_at: Option<Instant>,
    /// 化身已经按方向输入走到了哪一刻：下一段从这里算起（见 tick.rs 的 advance_avatar）。
    moved_at: Option<Instant>,
    /// 轮到玩家发言的聊天、当时的动作版本与已等待的时长。
    turn: Option<(String, u64, Duration)>,
    last_tick: Option<Instant>,
}

impl Default for Control {
    fn default() -> Self {
        Control {
            lease: None,
            avatar: kernel::avatar::ID.into(),
            direction: [0., 0.],
            run: false,
            input_sequence: 0,
            input_at: None,
            moved_at: None,
            turn: None,
            last_tick: None,
        }
    }
}

impl Control {
    fn halt(&mut self) {
        self.direction = [0., 0.];
    }
    /// 有人在控制化身或附身的村民（含断线后的恢复窗口）。
    pub(crate) fn held(&self) -> bool {
        self.lease.is_some()
    }
}

impl Runtime {
    /// 这个连接当前的租约；没有控制权时为空。
    fn lease(&self, connection: u64) -> Option<&Lease> {
        self.avatar_controls
            .get(&connection)
            .and_then(|c| c.lease.as_ref())
    }

    /// 这个连接操控的演员编号。
    pub(crate) fn controlled_avatar(&self, connection: u64) -> Option<String> {
        self.avatar_controls
            .get(&connection)
            .filter(|c| c.lease.is_some())
            .map(|c| c.avatar.clone())
    }

    /// 还有没有别的连接在控制世界里的谁。
    pub(crate) fn anyone_controlled(&self) -> bool {
        self.avatar_controls.values().any(Control::held)
    }

    /// 这个化身是不是正握在别的连接手里（复制标签页会把 sessionStorage 一起带过去）。
    /// 只算在线的租约：页面关掉后还在恢复窗口里的旧连接不该继续占着这具身体。
    pub(crate) fn avatar_held_by_other(&self, connection: u64, avatar: &str) -> bool {
        self.avatar_controls.iter().any(|(id, c)| {
            *id != connection && c.avatar == avatar && c.lease.as_ref().is_some_and(|l| l.online())
        })
    }

    pub(crate) fn network_command(&mut self, event: NetworkEvent, clients: &Clients) {
        match event {
            // 名册下一拍就有；村民的细节变了才发，新连接得单独补一份。
            NetworkEvent::Connected(id) => {
                for (resident, detail) in self.driver.details(&self.world) {
                    network::send_to(clients, id, &ServerMsg::ResidentDetail { resident, detail });
                }
            }
            NetworkEvent::Disconnected(id) => {
                if let Some(lease) = self
                    .avatar_controls
                    .get_mut(&id)
                    .and_then(|c| c.lease.as_mut())
                    .filter(|l| l.connection == id)
                {
                    lease.disconnect(Instant::now());
                    if let Some(control) = self.avatar_controls.get_mut(&id) {
                        control.halt();
                    }
                    // 存盘失败由检查点自己记日志；断线本身不需要回执。
                    let _ = self.checkpoint(true);
                }
            }
            NetworkEvent::Command {
                connection,
                message,
            } => match *message {
                ClientMsg::Avatar {
                    world_id,
                    request_id,
                    epoch,
                    sequence,
                    command,
                } => self.avatar_command(
                    connection,
                    AvatarRequest {
                        world_id,
                        request_id,
                        epoch,
                        sequence,
                        command,
                    },
                    clients,
                ),
                message @ ClientMsg::AvatarInput { .. } => {
                    self.avatar_input(connection, message, Instant::now())
                }
                other => self.command(connection, other, clients),
            },
        }
    }

    /// 命令或输入带的控制代次必须是这个连接当前在线的租约。
    fn check_control(&self, connection: u64, epoch: &str) -> Result<(), AvatarFailure> {
        if self
            .lease(connection)
            .is_some_and(|l| l.admits(connection, epoch))
        {
            Ok(())
        } else {
            Err(AvatarFailure::ControlLost("你离开了一会儿，已自动退出控制"))
        }
    }

    /// 授予新租约：之前的输入、位置上报与交谈等待都清掉，内核记下新的控制代次。
    fn grant_control(&mut self, connection: u64, avatar: String) {
        let lease = Lease::grant(connection);
        self.world
            .avatar_control_epoch_of(&avatar, lease.epoch.clone());
        self.avatar_controls.insert(
            connection,
            Control {
                lease: Some(lease),
                avatar,
                ..Default::default()
            },
        );
    }

    /// 每拍给每个在线的控制者发一次他自己的化身状态。
    pub(crate) fn avatar_publish(&self, clients: &Clients) {
        let online: BTreeMap<u64, _> = self
            .avatar_controls
            .iter()
            .filter_map(|(connection, c)| {
                c.lease
                    .as_ref()
                    .filter(|l| l.online())
                    .map(|l| (*connection, l.connection))
            })
            .collect();
        for connection in online.into_values() {
            network::send_to(
                clients,
                connection,
                &ServerMsg::AvatarState {
                    state: self.avatar_session(connection),
                },
            );
        }
    }
}
