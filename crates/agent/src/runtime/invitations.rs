//! 打招呼先唤醒思考；身体动作直到本人接受交谈才中断。
use super::{pending::ToolResult, RequestKind, ResidentRuntime};
use crate::{
    session::{PendingTool, Session},
    tools::ToolName,
};
use kernel::World;
use protocol::{FactKind, GroupStatus, InteractionStatus};
use serde_json::json;

impl ResidentRuntime {
    pub(super) fn react_to_notices(&mut self, world: &mut World, s: &mut Session) {
        let Some(a) = world.actor(&s.actor_id) else {
            return;
        };
        let notices: Vec<_> = a
            .journal
            .events_after(s.cursors.last_notice)
            .iter()
            .filter(|e| e.kind == FactKind::Notice)
            .cloned()
            .collect();
        let mut invited = false;
        for notice in notices {
            s.cursors.last_notice = notice.event_id;
            // 谁发来的邀请都算：交谈、同行、牵手/靠/抱。亲近不发话，但也要本人答一句才动手。
            let mine = notice.objects.iter().any(|id| {
                world.interactions().of(&s.actor_id, id).is_some_and(|i| {
                    i.event_ids
                        .get(&s.actor_id)
                        .is_some_and(|ids| ids.contains(&notice.event_id))
                })
            });
            let offer = notice.objects.iter().any(|id| {
                world.interactions().of(&s.actor_id, id).is_some_and(|i| {
                    i.partner == s.actor_id
                        && i.status == InteractionStatus::Offered
                        && i.event_ids
                            .get(&s.actor_id)
                            .is_some_and(|ids| ids.contains(&notice.event_id))
                })
            });
            if offer {
                invited = true;
            } else if mine {
                // 邀请的进展（自己答过的结果、过期、对方撤销）：结果已经回到对话里，
                // 都不该打断手上的安排——躲开一次不等于要停下手上的活。
            } else if s.pending.iter().any(|p| matches!(p, PendingTool::Actions { group_id, .. }
                if world.action_group(&s.actor_id, group_id).is_some_and(|g| g.status == GroupStatus::Running))) {
                world.interrupt_actions(&s.actor_id, &notice.text);
            } else if world.following(&s.actor_id).is_some() {
                // 跟着走的路上来了重要通知（饿了、累了、天气）：先退出同行，醒来自己决定。
                world.interrupt_actions(&s.actor_id, &notice.text);
            }
        }
        if !invited || !world.interactions().has_open_invitation(&s.actor_id) {
            return;
        }
        s.wake_up();
        // 工具调用必须先配对才能请求模型。返回真实的进行中状态，同时保留动作跟踪。
        for mut pending in std::mem::take(&mut s.pending) {
            if let PendingTool::Actions {
                call,
                group_id,
                reported_running,
            } = &mut pending
            {
                if !*reported_running {
                    if let Some(group) = world
                        .action_group(&s.actor_id, group_id)
                        .filter(|g| g.status == GroupStatus::Running)
                    {
                        let notice = format!(
                            "收到邀请，原动作仍在继续。可以用 {} 接受或拒绝；接受才会中断，最终动作结果另行通知。",
                            ToolName::ReplyInvitation
                        );
                        self.complete_tool(
                            world,
                            s,
                            ToolResult {
                                call,
                                value: json!({"ok":true,"group":group,"notice":notice}),
                                kind: RequestKind::Life,
                            },
                        );
                        *reported_running = true;
                    }
                }
            }
            s.pending.push(pending);
        }
    }
}
