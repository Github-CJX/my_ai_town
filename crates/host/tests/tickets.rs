//! 入场票：世界只认管理服务用世界口令签的票。票里写着是谁、能不能改世界。
//! 没有口令时（本机自己开的小镇、测试夹具）世界不验票，仍按「管理员」放行。
use crate::support::*;
use host::ticket::{sign, Ticket};
use serde_json::json;
use std::net::TcpStream;
use tungstenite::WebSocket;

/// 世界的口令：只有管理服务和 host 进程知道，页面上看不到。
const SECRET: &str = "world-secret";

/// 票的到期时刻：用例里给一个远在未来的值。票面不写镇号（这个用例的世界没配 `--town-id`）。
const EXPIRES: u64 = 4_000_000_000;

fn admin_ticket() -> String {
    sign(SECRET, &Ticket::user("u-admin", true, "town-ticket", EXPIRES))
}

fn plain_ticket() -> String {
    sign(
        SECRET,
        &Ticket::user("u-plain", false, "town-ticket", EXPIRES),
    )
}

/// 开了口令的小镇：连接地址上必须带 `session` 和 `ticket`。
fn town_with_token() -> Town {
    let mut town = Town::new();
    town.args = vec!["--connection-token".into(), SECRET.into()];
    town
}

fn plain_socket(town: &Town, query: &str) -> Result<WebSocket<TcpStream>, String> {
    let port = town.port.expect("世界应该已经在监听");
    let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
    tungstenite::client(format!("ws://127.0.0.1:{port}/?{query}"), stream)
        .map(|(ws, _)| ws)
        .map_err(|e| e.to_string())
}

/// 没有票的连接进不来：管理服务之外的人就算猜到端口也没法直接改世界。
#[test]
fn a_connection_without_a_ticket_is_turned_away() {
    let mut town = town_with_token();
    town.query = Some(format!("session={SECRET}"));
    let refused = town.try_start().expect_err("没带票的连接应该被拒");
    assert!(refused.contains("403"), "{refused}");
    town.kill();
}

/// 票被改过一个字就不认：签名对不上。
#[test]
fn a_tampered_ticket_is_turned_away() {
    let mut town = town_with_token();
    let mut broken = admin_ticket();
    let swap = if &broken[3..4] == "0" { "1" } else { "0" };
    broken.replace_range(3..4, swap);
    town.query = Some(format!("session={SECRET}&ticket={broken}"));
    let refused = town.try_start().expect_err("改过的票应该被拒");
    assert!(refused.contains("403"), "{refused}");
    town.kill();
}

/// 管理员票能改世界设置；普通账号的票能看能玩，但改不了。
#[test]
fn only_an_admin_ticket_may_change_the_world() {
    let mut town = town_with_token();
    town.query = Some(format!("session={SECRET}&ticket={}", admin_ticket()));
    let mut admin = town.start();
    until(&mut admin, |m| m["type"] == "roster");

    let mut plain = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", plain_ticket()),
    )
    .expect("普通账号的票应该能连上");
    until(&mut plain, |m| m["type"] == "roster");
    // 看是能看的
    send(&mut plain, json!({"type": "get_population"}));
    until(&mut plain, |m| m["type"] == "population");
    // 改就不行
    send(
        &mut plain,
        json!({"type": "set_speed", "request_id": "r1", "speed": 1.0}),
    );
    let refused = until(&mut plain, |m| m["type"] == "error");
    let message = refused["message"].as_str().unwrap_or_default();
    assert!(message.contains("只有管理员可以调速度"), "{message}");

    town.kill();
}

/// 附身村民＝替他做决定：普通账号的票会被世界拒掉，不只是页面不提供入口。
#[test]
fn a_plain_ticket_cannot_possess_a_resident() {
    let mut town = town_with_token();
    town.query = Some(format!("session={SECRET}&ticket={}", admin_ticket()));
    let mut admin = town.start();
    until(&mut admin, |m| m["type"] == "roster");
    let resident = join_id(&mut admin, "tpl_a");

    let mut plain = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", plain_ticket()),
    )
    .expect("普通账号的票应该能连上");
    until(&mut plain, |m| m["type"] == "roster");
    let population = reply(&mut plain, json!({"type": "get_population"}), "population");
    send(
        &mut plain,
        json!({
            "type": "avatar",
            "world_id": population["population"]["world_id"],
            "request_id": "possess-1",
            "command": {"kind": "possess", "resident": resident},
        }),
    );
    let refused = until(&mut plain, |m| {
        m["type"] == "avatar_result" || m["type"] == "error"
    });
    let text = refused.to_string();
    assert!(text.contains("只有管理员可以附身村民"), "{text}");
    assert_eq!(refused["ok"], false, "{text}");

    town.kill();
}
