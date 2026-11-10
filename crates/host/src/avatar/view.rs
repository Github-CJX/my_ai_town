//! 发给控制者的化身状态：内核的化身视图加上 host 的世界编号、速度、租约与位置上报回执。
use crate::runtime::Runtime;
use protocol::{
    AvatarGoal, AvatarInteraction, AvatarLease, AvatarSession, AvatarView, InteractionStatus,
    RecentEvent,
};

/// 附身时给控制者看的本人近况条数。
const RECENT_EVENTS: usize = 12;

impl Runtime {
    /// 发给一个连接的化身状态：内核视图，加上世界编号、速度、租约、附身时的近况与目标、位置上报回执。
    /// 只发这个连接自己操控的那个人；没有控制权的连接是**观察者**，只拿到“地图支不支持化身”
    /// 这一层，不借用任何别人的视图（见手册 ADR-07 与 D.9）。
    pub(super) fn avatar_session(&self, connection: u64) -> AvatarSession {
        let control = self
            .avatar_controls
            .get(&connection)
            .filter(|c| c.lease.is_some());
        let lease = control.and_then(|c| c.lease.as_ref());
        let own = lease.is_some();
        // 别的页面正在玩：只用于前端显示“有人在玩”，不挡住本页进场，也不影响本页能看到什么。
        let occupied_elsewhere = !own && self.anyone_controlled();
        let (view, recent, goals) = match control {
            None => (self.world.watching_view(), None, None),
            Some(controlled) => {
                let avatar = controlled.avatar.as_str();
                let mut view = self.world.avatar_view_of(avatar);
                self.mark_reply_failures(&mut view);
                // 附身时才给近况与目标：只认这个连接自己操控的那一个村民。
                let possessed = self.world.possessed_actor(avatar);
                let recent = possessed.map(|a| {
                    a.journal
                        .events
                        .iter()
                        .rev()
                        .take(RECENT_EVENTS)
                        .map(|e| RecentEvent {
                            at: e.at,
                            text: e.text.clone(),
                        })
                        .collect()
                });
                let goals = possessed
                    .and_then(|a| self.driver.runtime.session(&a.id))
                    .map(|s| {
                        s.context_goals()
                            .iter()
                            .map(|g| AvatarGoal {
                                status: g.status,
                                text: g.title.clone(),
                            })
                            .collect()
                    });
                (view, recent, goals)
            }
        };
        let session = AvatarSession {
            view,
            world_id: self.population.world_id.clone(),
            // 化身每拍实际走的距离按它算（模拟分钟 / 秒），0 为暂停
            speed: self.normal_pace(),
            controlled: lease.is_some_and(|l| l.held_by(connection)),
            // 别的页面正在控制不算「本页进不去」：一个世界可以有多个化身，本页随时能另开一个。
            // 这个字段保留给前端显示「有人在玩」，不再用来挡住进场。
            occupied: occupied_elsewhere,
            recent,
            goals,
            lease: lease.map(|l| AvatarLease {
                epoch: l.epoch.clone(),
                resume_token: l.token.clone(),
                sequence: control
                    .and_then(|c| self.world.actor_control(&c.avatar))
                    .map(|p| p.last_sequence)
                    .unwrap_or(0),
            }),
            // 旧协议字段仅为兼容保留，不再启用前端位置上报。
            client_positions: false,
            // 步速只给自己的化身算：观察者照别人的步速预测小人没有意义。
            walk: control.and_then(|c| self.world.avatar_walk_of(&c.avatar)),
            position: None,
        };
        session
    }

    /// 受邀村民回应邀请的格式连续出错时，在邀请者看到的这条邀请上写明。
    fn mark_reply_failures(&self, view: &mut AvatarView) {
        let AvatarView::Present(state) = view else {
            return;
        };
        for item in &mut state.interactions {
            let (id, partner, status, response_error) = match item {
                AvatarInteraction::Chat(c) => (&c.id, &c.partner, c.status, &mut c.response_error),
                AvatarInteraction::Pair(p) => (&p.id, &p.partner, p.status, &mut p.response_error),
            };
            if status != InteractionStatus::Offered {
                continue;
            }
            let Some(failure) = self
                .driver
                .runtime
                .session(partner)
                .and_then(|s| s.invitation_reply_failure.as_ref())
                .filter(|f| f.invitation_ids.iter().any(|x| x == id))
            else {
                continue;
            };
            *response_error = Some(
                if failure.postponed() {
                    "模型连续返回了错误的回应格式，暂缓后会重试；你也可以取消邀请。"
                } else {
                    "模型返回的回应格式有误，正在尝试修正。"
                }
                .into(),
            );
        }
    }
}
