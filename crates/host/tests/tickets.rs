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
    sign(
        SECRET,
        &Ticket::user("u-admin", true, true, "town-ticket", EXPIRES),
    )
}

fn plain_ticket() -> String {
    sign(
        SECRET,
        &Ticket::user("u-plain", false, false, "town-ticket", EXPIRES),
    )
}

/// 管理员放开了「附身村民」的普通账号。
fn possess_ticket() -> String {
    sign(
        SECRET,
        &Ticket::user("u-possess", false, true, "town-ticket", EXPIRES),
    )
}

/// 指定账号的票：世界只拿它认化身归属。
fn user_ticket(id: &str) -> String {
    sign(
        SECRET,
        &Ticket::user(id, false, false, "town-ticket", EXPIRES),
    )
}

/// 开了口令的小镇：连接地址上必须带 `session` 和 `ticket`。用二维地图，化身才走得动。
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
    assert!(
        text.contains("只有管理员或获准的账号可以附身村民"),
        "{text}"
    );
    assert_eq!(refused["ok"], false, "{text}");

    town.kill();
}

/// 管理员在账号页放开的账号可以附身：世界只认票上的标记，不看页面藏不藏按钮。
#[test]
fn a_permitted_plain_ticket_may_possess_a_resident() {
    let mut town = town_with_token();
    town.query = Some(format!("session={SECRET}&ticket={}", admin_ticket()));
    let mut admin = town.start();
    until(&mut admin, |m| m["type"] == "roster");
    let resident = join_id(&mut admin, "tpl_a");

    let mut friend = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", possess_ticket()),
    )
    .expect("获准账号的票应该能连上");
    until(&mut friend, |m| m["type"] == "roster");
    let population = reply(&mut friend, json!({"type": "get_population"}), "population");
    send(
        &mut friend,
        json!({
            "type": "avatar",
            "world_id": population["population"]["world_id"],
            "request_id": "possess-2",
            "command": {"kind": "possess", "resident": resident},
        }),
    );
    let taken = until(&mut friend, |m| {
        m["type"] == "avatar_result" || m["type"] == "error"
    });
    assert_eq!(taken["ok"], true, "{taken}");
    assert_eq!(
        taken["state"]["actor"]["id"].as_str().unwrap_or_default(),
        resident,
        "{taken}"
    );

    town.kill();
}

/// 一个账号一具身体：普通账号碰别人的化身会被世界拒掉；自己的那具关了页面回来还是它。
#[test]
fn an_account_can_only_control_its_own_avatar() {
    use crate::avatar::{command, state};

    let mut town = town_with_token();
    town.query = Some(format!("session={SECRET}&ticket={}", admin_ticket()));
    let mut admin = town.start();
    until(&mut admin, |m| m["type"] == "roster");

    let mut a = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", user_ticket("u-a")),
    )
    .expect("账号 A 的票应该能连上");
    until(&mut a, |m| m["type"] == "roster");
    let first = state(&mut a);
    let entered = command(
        &mut a,
        &first,
        1,
        json!({"kind": "enter", "name": "阿甲", "appearance": {"marker": "甲", "color": "#387963"}}),
    );
    assert_eq!(entered["ok"], true, "{entered}");
    let mine = entered["state"]["actor"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(!mine.is_empty(), "{entered}");
    // A 交还（离场但账号还记着这具身体），B 再来拿它。交还用进场之后的代次。
    let left = command(
        &mut a,
        &entered["state"].clone(),
        2,
        json!({"kind": "leave"}),
    );
    assert_eq!(left["ok"], true, "{left}");

    // 账号 B 拿 A 的编号进场：不是「这个角色正在别的页面手里」，而是「不是你的」。
    let mut b = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", user_ticket("u-b")),
    )
    .expect("账号 B 的票应该能连上");
    until(&mut b, |m| m["type"] == "roster");
    let second = state(&mut b);
    let stolen = command(
        &mut b,
        &second,
        1,
        json!({"kind": "enter", "name": "阿乙", "appearance": {"marker": "乙", "color": "#387963"}, "avatar": mine}),
    );
    assert_eq!(stolen["ok"], false, "{stolen}");
    let message = stolen["message"].as_str().unwrap_or_default();
    assert!(message.contains("这个化身是别的账号的"), "{message}");

    // 不带编号进场：B 拿到的是自己的一具，不是 A 那具。
    let own = command(
        &mut b,
        &second,
        2,
        json!({"kind": "enter", "name": "阿乙", "appearance": {"marker": "乙", "color": "#387963"}}),
    );
    assert_eq!(own["ok"], true, "{own}");
    let theirs = own["state"]["actor"]["id"].as_str().unwrap_or_default();
    assert_ne!(theirs, mine, "{own}");

    // B 带自己的编号再进场（换个页面回来）仍然可以。
    let back = command(
        &mut b,
        &own["state"],
        3,
        json!({"kind": "enter", "name": "阿乙", "appearance": {"marker": "乙", "color": "#387963"}, "avatar": theirs}),
    );
    assert_eq!(back["ok"], true, "{back}");

    // A 回来，接着当原来那具（账号记住的是人，不是页面）。
    let again = command(
        &mut a,
        &left["state"],
        3,
        json!({"kind": "enter", "name": "阿甲", "appearance": {"marker": "甲", "color": "#387963"}}),
    );
    assert_eq!(again["ok"], true, "{again}");
    assert_eq!(again["state"]["actor"]["id"], mine.as_str(), "{again}");

    town.kill();
}

/// 自己的村民自己管：投放他的账号能改人设，别的账号只能看着，管理员照样能改。
#[test]
fn the_account_that_placed_a_resident_may_edit_it() {
    let mut town = town_with_token();
    town.query = Some(format!("session={SECRET}&ticket={}", admin_ticket()));
    let mut admin = town.start();
    until(&mut admin, |m| m["type"] == "roster");
    let resident = join_id_owned(&mut admin, "tpl_a", "u-a");

    // 投放人 u-a：改人设放行
    let mut mine = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", user_ticket("u-a")),
    )
    .expect("投放人的票应该能连上");
    until(&mut mine, |m| m["type"] == "roster");
    send(
        &mut mine,
        json!({"type": "set_persona", "request_id": "p-1", "resident": resident,
            "text": "我是阿树，负责照看街口的花。"}),
    );
    let saved = until(&mut mine, |m| m["request_id"] == "p-1");
    assert_eq!(saved["type"], "agent_saved", "{saved}");
    assert_eq!(saved["ok"], true, "{saved}");

    // 别的账号：世界拒掉，不只是页面不提供入口
    let mut other = plain_socket(
        &town,
        &format!("session={SECRET}&ticket={}", user_ticket("u-b")),
    )
    .expect("另一个账号的票应该能连上");
    until(&mut other, |m| m["type"] == "roster");
    send(
        &mut other,
        json!({"type": "set_persona", "request_id": "p-2", "resident": resident,
            "text": "我是别人，想改你的人设。"}),
    );
    let refused = until(&mut other, |m| m["type"] == "error");
    let message = refused["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("只有投放这位村民的账号可以改人设"),
        "{message}"
    );

    // 管理员不用是投放人
    send(
        &mut admin,
        json!({"type": "set_persona", "request_id": "p-3", "resident": resident,
            "text": "我是镇长，替他把人设补全。"}),
    );
    let by_admin = until(&mut admin, |m| m["request_id"] == "p-3");
    assert_eq!(by_admin["ok"], true, "{by_admin}");

    town.kill();
}
