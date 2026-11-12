//! 传讯在 host 这一层只做两件事：谁的信能递给她，以及账号还没有化身时说清楚。
//! 世界侧的事实由 kernel 的 letters 用例核对，这里只看关口与回执。
use crate::support::*;
use host::ticket::{sign, Ticket};
use serde_json::json;
use std::net::TcpStream;
use tungstenite::WebSocket;

/// 世界的口令：只有管理服务和 host 进程知道。
const SECRET: &str = "world-secret";
/// 票的到期时刻：用例里给一个远在未来的值。
const EXPIRES: u64 = 4_000_000_000;

fn admin_ticket() -> String {
    sign(
        SECRET,
        &Ticket::user("u-admin", true, true, "town-ticket", EXPIRES),
    )
}

/// 指定账号的票：世界只拿它认化身归属。
fn user_ticket(id: &str) -> String {
    sign(
        SECRET,
        &Ticket::user(id, false, false, "town-ticket", EXPIRES),
    )
}

/// 开了口令的小镇：连接地址上必须带 `session` 和 `ticket`。
fn town_with_token() -> Town {
    let mut town = Town::new();
    town.args = map_args(MAP_2D);
    town.args.push("--connection-token".into());
    town.args.push(SECRET.into());
    town
}

fn plain_socket(town: &Town, query: &str) -> Result<WebSocket<TcpStream>, String> {
    let port = town.port.expect("世界应该已经在监听");
    let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    tungstenite::client(format!("ws://127.0.0.1:{port}/?{query}"), stream)
        .map(|(ws, _)| ws)
        .map_err(|e| e.to_string())
}

/// 给某位村民传讯：只有投放她的账号能发；自己的账号还没进过镇子就直说没有化身。
#[test]
fn only_the_account_that_placed_a_resident_may_write_to_her() {
    let mut town = town_with_token();
    town.query = Some(format!("session={SECRET}&ticket={}", admin_ticket()));
    let mut admin = town.start();
    until(&mut admin, |m| m["type"] == "roster");
    let resident = join_id_owned(&mut admin, "tpl_a", "u-a");
    let world = reply(&mut admin, json!({"type": "get_population"}), "population")["population"]
        ["world_id"]
        .clone();

    // 别的账号写给她的信：世界拒掉，不只是页面不提供入口。
    let mut other = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", user_ticket("u-b")),
    )
    .expect("另一个账号的票应该能连上");
    until(&mut other, |m| m["type"] == "roster");
    send(
        &mut other,
        json!({"type": "send_letter", "request_id": "l-1", "world_id": world,
            "to": resident, "text": "在吗？"}),
    );
    let refused = until(&mut other, |m| m["type"] == "error");
    let message = refused["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("只有投放这位村民的账号可以给她传讯"),
        "{message}"
    );

    // 投放人自己：还没进过镇子，没有化身，世界说清楚，不把信悄悄寄出去。
    let mut mine = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", user_ticket("u-a")),
    )
    .expect("投放人的票应该能连上");
    until(&mut mine, |m| m["type"] == "roster");
    let sent = reply(
        &mut mine,
        json!({"type": "send_letter", "request_id": "l-2", "world_id": world,
            "to": resident, "text": "在吗？"}),
        "letter_sent",
    );
    assert_eq!(sent["ok"], false, "{sent}");
    let message = sent["message"].as_str().unwrap_or_default();
    assert!(message.contains("还没有你的化身"), "{message}");

    // 读信同样先要化身：没有化身就无从谈起往来的信。
    let read = reply(
        &mut mine,
        json!({"type": "get_letters", "request_id": "l-3", "world_id": world}),
        "letters",
    );
    assert!(
        read["letters"].as_array().is_some_and(Vec::is_empty),
        "{read}"
    );

    town.kill();
}

/// 她此刻的处境要写进回执：世界停着的时候，信收下了，但她这会儿看不了。
#[test]
fn a_receipt_says_the_town_is_stopped_so_she_has_not_read_it_yet() {
    let mut town = town_with_token();
    town.query = Some(format!("session={SECRET}&ticket={}", admin_ticket()));
    let mut admin = town.start();
    until(&mut admin, |m| m["type"] == "roster");
    let resident = join_id_owned(&mut admin, "tpl_a", "u-a");
    let world = reply(&mut admin, json!({"type": "get_population"}), "population")["population"]
        ["world_id"]
        .clone();

    // 投放人的化身：他进镇之后才有「谁递的信」。
    let mut mine = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", user_ticket("u-a")),
    )
    .expect("投放人的票应该能连上");
    until(&mut mine, |m| m["type"] == "roster");
    let view = crate::avatar::state(&mut mine);
    let entered = crate::avatar::command(
        &mut mine,
        &view,
        1,
        json!({"kind":"enter","name":"老陈","appearance":{"marker":"陈","color":"#387963"}}),
    );
    assert_eq!(entered["ok"], true, "{entered}");

    send(
        &mut admin,
        json!({"type": "set_speed", "request_id": "pause", "speed": 0}),
    );
    // 数值比较要按浮点：`json!(0)` 是整数，和 `0.0` 在 serde_json 里不相等。
    until(&mut admin, |m| {
        m["type"] == "roster" && m["speed"].as_f64() == Some(0.0)
    });

    let sent = reply(
        &mut mine,
        json!({"type": "send_letter", "request_id": "l-4", "world_id": world,
            "to": resident, "text": "在吗？"}),
        "letter_sent",
    );
    assert_eq!(sent["ok"], true, "{sent}");
    let message = sent["message"].as_str().unwrap_or_default();
    assert!(message.contains("小镇现在停着"), "{message}");

    town.kill();
}
