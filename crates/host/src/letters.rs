//! 传讯：主人给名下村民递一封信，以及把往来信件读回来。
//!
//! 权限和白名单与「改人设」同一条路：只有投放她的账号（或管理员）能写；写信人永远取这位账号
//! 自己的化身，所以信里不会出现别人的身份。读信同理：只读自己化身那一本账，别人的信看不到。

use crate::network::{account_of, Clients};
use crate::runtime::{Outcome, Runtime};
use protocol::{LetterView, ServerMsg};

impl Runtime {
    /// 这位连接代表谁：票面账号编号 → 登记表里属于他的化身。
    fn my_avatar(&self, clients: &Clients, connection: u64) -> Option<String> {
        let account = account_of(clients, connection)?;
        self.owners.owned_by(&account).map(str::to_owned)
    }

    pub(crate) fn send_letter(
        &mut self,
        request_id: String,
        to: String,
        text: String,
        connection: u64,
        clients: &Clients,
    ) -> Outcome {
        let Some(from) = self.my_avatar(clients, connection) else {
            return Outcome::reply(refused(
                request_id,
                "还没有你的化身：先登进小镇、让镇长这个人站到镇上，再给她传讯",
            ));
        };
        let Some(receiver) = self.world.actor(&to) else {
            return Outcome::reply(refused(request_id, "镇上暂时没有这位村民"));
        };
        if receiver.is_avatar() {
            return Outcome::reply(refused(request_id, "传讯只递给镇里的村民"));
        }
        let name = receiver.name.clone();
        match self.world.send_letter(&from, &to, &text) {
            Ok(event_id) => {
                let letter = self
                    .world
                    .actor(&to)
                    .and_then(|actor| actor.journal.events_after(event_id - 1).first())
                    .and_then(|fact| self.letter_view(&from, fact));
                Outcome::reply(ServerMsg::LetterSent {
                    request_id,
                    ok: true,
                    message: format!("信递到「{name}」手上了"),
                    letter: letter.map(Box::new),
                })
                .persisted()
            }
            Err(error) => Outcome::reply(refused(request_id, &error.to_string())),
        }
    }

    /// 读自己化身与村民之间的传讯：只要那一本账里的事件，别的账号的信不会出现在这里。
    pub(crate) fn letters(
        &mut self,
        request_id: String,
        after: u64,
        connection: u64,
        clients: &Clients,
    ) -> Outcome {
        let Some(me) = self.my_avatar(clients, connection) else {
            return Outcome::reply(ServerMsg::Letters {
                request_id,
                letters: Vec::new(),
                cursor: after,
            });
        };
        let Some(actor) = self.world.actor(&me) else {
            return Outcome::reply(ServerMsg::Letters {
                request_id,
                letters: Vec::new(),
                cursor: after,
            });
        };
        let events = actor.journal.events_after(after);
        let cursor = events.last().map_or(after, |fact| fact.event_id);
        let letters: Vec<LetterView> = events
            .iter()
            .filter_map(|fact| self.letter_view(&me, fact))
            .collect();
        Outcome::reply(ServerMsg::Letters {
            request_id,
            letters,
            cursor,
        })
    }

    /// 一条世界事实读成一封信；不是传讯（或没有字条）就是 None。
    fn letter_view(&self, me: &str, fact: &protocol::WorldFact) -> Option<LetterView> {
        let letter = fact.letter.as_ref()?;
        let name = |id: &str| {
            self.world
                .actor(id)
                .map(|actor| actor.name.clone())
                .unwrap_or_else(|| id.to_string())
        };
        Some(LetterView {
            event_id: fact.event_id,
            at: fact.at,
            from: letter.from.clone(),
            from_name: name(&letter.from),
            to: letter.to.clone(),
            to_name: name(&letter.to),
            text: letter.text.clone(),
            reply_to: letter.reply_to,
            incoming: letter.to == me,
        })
    }
}

fn refused(request_id: String, message: &str) -> ServerMsg {
    ServerMsg::LetterSent {
        request_id,
        ok: false,
        message: message.into(),
        letter: None,
    }
}
