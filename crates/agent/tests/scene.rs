//! AI-WP-06：一条世界命令结束后，模型拿到的是「场景结果」——世界给的状态、真正落进世界的事件编号，
//! 以及执行之后本人真实的位置、姿态、活动、身边的人和正在进行的接触。
use crate::support::*;
use agent::{budget::Limits, runtime::AgentRequest};
use kernel::World;
use protocol::{InteractionCommand as Command, InteractionKind};
use serde_json::{json, Value};
fn command(w: &mut World, actor: &str, key: &str, cmd: Command) {
    w.interact(actor, key, w.actor(actor).unwrap().actions.revision, &cmd)
        .unwrap();
}

/// 请求里出现的所有场景结果（工具结果可能包在别的字段里，逐层找）。
fn outcomes(q: &AgentRequest) -> Vec<Value> {
    fn walk(v: &Value, out: &mut Vec<Value>) {
        match v {
            Value::Object(map) => {
                if let Some(outcome) = map.get("outcome") {
                    out.push(outcome.clone());
                }
                map.values().for_each(|v| walk(v, out));
            }
            Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for message in &q.messages {
        if let Ok(value) = serde_json::from_str::<Value>(&message.content) {
            walk(&value, &mut out);
        }
    }
    out
}

#[test]
fn an_action_result_carries_status_events_and_real_facts() {
    let mut w = world();
    w.enable_agent("r1").unwrap();
    let mut r = runtime(&mut w, Limits::default());
    let q = life_request(&mut r, &mut w);
    reply(
        &mut r,
        &mut w,
        &q,
        "run_actions",
        json!({"actions":[{"intent":{"verb":"阅读公告"},"prop_id":"board"}]}),
    );
    w.step(2.);
    let group = w
        .actor("r1")
        .unwrap()
        .actions
        .groups
        .keys()
        .next()
        .unwrap()
        .clone();
    let q = request(&mut r, &mut w);
    let outcome = outcomes(&q)
        .into_iter()
        .find(|o| o["command_id"] == json!(group))
        .expect("动作结算要带回场景结果");
    assert_eq!(outcome["status"], json!("succeeded"));
    assert_eq!(outcome["facts"]["locale"], json!("loc_a"));
    assert_eq!(outcome["facts"]["posture"], json!("standing"));
    assert!(
        outcome["facts"]["place"]
            .as_str()
            .is_some_and(|p| !p.is_empty()),
        "场景结果要写明在哪个地点：{outcome}"
    );
    let ids = outcome["event_ids"].as_array().expect("事件编号是数组");
    assert!(
        !ids.is_empty(),
        "读过公告就要有事件编号，叙述才能和世界事件对上：{outcome}"
    );
}

#[test]
fn a_declined_touch_reports_declined_and_no_contact() {
    let mut w = world();
    w.spawn("r2", "周屿", "loc_a").unwrap();
    w.enable_agent("r1").unwrap();
    // 只有受控人物才能通过世界命令发起邀请；r2 不进运行器，只当发起方。
    w.enable_agent("r2").unwrap();
    let mut r = runtime(&mut w, Limits::default());
    command(
        &mut w,
        "r2",
        "hug-1",
        Command::Offer {
            partner_id: "r1".into(),
            interaction: InteractionKind::Touch {
                gesture: protocol::Gesture::Hug,
            },
            message: "抱一下？".into(),
        },
    );
    let q = request(&mut r, &mut w);
    reply(
        &mut r,
        &mut w,
        &q,
        "reply_invitation",
        json!({"interaction_id":"hug-1","accept":false,"message":"下次吧"}),
    );
    let q = request(&mut r, &mut w);
    let outcome = outcomes(&q)
        .into_iter()
        .find(|o| o["command_id"] == json!("hug-1"))
        .expect("回复邀请也要带回场景结果");
    assert_eq!(
        outcome["status"],
        json!("declined"),
        "被拒绝的亲近只能是 declined，不能写成 accepted：{outcome}"
    );
    assert!(
        outcome["facts"]["touch"].is_null(),
        "拒绝之后不能报成有接触：{outcome}"
    );
}
