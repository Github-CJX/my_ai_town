//! 传讯：隔着地方递到对方手上的一封信。
//!
//! 交谈（`InteractionKind::Talk`）要求两个人此刻站在一处、占着身体、轮着说；传讯都不要求：
//! 它只在写信人和收信人各自的事实里各留一条 `FactKind::Letter`，正文原话另存一份进
//! `WorldFact.letter`，前端与 QQ 桥据此直接读，不用再从中文正文里拆。
//!
//! 谁写给谁由调用方给定，世界只核对两件事：两个人都得在镇子里有过这么一位，信不能是空的。

use crate::error::{KernelError, Result};
use crate::World;
use protocol::LetterFact;

/// 一封信最长多少字。和镇里说话同一把尺子。
use crate::interactions::MESSAGE_MAX_CHARS;

impl World {
    /// 写一封信给 `to`，返回**收信人**那边的事件编号（回信会引用它）。
    pub fn send_letter(&mut self, from: &str, to: &str, text: &str) -> Result<u64> {
        self.deliver_letter(from, to, text, None)
    }

    /// 回一封信。`reply_to` 为空时，引用自己最近收到的那封来自 `to` 的传讯。
    pub fn reply_letter(
        &mut self,
        from: &str,
        to: &str,
        text: &str,
        reply_to: Option<u64>,
    ) -> Result<u64> {
        let quoted = reply_to.or_else(|| self.last_letter_from(from, to));
        self.deliver_letter(from, to, text, quoted)
    }

    /// 自己最近收到的一封来自某人的传讯：回信时不用再记编号。
    pub fn last_letter_from(&self, actor: &str, from: &str) -> Option<u64> {
        self.actors
            .get(actor)?
            .journal
            .events_after(0)
            .iter()
            .rev()
            .find(|event| {
                event
                    .letter
                    .as_ref()
                    .is_some_and(|letter| letter.from == from && letter.to == actor)
            })
            .map(|event| event.event_id)
    }

    /// 最近一位给这位写信的人。回信时按名字对不上（比如同名处有不止一个化身）就靠它。
    pub fn last_letter_sender(&self, actor: &str) -> Option<String> {
        self.actors
            .get(actor)?
            .journal
            .events_after(0)
            .iter()
            .rev()
            .find_map(|event| {
                let letter = event.letter.as_ref()?;
                (letter.to == actor).then(|| letter.from.clone())
            })
    }

    pub fn actor_named(&self, name: &str) -> Option<String> {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        let mut found = self
            .actors
            .iter()
            .filter(|(_, actor)| actor.name == name)
            .map(|(id, _)| id.clone());
        let first = found.next()?;
        // 同名时优先不是化身的那个：化身是同一个账号临时借用的身体。
        if let Some(rest) = found.next() {
            let is_avatar = |id: &str| self.actors.get(id).is_some_and(|a| a.is_avatar());
            if is_avatar(&first) && !is_avatar(&rest) {
                return Some(rest);
            }
        }
        Some(first)
    }

    fn deliver_letter(
        &mut self,
        from: &str,
        to: &str,
        text: &str,
        reply_to: Option<u64>,
    ) -> Result<u64> {
        let text = text.trim();
        ensure!(!text.is_empty(), KernelError::interaction("信上什么都没写"));
        ensure!(
            text.chars().count() <= MESSAGE_MAX_CHARS,
            KernelError::interaction(format!("一封信不能超过 {MESSAGE_MAX_CHARS} 字"))
        );
        ensure!(from != to, KernelError::interaction("不能给自己写信"));
        let sender = self
            .actors
            .get(from)
            .map(|actor| actor.name.clone())
            .ok_or_else(|| KernelError::NoSuchActor(from.into()))?;
        let receiver = self
            .actors
            .get(to)
            .map(|actor| actor.name.clone())
            .ok_or_else(|| KernelError::NoSuchActor(to.into()))?;
        let at = self.minutes;
        let objects = vec![from.to_string(), to.to_string()];
        let letter = |text: &str| LetterFact {
            from: from.into(),
            to: to.into(),
            text: text.into(),
            reply_to,
        };
        let (they_read, i_read) = if reply_to.is_some() {
            (
                format!("{sender} 回了你的传讯：{text}"),
                format!("你回给 {receiver}：{text}"),
            )
        } else {
            (
                format!("{sender} 传讯给你：{text}"),
                format!("你传讯给 {receiver}：{text}"),
            )
        };
        let event_id = self
            .actors
            .get_mut(to)
            .expect("收信人刚查过")
            .journal
            .letter_fact(at, they_read, objects.clone(), letter(text));
        self.actors
            .get_mut(from)
            .expect("写信人刚查过")
            .journal
            .letter_fact(at, i_read, objects, letter(text));
        Ok(event_id)
    }
}
