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
                let notes = self.receipt_note(&to);
                Outcome::reply(ServerMsg::LetterSent {
                    request_id,
                    ok: true,
                    message: receipt(&name, &notes),
                    letter: letter.map(Box::new),
                })
                .persisted()
            }
            Err(error) => Outcome::reply(refused(request_id, &error.to_string())),
        }
    }

    /// 信递到了，可她此刻未必看得到：把「世界停着 / 睡着 / 正忙 / 没法回话」缀在回执后面。
    ///
    /// 主人在 QQ 里看不见镇里发生了什么。没有这几个字，他分不清「她没收到」「收到了还没空看」
    /// 与「她根本没法回话」，只能干等。这些只是**说明**：信照常写进世界事实，一件都不少。
    fn receipt_note(&self, to: &str) -> Vec<String> {
        let mut notes = Vec::new();
        if self.speed == 0.0 {
            notes.push("小镇现在停着，等跑起来她才看得到".to_string());
        } else if !self.world.awake(to) {
            notes.push("她这会儿睡着（或者动不了），醒了会看到".to_string());
        } else if self
            .world
            .actor(to)
            .is_some_and(|actor| actor.current.advancing())
        {
            notes.push("她正忙，信先搁下，做完手上的事就看".to_string());
        }
        let missing =
            self.driver
                .missing_models(&self.population, &self.settings, &self.owner_keys);
        if let Some(reason) = missing.get(to) {
            notes.push(format!("她现在没法回话：{reason}"));
        }
        notes
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

/// 递信回执：一句「到手了」，后面缀上她此刻的状态说明（可能一条也没有）。
fn receipt(name: &str, notes: &[String]) -> String {
    if notes.is_empty() {
        format!("信递到「{name}」手上了")
    } else {
        format!("信递到「{name}」手上了：{}", notes.join("；"))
    }
}

#[cfg(test)]
mod tests {
    use super::receipt;

    #[test]
    fn a_receipt_says_where_the_letter_went_and_why_she_may_not_read_it_yet() {
        assert_eq!(receipt("大肥鱼", &[]), "信递到「大肥鱼」手上了");
        assert_eq!(
            receipt("大肥鱼", &["小镇现在停着，等跑起来她才看得到".into()]),
            "信递到「大肥鱼」手上了：小镇现在停着，等跑起来她才看得到"
        );
        // 两条并列：睡着时也可能没配模型，两件事都要说，不能让后一条盖掉前一条
        let both = receipt(
            "大肥鱼",
            &[
                "她这会儿睡着（或者动不了），醒了会看到".into(),
                "她现在没法回话：没有选模型".into(),
            ],
        );
        assert_eq!(
            both,
            "信递到「大肥鱼」手上了：她这会儿睡着（或者动不了），醒了会看到；她现在没法回话：没有选模型"
        );
    }
}
