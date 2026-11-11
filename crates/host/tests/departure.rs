//! 收回村民：名册和世界里的都没有他了，剩下的人和住宅不受影响；同一个人不能再收一次。
use crate::support::*;
use serde_json::json;

#[test]
fn a_removed_resident_leaves_the_population_and_the_save() {
    let mut town = Town::new();
    let mut ws = town.start();
    until(&mut ws, |m| m["type"] == "roster");
    let gone = join(&mut ws, "tpl_a", None);
    assert_eq!(gone["ok"], true, "{gone}");
    let id = gone["resident_id"].as_str().unwrap().to_string();
    let kept = join(&mut ws, "tpl_b", None);
    assert_eq!(kept["ok"], true, "{kept}");
    let kept_id = kept["resident_id"].as_str().unwrap().to_string();

    // 收回不用世界观、也不要求小镇在跑
    send(
        &mut ws,
        json!({"type":"set_speed","request_id":"test-set-speed","speed":0}),
    );
    until(&mut ws, |m| m["type"] == "roster" && m["speed"] == 0.0);
    let removed = reply(
        &mut ws,
        json!({"type":"remove_resident","request_id":"rm-1","resident":id}),
        "resident_removed",
    );
    assert_eq!(removed["ok"], true, "{removed}");
    assert!(
        removed["message"].as_str().unwrap().contains("离开了小镇"),
        "{removed}"
    );
    // 名册里只剩留下的那个人，住宅随之空出来（下一个请来的人还能住进去）
    let population =
        reply(&mut ws, json!({"type":"get_population"}), "population")["population"].clone();
    let residents = population["residents"].as_array().unwrap();
    assert_eq!(residents.len(), 1);
    assert_eq!(residents[0]["id"], kept_id.as_str());
    assert!(
        residents[0]["home"] == "home_1" || residents[0]["home"] == "home_2",
        "{population}"
    );
    // 同一个人不能再收一次
    let again = reply(
        &mut ws,
        json!({"type":"remove_resident","request_id":"rm-2","resident":id}),
        "resident_removed",
    );
    assert_eq!(again["ok"], false, "{again}");

    // 存档读回来也没有他
    town.kill();
    drop(ws);
    let mut ws = town.start();
    let population =
        reply(&mut ws, json!({"type":"get_population"}), "population")["population"].clone();
    let residents = population["residents"].as_array().unwrap();
    assert_eq!(residents.len(), 1);
    assert_eq!(residents[0]["id"], kept_id.as_str());
    // 重启之后剩下的人照样收得回来
    let later = reply(
        &mut ws,
        json!({"type":"remove_resident","request_id":"rm-3","resident":kept_id}),
        "resident_removed",
    );
    assert_eq!(later["ok"], true, "{later}");
    let population =
        reply(&mut ws, json!({"type":"get_population"}), "population")["population"].clone();
    assert!(population["residents"].as_array().unwrap().is_empty());
    let saved = town.saved(|save| save["population"]["residents"].is_object());
    assert_eq!(
        saved["population"]["residents"].as_object().unwrap().len(),
        0,
        "收走的人不留在存档的名册里"
    );
}
