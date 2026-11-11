//! 村民用自己的密钥（BYOK）：世界只记在内存里，回执只有一句人话，名册里没有的人不会被收下；
//! 收回之后这把密钥跟着丢掉。
use crate::support::*;
use serde_json::json;

#[test]
fn a_resident_can_use_the_key_of_its_own_account() {
    let mut town = Town::new();
    // 世界的服务商名单里有这家，密钥却是空的：这正是普通账号投放的那名村民的情形
    town.write(
        "config/providers.json",
        json!({
            "active": {"provider": "deepseek", "model": "deepseek-chat"},
            "providers": [
                {"id": "deepseek", "name": "DeepSeek", "base_url": "https://api.deepseek.com"}
            ],
        }),
    );
    town.write("config/credentials.json", json!({}));
    town.mock_delay = Some("0.01".into());
    let mut ws = town.start();
    until(&mut ws, |m| m["type"] == "roster");
    // 投放时会连模型一起带上：世界这才知道他在用哪家的模型
    let joined = join_as(
        &mut ws,
        "tpl_a",
        None,
        Some(json!({"provider": "deepseek", "model": "deepseek-chat"})),
    );
    assert_eq!(joined["ok"], true, "{joined}");
    let id = joined["resident_id"].as_str().unwrap().to_string();

    let saved = reply(
        &mut ws,
        json!({
            "type": "set_resident_key",
            "request_id": "key-1",
            "resident": id,
            "provider": "deepseek",
            "base_url": "https://api.deepseek.com",
            "api_key": "sk-own",
        }),
        "resident_key_saved",
    );
    assert_eq!(saved["ok"], true, "{saved}");
    let message = saved["message"].as_str().unwrap();
    assert!(message.contains("他自己账号的密钥"), "{message}");
    // 回执里绝不带密钥：世界→页面 方向不出现密钥
    assert!(!message.contains("sk-own"), "回执里不该带密钥：{message}");

    // 名册里没有的人：说清楚，不偷偷答应
    let ghost = reply(
        &mut ws,
        json!({
            "type": "set_resident_key",
            "request_id": "key-2",
            "resident": "resident_ghost",
            "provider": "deepseek",
            "api_key": "sk-ghost",
        }),
        "resident_key_saved",
    );
    assert_eq!(ghost["ok"], false, "{ghost}");

    // 服务商与密钥要一起交过来
    let half = reply(
        &mut ws,
        json!({
            "type": "set_resident_key",
            "request_id": "key-3",
            "resident": id,
            "provider": "",
            "api_key": "",
        }),
        "resident_key_saved",
    );
    assert_eq!(half["ok"], false, "{half}");

    // 收回之后这把密钥跟着丢掉：再送就是名册里没有这个人了
    let removed = reply(
        &mut ws,
        json!({"type": "remove_resident", "request_id": "rm-1", "resident": id}),
        "resident_removed",
    );
    assert_eq!(removed["ok"], true, "{removed}");
    let late = reply(
        &mut ws,
        json!({
            "type": "set_resident_key",
            "request_id": "key-4",
            "resident": id,
            "provider": "deepseek",
            "api_key": "sk-own",
        }),
        "resident_key_saved",
    );
    assert_eq!(late["ok"], false, "{late}");

    // 世界照样在跑：名册与人群对得上
    let population =
        reply(&mut ws, json!({"type": "get_population"}), "population")["population"].clone();
    assert!(
        population["residents"].as_array().unwrap().is_empty(),
        "{population}"
    );
}
