//! 收回一位村民：人从名册、附身和世界里一起消失，世界日志给留下的人留一句话；
//! 存档读回来也不再有他，同一个人不能被收回第二遍。
use crate::common;
use serde_json::json;

fn world() -> kernel::World {
    common::world_with(
        common::two_places(json!([])),
        600.,
        &[("a", "阿树", "loc_a"), ("b", "小叶", "loc_b")],
    )
}

#[test]
fn a_resident_who_leaves_is_gone_from_the_roster_possession_and_the_save() {
    let mut w = world();

    assert_eq!(w.leave("a").unwrap(), "阿树");
    assert!(w.actor("a").is_none());
    assert_eq!(w.actor_ids(), vec!["b".to_string()]);

    // 世界日志里留一句，留下的村民看得见
    let events = w.take_events();
    let logged = format!("{events:?}");
    assert!(logged.contains("离开了小镇"), "{logged}");

    // 名册里没有的人不能再走第二遍
    let again = w.leave("a").unwrap_err().to_string();
    assert!(again.contains("没有编号"), "{again}");

    // 存档读回来照样只有剩下的人
    let restored = common::restore(&w, world());
    assert!(restored.actor("a").is_none());
    assert!(restored.actor("b").is_some());
}
