//! 传讯：两个人不必在一处，各在事实里留一条记录；回信引用原信；收信人忙着或睡着也收得到。
//! 传讯不占身体，所以这里不走 run_actions 与 interact，只核世界留下的事实。
use crate::common;
use kernel::World;
use protocol::FactKind;

fn world() -> World {
    common::world_with(
        common::two_places(serde_json::json!([])),
        600.0,
        &[("lin", "林晚", "loc_a"), ("zhou", "周岚", "loc_b")],
    )
}

#[test]
fn a_letter_leaves_a_fact_for_both_sides() {
    let mut w = world();
    let id = w
        .send_letter("lin", "zhou", "海边的风大，你带件外套。")
        .unwrap();

    let theirs = w.actor("zhou").unwrap().journal.events.clone();
    let received = theirs.iter().find(|e| e.event_id == id).unwrap();
    assert_eq!(received.kind, FactKind::Letter);
    assert_eq!(received.text, "林晚 传讯给你：海边的风大，你带件外套。");
    assert_eq!(
        received.objects,
        vec!["lin".to_string(), "zhou".to_string()]
    );
    let letter = received.letter.as_ref().unwrap();
    assert_eq!((letter.from.as_str(), letter.to.as_str()), ("lin", "zhou"));
    assert_eq!(letter.reply_to, None);

    let mine = w
        .actor("lin")
        .unwrap()
        .journal
        .events
        .iter()
        .find(|e| e.letter.is_some())
        .cloned()
        .unwrap();
    assert_eq!(mine.kind, FactKind::Letter);
    assert_eq!(mine.text, "你传讯给 周岚：海边的风大，你带件外套。");
    // 事件编号按人各自的流水算，两边各记一条，互不影响。
    assert_eq!(mine.event_id, id);
}

#[test]
fn a_reply_quotes_the_letter_it_answers() {
    let mut w = world();
    let id = w.send_letter("lin", "zhou", "在海边等你。").unwrap();
    assert_eq!(w.last_letter_from("zhou", "lin"), Some(id));
    // 不传编号：引自己最近收到的那封。
    let back = w.reply_letter("zhou", "lin", "这就来。", None).unwrap();

    let theirs = w.actor("lin").unwrap().journal.events.clone();
    let received = theirs.iter().find(|e| e.event_id == back).unwrap();
    assert_eq!(received.text, "周岚 回了你的传讯：这就来。");
    // 回信引的是收信人那边原信的事件编号。
    assert_eq!(received.letter.as_ref().unwrap().reply_to, Some(id));
    assert_eq!(w.last_letter_sender("lin").as_deref(), Some("zhou"));
}

#[test]
fn empty_oversized_self_and_unknown_letters_are_refused() {
    let mut w = world();
    assert!(w.send_letter("lin", "zhou", "   ").is_err());
    assert!(w.send_letter("lin", "zhou", &"字".repeat(401)).is_err());
    assert!(w.send_letter("lin", "lin", "自己给自己").is_err());
    assert!(w.send_letter("lin", "nobody", "喂").is_err());
    assert!(w.send_letter("nobody", "lin", "喂").is_err());
    // 一封都没送出去：两边的事实里都没有信。
    for actor in ["lin", "zhou"] {
        assert!(w
            .actor(actor)
            .unwrap()
            .journal
            .events
            .iter()
            .all(|e| e.letter.is_none()));
    }
}

#[test]
fn a_recipient_can_be_named_instead_of_numbered() {
    let w = world();
    assert_eq!(w.actor_named("周岚").as_deref(), Some("zhou"));
    assert_eq!(w.actor_named("  林晚 ").as_deref(), Some("lin"));
    assert_eq!(w.actor_named(""), None);
    assert_eq!(w.actor_named("谁也不是"), None);
}
