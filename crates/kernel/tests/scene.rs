//! AI-WP-06 的跨场景验收：连续二十轮真实命令，每轮都核对
//! 「同一个人不在两个地方」「坐下不会叠成两次」「被拒绝的亲近不写进世界」「回执里的事件编号世界里查得到」。
use crate::common;
use kernel::{scene::SceneOutcome, world::ActKind, World};
use protocol::{ActionStatus, Gesture, InteractionCommand, InteractionKind};
use serde_json::{json, Value};

fn board(id: &str, name: &str, locale: &str, board: &str) -> Value {
    json!({
        "id": id, "name": name, "locale": locale, "board": board,
        "readable": {"work_id": format!("{id}-work"), "version": 1, "kind": "bulletin",
                     "title": "公告", "author": "佚名", "text": "今天照常开放",
                     "origin": {"kind": "builtin"}},
        "verbs": [{"verb": "阅读公告", "duration_minutes": 1,
                   "action": {"id": "read_bulletin", "label": "阅读公告",
                              "duration_minutes": 1, "completion": "read_bulletin"}}]
    })
}

fn holder(id: &str, name: &str, locale: &str) -> Value {
    json!({"id": id, "name": name, "locale": locale, "bulletin_board": true,
           "verbs": [{"verb": "查看支架", "duration_minutes": 1}]})
}

fn world() -> World {
    // 两处所各一块公告栏：走到哪都在同一套街道/书店/客厅处理器上。
    let topo = common::two_places(json!([
        board("board_a", "甲地公告栏", "loc_a", "holder_a"),
        board("board_b", "乙地公告栏", "loc_b", "holder_b"),
        holder("holder_a", "甲地公告栏支架", "loc_a"),
        holder("holder_b", "乙地公告栏支架", "loc_b"),
    ]));
    common::world_with(
        topo,
        420.0,
        &[("r1", "阿树", "loc_a"), ("r2", "周屿", "loc_a")],
    )
}

fn go(locale: &str) -> Value {
    json!({"intent": {"verb": "前往", "locale": locale}})
}

fn sit(minutes: f64) -> Value {
    json!({"intent": {"verb": "坐下", "duration_minutes": minutes}})
}

fn read(board: &str) -> Value {
    json!({"intent": {"verb": "阅读公告"}, "prop_id": board})
}

fn outcome(w: &World, actor: &str, group: &str) -> Value {
    let group = w.action_group(actor, group).expect("动作组应当还在世界上");
    let outcome = SceneOutcome::of_group(w, actor, group).expect("动作组应当有回执事实");
    serde_json::to_value(outcome).unwrap()
}

fn has_event(w: &World, actor: &str, id: u64) -> bool {
    w.actor(actor)
        .is_some_and(|a| a.journal.events.iter().any(|e| e.event_id == id))
}

/// 事件编号可核对：回执里写的每一条都要能在世界里找到。
fn events_are_real(w: &World, actor: &str, out: &Value) {
    for id in out["event_ids"].as_array().expect("回执应当带事件编号数组") {
        let id = id.as_u64().expect("事件编号是整数");
        assert!(
            has_event(w, actor, id),
            "回执里的事件编号 {id} 世界里查不到"
        );
    }
}

/// 同一个人只有一个位置：不在路上时，活动地点就是站着的地方。
fn one_place(w: &World) {
    for id in w.actor_ids() {
        let a = w.actor(&id).expect("名册上的人物都在世界里");
        let travelling = matches!(a.current.kind, ActKind::Travel { .. });
        assert!(
            ["loc_a", "loc_b", "edge_ab"].contains(&a.locus.locale.as_str()),
            "{id} 站在一个不存在的地方：{}",
            a.locus.locale
        );
        if !travelling {
            assert_eq!(
                a.locus.locale, a.current.locale,
                "{id} 同时出现在两个地方：站在 {}，活动还在 {}",
                a.locus.locale, a.current.locale
            );
        }
    }
}

fn offer_and_decline(w: &mut World, tag: usize) {
    let revision = w.actor("r2").unwrap().actions.revision;
    let offer = w
        .interact(
            "r2",
            &format!("offer{tag}"),
            revision,
            &InteractionCommand::Offer {
                partner_id: "r1".into(),
                interaction: InteractionKind::Touch {
                    gesture: Gesture::Hug,
                },
                message: "抱一下？".into(),
            },
        )
        .unwrap();
    let revision = w.actor("r1").unwrap().actions.revision;
    let reply = w
        .interact(
            "r1",
            &format!("reply{tag}"),
            revision,
            &InteractionCommand::Reply {
                interaction_id: offer.id.clone(),
                accept: false,
                message: "改天吧".into(),
            },
        )
        .unwrap();
    assert_eq!(reply.accepted, Some(false));
    let out = serde_json::to_value(SceneOutcome::of_interaction(w, "r1", &reply).unwrap()).unwrap();
    assert_eq!(out["status"], "declined");
    assert!(
        out["facts"]["touch"].is_null(),
        "被拒绝的亲近不该写成正在接触：{out}"
    );
    for i in w.interactions().for_actor("r1") {
        if matches!(i.kind, InteractionKind::Touch { .. }) && i.partner == "r2" {
            assert!(
                !matches!(
                    i.status,
                    protocol::InteractionStatus::Running | protocol::InteractionStatus::Succeeded
                ),
                "被拒绝之后还留着一次成功的亲近：{:?}",
                i.status
            );
        }
    }
}

#[test]
fn twenty_rounds_keep_one_place_one_sit_and_no_phantom_touch() {
    let mut w = world();
    for round in 0..20 {
        let target = if round % 2 == 0 { "loc_b" } else { "loc_a" };
        let group = format!("go{round}");
        common::run(&mut w, "r1", &group, go(target)).unwrap();
        let done = common::finish(&mut w, "r1", &group);
        assert_ne!(done.status, ActionStatus::Failed, "第 {round} 轮走不动");
        one_place(&w);
        assert_eq!(w.actor("r1").unwrap().locus.locale, target);

        let out = outcome(&w, "r1", &group);
        assert_eq!(out["status"], "succeeded");
        assert_eq!(out["facts"]["locale"], target);
        events_are_real(&w, "r1", &out);

        match round % 3 {
            0 => {
                // 坐下：坐着的时候回执说 sitting（撤不了）；再下一次坐下命令必须被挡回去，
                // 同一个人不会叠出两次坐下。
                let first = format!("sit{round}");
                common::run(&mut w, "r1", &first, sit(2.0)).unwrap();
                w.step(0.5);
                let out = outcome(&w, "r1", &first);
                assert_eq!(out["status"], "running");
                assert_eq!(out["facts"]["posture"], "sitting");
                assert_eq!(out["facts"]["verb"], "坐下");
                one_place(&w);

                let duplicate = common::run(&mut w, "r1", &format!("sit_again{round}"), sit(2.0));
                let refusal = format!("{:?}", duplicate.unwrap_err());
                assert!(
                    refusal.contains("已有身体动作执行中"),
                    "重复坐下应当被挡回去，实际：{refusal}"
                );

                common::finish(&mut w, "r1", &first);
                let after = outcome(&w, "r1", &first);
                assert_eq!(after["status"], "succeeded");
                assert_eq!(after["facts"]["posture"], "standing");
            }
            1 => {
                let board = if target == "loc_a" {
                    "board_a"
                } else {
                    "board_b"
                };
                let group = format!("read{round}");
                common::run(&mut w, "r1", &group, read(board)).unwrap();
                common::finish(&mut w, "r1", &group);
                let out = outcome(&w, "r1", &group);
                assert_eq!(out["status"], "succeeded");
                assert!(
                    !out["event_ids"].as_array().unwrap().is_empty(),
                    "读公告应当留下可以核对的事件"
                );
                events_are_real(&w, "r1", &out);
            }
            _ => {
                // 亲近只在同一个处所里提；r2 一直待在甲地。
                if target == "loc_a" {
                    offer_and_decline(&mut w, round);
                }
            }
        }
        one_place(&w);
    }
}
