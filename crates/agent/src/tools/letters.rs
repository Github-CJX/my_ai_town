//! 传讯工具：给镇里某个人写一封信。
//!
//! 传讯不占身体、不要求两个人在一处（交谈才有这些要求），所以这里不等空闲：睡着、正忙着、
//! 走在路上都能写。收信人先按名字对，对不上再按编号；有来信时优先回到那位来信的人，
//! 因为同名的地方可能站着不只一个化身，回错人信就递到别人手上了。
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Write {
    to: String,
    text: String,
}

pub(super) fn write(ctx: &mut ToolContext, call: &ToolCall) -> Result<ToolOutcome, ToolError> {
    let a: Write = decode(&call.arguments)?;
    let me = ctx.session.actor_id.clone();
    let to = a.to.trim().to_string();
    let receiver = recipient(ctx, &me, &to).ok_or_else(|| {
        ToolError::new(
            ToolErrorKind::Rejected,
            format!("镇上没有叫「{to}」的人：to 填名字（或者他的编号）"),
        )
    })?;
    let event_id = ctx
        .world
        .reply_letter(&me, &receiver, &a.text, None)
        .map_err(|error| ToolError::new(ToolErrorKind::World, error.to_string()))?;
    complete(json!({
        "sent_to": receiver,
        "letter": event_id,
        "note": "信递过去了。等回信、接着做自己的事都行，不用一直守着。",
    }))
}

fn recipient(ctx: &ToolContext, me: &str, to: &str) -> Option<String> {
    if to.is_empty() {
        return None;
    }
    if let Some(sender) = ctx.world.last_letter_sender(me) {
        let same = sender == to || ctx.world.actor(&sender).is_some_and(|a| a.name == to);
        if same {
            return Some(sender);
        }
    }
    if ctx.world.actor(to).is_some() && to != me {
        return Some(to.to_string());
    }
    ctx.world.actor_named(to).filter(|id| id != me)
}
