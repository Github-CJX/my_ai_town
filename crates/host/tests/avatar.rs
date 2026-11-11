use crate::support::*;
use serde_json::{json, Value};
use std::{net::TcpStream, time::Duration};
use tungstenite::WebSocket;

pub(crate) fn command(
    ws: &mut WebSocket<TcpStream>,
    state: &Value,
    sequence: u64,
    command: Value,
) -> Value {
    let id = format!("avatar-{sequence}");
    send(
        ws,
        json!({"type":"avatar","world_id":state["world_id"],"request_id":id,"epoch":state["epoch"].as_str().unwrap_or(""),"sequence":sequence,"command":command}),
    );
    until(ws, |m| {
        m["type"] == "avatar_result" && m["request_id"] == id
    })
}
pub(crate) fn state(ws: &mut WebSocket<TcpStream>) -> Value {
    let w = reply(ws, json!({"type":"get_world_settings"}), "world_settings")["state"].clone();
    command(ws, &w, 0, json!({"kind":"view"}))["state"].clone()
}

#[test]
fn authoritative_input_single_controller_save_failure_and_restart() {
    let mut town = Town::new();
    town.args = map_args(MAP_2D);
    let mut ws = town.start();
    let s = state(&mut ws);
    assert_eq!(s["supported"], true);
    assert!(
        s["client_positions"].is_null(),
        "二维地图不应接受客户端位置"
    );
    let entered = command(
        &mut ws,
        &s,
        1,
        json!({"kind":"enter","name":"aya","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(entered["ok"], true, "{entered}");
    let s = entered["state"].clone();
    let history = reply(
        &mut ws,
        json!({"type":"get_chat_history","resident":"player_avatar","request_id":"avatar-history","offset":0}),
        "chat_history",
    );
    assert_eq!(history["resident"], "player_avatar");
    assert_eq!(history["total"], 0);
    let mut other = connect_again(&ws);
    let observed = state(&mut other);
    assert!(observed["resume_token"].is_null());
    assert!(
        observed["actor"].is_null(),
        "other connection received private control view: {observed}"
    );
    assert!(observed["inventory"].is_null());
    assert!(observed["interactions"].is_null());
    assert_eq!(
        command(
            &mut other,
            &observed,
            1,
            json!({"kind":"resume","token":s["resume_token"]})
        )["ok"],
        false,
        "活动租约不能被第二个连接抢走"
    );
    // 第二个连接可以有自己的化身：多人同镇各有各的，不再「一个世界只能一个页面控制」。
    let joined = command(
        &mut other,
        &observed,
        2,
        json!({"kind":"enter","name":"另一页面","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(joined["ok"], true, "{joined}");
    assert_eq!(joined["state"]["actor"]["name"], "另一页面");
    assert_eq!(joined["state"]["controlled"], true);
    // 别的页面在玩不再算占用：第二页照样能进来，`occupied` 只用来提示「有人在玩」。
    assert_eq!(joined["state"]["occupied"], false);
    let roster = until(&mut ws, |m| m["type"] == "roster" && members(m).len() == 2);
    assert_eq!(members(&roster)[1]["kind"], "avatar");
    // 化身在场不再限制倍率：60 原样生效；随后换回 1 便于观察行走。
    send(
        &mut ws,
        json!({"type":"set_speed","request_id":"test-set-speed","speed":60}),
    );
    until(&mut ws, |m| m["type"] == "roster" && m["speed"] == 60.0);
    send(
        &mut ws,
        json!({"type":"set_speed","request_id":"test-set-speed","speed":1}),
    );
    let roster = until(&mut ws, |m| m["type"] == "roster" && m["speed"] == 1.0);
    assert_eq!(members(&roster).len(), 2);
    assert_eq!(members(&roster)[0]["kind"], "avatar");
    // 第二个人自己走：只有他的化身动，第一个人的位置不变。
    let first_loc = state(&mut ws)["actor"]["locus"].clone();
    let second = joined["state"].clone();
    send(
        &mut other,
        json!({"type":"avatar_input","world_id":second["world_id"],"epoch":second["epoch"],"sequence":1,"navigation_revision":second["navigation_revision"],"direction":[0,-1]}),
    );
    let moved = until(&mut other, |m| {
        m["type"] == "avatar_state" && m["state"]["actor"]["locus"] != second["actor"]["locus"]
    });
    assert_eq!(moved["state"]["actor"]["name"], "另一页面");
    assert_eq!(state(&mut ws)["actor"]["locus"], first_loc);
    // 第二个人离场，后面的断言回到「一个化身」的流程。
    assert_eq!(
        command(
            &mut other,
            &joined["state"].clone(),
            3,
            json!({"kind":"leave"})
        )["ok"],
        true
    );
    // 离开后再回来还是同一个人：带上自己的编号进场，回到上次离开的位置。
    // （前端按标签页记着这个编号，见 frontend/town-shared/src/avatar/identity.ts）
    let me = joined["state"]["actor"]["id"].clone();
    assert_eq!(me, "player_avatar@2");
    let left_at = moved["state"]["actor"]["locus"].clone();
    let back = command(
        &mut other,
        &s,
        4,
        json!({"kind":"enter","avatar":me,"name":"另一页面","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(back["ok"], true, "{back}");
    assert_eq!(back["state"]["actor"]["id"], me);
    assert_eq!(back["state"]["actor"]["name"], "另一页面");
    assert_eq!(back["state"]["actor"]["present"], true);
    // 位置由内核吸附到最近的落脚点，回来还是同一处所，不是新的 @3。
    assert_eq!(back["state"]["actor"]["locus"]["locale"], left_at["locale"]);
    let roster = until(&mut ws, |m| m["type"] == "roster" && members(m).len() == 2);
    assert_eq!(
        members(&roster)
            .iter()
            .filter(|m| m["kind"] == "avatar")
            .count(),
        2
    );
    // 复制标签页会把「我是谁」一起带过去：后来者不能凭同一个编号把别人的化身抢走。
    let mut twin = connect_again(&ws);
    let shown = state(&mut twin);
    let stolen = command(
        &mut twin,
        &shown,
        1,
        json!({"kind":"enter","avatar":me,"name":"复制页","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(stolen["ok"], false, "{stolen}");
    assert_eq!(stolen["code"], "occupied");
    assert!(
        stolen["message"]
            .as_str()
            .unwrap_or("")
            .contains("别的页面"),
        "{stolen}"
    );
    assert_eq!(state(&mut other)["actor"]["id"], me);
    drop(twin);
    // 在场时再报一次名字就是改名（改名不换人）：编号不变，名字换掉。
    let renamed = command(
        &mut other,
        &back["state"].clone(),
        5,
        json!({"kind":"enter","avatar":me,"name":"改名之后","appearance":{"marker":"我","color":"#a3572b"}}),
    );
    assert_eq!(renamed["ok"], true, "{renamed}");
    assert_eq!(renamed["state"]["actor"]["id"], me);
    assert_eq!(renamed["state"]["actor"]["name"], "改名之后");
    assert_eq!(renamed["state"]["actor"]["appearance"]["color"], "#a3572b");
    assert_eq!(
        command(
            &mut other,
            &renamed["state"].clone(),
            6,
            json!({"kind":"leave"})
        )["ok"],
        true
    );
    // 关掉页面再回来、还用同一个名字：缺席的同名化身不占着名字，就地接着当那个人。
    let mut again = connect_again(&ws);
    let seen = state(&mut again);
    let same = command(
        &mut again,
        &seen,
        1,
        json!({"kind":"enter","name":"改名之后","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(same["ok"], true, "{same}");
    assert_eq!(
        same["state"]["actor"]["id"], me,
        "同名应当接着当原来那个化身，而不是新排一个编号"
    );
    assert_eq!(
        command(
            &mut again,
            &same["state"].clone(),
            2,
            json!({"kind":"leave"})
        )["ok"],
        true
    );
    drop(again);
    // 页面直接关掉（没点「交还」）再回来、用同一个名字：接着当原来那个化身，位置也不跳。
    // 关掉的连接还在 30 s 恢复窗口里，但这具身体已经没人握着，不该把名字锁住。
    let mut gone = connect_again(&ws);
    let born = state(&mut gone);
    let made = command(
        &mut gone,
        &born,
        1,
        json!({"kind":"enter","name":"离线的人","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(made["ok"], true, "{made}");
    let offline = made["state"]["actor"]["id"].clone();
    let stood = made["state"]["actor"]["locus"].clone();
    drop(gone);
    std::thread::sleep(Duration::from_millis(300));
    let mut back = connect_again(&ws);
    let seen = state(&mut back);
    let taken = command(
        &mut back,
        &seen,
        1,
        json!({"kind":"enter","name":"离线的人","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(taken["ok"], true, "{taken}");
    assert_eq!(
        taken["state"]["actor"]["id"], offline,
        "关掉的页面不该把名字锁住"
    );
    assert_eq!(
        taken["state"]["actor"]["locus"], stood,
        "同名接管的是站在原地的那个化身，不该被挪到入口"
    );
    assert_eq!(
        command(
            &mut back,
            &taken["state"].clone(),
            2,
            json!({"kind":"leave"})
        )["ok"],
        true
    );
    drop(back);
    let old = s["actor"]["locus"].clone();
    let input = json!({"type":"avatar_input","world_id":s["world_id"],"epoch":s["epoch"],"sequence":1,"navigation_revision":s["navigation_revision"],"direction":[0,-1]});
    send(&mut ws, input.clone());
    until(&mut ws, |m| {
        m["type"] == "avatar_state" && m["state"]["actor"]["locus"] != old
    });
    // 没有后续输入时自动停步；重送旧序号不能再次启动。
    std::thread::sleep(Duration::from_millis(650));
    let stopped = state(&mut ws)["actor"]["locus"].clone();
    send(&mut ws, input);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(state(&mut ws)["actor"]["locus"], stopped);
    let profile = json!({"kind":"profile","name":"aya 新名字","appearance":{"marker":"我","color":"#a15338"}});
    assert_eq!(command(&mut ws, &s, 3, profile.clone())["ok"], true);
    assert_eq!(command(&mut ws, &s, 3, profile)["ok"], true);
    assert_eq!(command(&mut ws, &s, 3, json!({"kind":"stop"}))["ok"], false);
    // 原子保存的目标被目录挡住时，化身修改回滚且全镇暂停；只操作隔离目录。
    let original = town.save().with_extension("saved");
    std::fs::rename(town.save(), &original).unwrap();
    std::fs::create_dir(town.save()).unwrap();
    let failed = command(
        &mut ws,
        &s,
        4,
        json!({"kind":"profile","name":"不应留下","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(failed["ok"], false);
    assert_eq!(failed["state"]["actor"]["name"], "aya 新名字");
    assert_eq!(failed["state"]["speed"], 0.0);
    std::fs::remove_dir(town.save()).unwrap();
    std::fs::rename(original, town.save()).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let token = s["resume_token"].clone();
    drop(ws);
    std::thread::sleep(Duration::from_millis(200));
    let resumed = command(&mut other, &s, 5, json!({"kind":"resume","token":token}));
    assert_eq!(resumed["ok"], true, "{resumed}");
    assert_ne!(resumed["state"]["epoch"], s["epoch"]);
    let s = resumed["state"].clone();
    assert_eq!(
        command(&mut other, &s, 1, json!({"kind":"leave"}))["ok"],
        true
    );
    drop(other);
    town.shutdown();
    let mut ws = town.start();
    let s = state(&mut ws);
    // 重启后的新连接没有控制权：它是观察者，拿不到任何人的视图（见 D.9）。
    assert!(s["actor"].is_null(), "{s}");
    assert_eq!(s["controlled"], false);
    let saved = town.saved(|v| v["schema_version"] == 5);
    // 存档里的人还在，只是离场；用同一个名字进场就接着当原来那个人、回到原来的位置。
    assert_eq!(
        saved["world"]["actors"]["player_avatar"]["name"],
        "aya 新名字"
    );
    assert_eq!(
        saved["world"]["actors"]["player_avatar"]["locus"]["at"]["kind"],
        "offstage"
    );
    assert!(saved["population"]["residents"]
        .as_object()
        .unwrap()
        .is_empty());
    let entered = command(
        &mut ws,
        &s,
        2,
        json!({"kind":"enter","name":"aya 新名字","appearance":{"marker":"我","color":"#a15338"}}),
    );
    assert_eq!(entered["ok"], true, "{entered}");
    assert_eq!(entered["state"]["actor"]["locus"], stopped);
}

/// T-VIS：没有控制权的页面是**观察者**——能看到世界（名册、地图支不支持化身），
/// 但拿不到任何人的私人视图（够得着的人、互动、道具、背包、近况、目标、步速）。
#[test]
fn a_page_without_control_only_gets_the_public_view() {
    let mut town = Town::new();
    town.args = map_args(MAP_2D);
    let mut ws = town.start();
    let s = state(&mut ws);
    let entered = command(
        &mut ws,
        &s,
        1,
        json!({"kind":"enter","name":"阿夜","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(entered["ok"], true, "{entered}");
    let mine = entered["state"].clone();
    assert_eq!(mine["controlled"], true);
    assert_eq!(mine["actor"]["name"], "阿夜");
    // 第二个页面：什么都没控制，纯观察。
    let mut other = connect_again(&ws);
    let watching = state(&mut other);
    assert_eq!(watching["supported"], true);
    assert!(
        watching["units"].is_number(),
        "观察者要知道一格几米才能画图: {watching}"
    );
    for private in [
        "actor",
        "inventory",
        "interactions",
        "props",
        "nearby",
        "recent",
        "goals",
        "walk",
    ] {
        assert!(
            watching[private].is_null(),
            "观察者收到了别人的 {private}: {watching}"
        );
    }
    assert_eq!(watching["controlled"], false);
    assert_eq!(watching["occupied"], true, "有人在玩：只用于显示，不挡进场");
    // 名册照样能看：观察者看得到别人在镇上的位置与动作。
    let roster = until(&mut other, |m| {
        m["type"] == "roster" && !members(m).is_empty()
    });
    assert!(members(&roster)
        .iter()
        .any(|m| m["kind"] == "avatar" && m["name"] == "阿夜"));
    // 观察者随时能自己进场，不会因为「有人在玩」被挡住。
    let joined = command(
        &mut other,
        &watching,
        1,
        json!({"kind":"enter","name":"阿白","appearance":{"marker":"我","color":"#a15338"}}),
    );
    assert_eq!(joined["ok"], true, "{joined}");
    assert_eq!(joined["state"]["controlled"], true);
    assert_eq!(joined["state"]["actor"]["name"], "阿白");
    // 反过来：第一个页面仍是自己的完整视图，没有被观察者的动作影响。
    let again = state(&mut ws);
    assert_eq!(again["controlled"], true);
    assert_eq!(again["actor"]["name"], "阿夜");
    assert!(again["nearby"].is_array(), "{again}");
    assert!(again["walk"].is_object(), "{again}");
}

/// v3 存档（人物没有 kind 字段）读入后居民的需求与位置不变，人口原样保留，原文件留有备份。
#[test]
fn legacy_save_migration_preserves_residents() {
    let mut town = Town::new();
    let mut ws = town.start();
    let resident = join_id(&mut ws, "tpl_a");
    town.shutdown();
    drop(ws);
    let mut old: Value = serde_json::from_slice(&std::fs::read(town.save()).unwrap()).unwrap();
    old["schema_version"] = json!(3);
    old["world"]["schema_version"] = json!(3);
    for a in old["world"]["actors"].as_object_mut().unwrap().values_mut() {
        a.as_object_mut().unwrap().remove("kind");
    }
    std::fs::write(town.save(), serde_json::to_vec(&old).unwrap()).unwrap();
    let before = old["world"]["actors"][&resident].clone();
    let mut ws = town.start();
    until(&mut ws, |m| m["type"] == "roster");
    town.shutdown();
    let current: Value = serde_json::from_slice(&std::fs::read(town.save()).unwrap()).unwrap();
    assert_eq!(
        current["world"]["actors"][&resident]["needs"],
        before["needs"]
    );
    assert_eq!(
        current["world"]["actors"][&resident]["locus"],
        before["locus"]
    );
    assert_eq!(current["population"], old["population"]);
    assert!(
        std::path::PathBuf::from(format!("{}.before-avatar-v1", town.save().display())).exists()
    );
}

/// 化身神力走完整路径：开关在设定里打开、随存档保存；化身对倒在入口的居民施展复活，
/// 回执带着给玩家看的结果；开关关着时同一条命令被拒。
#[test]
fn miracle_switch_persists_and_the_avatar_revives_a_resident() {
    let mut town = Town::new();
    town.args = map_args(MAP_2D);
    let mut ws = town.start();
    let resident = join_id(&mut ws, "tpl_a");
    town.shutdown();
    drop(ws);
    // 刚从入口进镇的居民（世界还停着，他没走开）倒在入口
    let mut save = read_json(&town.save());
    let needs = &mut save["world"]["actors"][&resident]["needs"];
    needs["health"]["value"] = json!(0.0);
    needs["body"]["dead"] = json!(true);
    std::fs::write(town.save(), serde_json::to_vec(&save).unwrap()).unwrap();
    let mut ws = town.start();
    let settings = |ws: &mut WebSocket<TcpStream>| {
        reply(ws, json!({"type":"get_world_settings"}), "world_settings")["state"].clone()
    };
    assert_eq!(settings(&mut ws)["miracles"], false);
    let s = state(&mut ws);
    let entered = command(
        &mut ws,
        &s,
        1,
        json!({"kind":"enter","name":"aya","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(entered["ok"], true, "{entered}");
    let s = entered["state"].clone();
    assert!(
        s["nearby"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == resident.as_str() && p["dead"] == true),
        "倒在跟前的人列在够得着的人里，标着已经死了：{s}"
    );
    send(
        &mut ws,
        json!({"type":"set_speed","request_id":"go","speed":1}),
    );
    until(&mut ws, |m| m["type"] == "roster" && m["speed"] == 1.0);
    let revive = |state: &Value| json!({"kind":"miracle","revision":state["actor"]["revision"],"recipient":resident,"miracle":"revive"});
    let off = command(&mut ws, &s, 2, revive(&s));
    assert_eq!(off["ok"], false, "开关关着时不能施展：{off}");
    assert_eq!(off["state"]["miracles"], false);
    let saved = reply(
        &mut ws,
        json!({"type":"set_miracles","request_id":"m1","world_id":s["world_id"],"enabled":true}),
        "world_settings_saved",
    );
    assert_eq!(saved["ok"], true, "{saved}");
    let done = command(&mut ws, &s, 3, revive(&off["state"]));
    assert_eq!(done["ok"], true, "{done}");
    assert!(
        done["message"].as_str().unwrap().contains("活了过来"),
        "{done}"
    );
    assert_eq!(done["state"]["miracles"], true);
    let roster = until(&mut ws, |m| {
        m["type"] == "roster"
            && members(m)
                .iter()
                .any(|r| r["id"] == resident.as_str() && r["body"]["life"] == "alive")
    });
    assert!(!members(&roster).is_empty());
    town.shutdown();
    drop(ws);
    let mut ws = town.start();
    assert_eq!(settings(&mut ws)["miracles"], true, "开关随存档保存");
}

/// 本连接正在参与的那场交谈（按互动种类找，不看顺序）。
fn chat_of(ws: &mut WebSocket<TcpStream>) -> Value {
    let s = state(ws);
    s["interactions"]
        .as_array()
        .and_then(|v| v.iter().find(|i| i["kind"]["kind"] == "talk").cloned())
        .unwrap_or(Value::Null)
}

/// 两个页面各控一个化身真的聊起来：两页的名册里都要挂着双方各自刚说的那句，
/// 镇上的气泡才有东西可画（只冒出邀请人那句是原来的缺口）。
#[test]
fn two_avatar_pages_talking_both_reach_the_roster() {
    let mut town = Town::new();
    town.args = map_args(MAP_2D);
    let mut ws = town.start();
    join_id(&mut ws, "tpl_b");
    // 停着的世界里不能交谈（内核对化身的互动命令回 paused），先让世界跑起来。
    send(
        &mut ws,
        json!({"type":"set_speed","request_id":"go","speed":1}),
    );
    until(&mut ws, |m| m["type"] == "roster" && m["speed"] == 1.0);
    let s = state(&mut ws);
    let entered = command(
        &mut ws,
        &s,
        1,
        json!({"kind":"enter","name":"阿岚","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(entered["ok"], true, "{entered}");
    let mine = entered["state"]["actor"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let mut second = connect_again(&ws);
    let seen = state(&mut second);
    let joined = command(
        &mut second,
        &seen,
        1,
        json!({"kind":"enter","name":"阿波","appearance":{"marker":"我","color":"#a3572b"}}),
    );
    assert_eq!(joined["ok"], true, "{joined}");
    let theirs = joined["state"]["actor"]["id"].as_str().unwrap().to_string();
    assert_ne!(mine, theirs, "两页是两个人：{joined}");
    // 第一页发出交谈邀请，第二页答应。
    let s = state(&mut ws);
    let offered = command(
        &mut ws,
        &s,
        2,
        json!({"kind":"interact","revision":s["actor"]["revision"],
            "command":{"operation":"offer","partner_id":theirs,"interaction":{"kind":"talk"},"message":"聊两句？"}}),
    );
    assert_eq!(offered["ok"], true, "{offered}");
    let invite = chat_of(&mut second);
    let id = invite["id"].as_str().unwrap().to_string();
    let s = state(&mut second);
    let replied = command(
        &mut second,
        &s,
        2,
        json!({"kind":"interact","revision":s["actor"]["revision"],
            "command":{"operation":"reply","interaction_id":id,"accept":true,"message":"好呀"}}),
    );
    assert_eq!(replied["ok"], true, "{replied}");
    // 谁先轮到谁先说，另一页接着说。
    let say = |ws: &mut WebSocket<TcpStream>, sequence: u64, text: &str| {
        let chat = chat_of(ws);
        let id = chat["id"].as_str().unwrap().to_string();
        let s = state(ws);
        let done = command(
            ws,
            &s,
            sequence,
            json!({"kind":"interact","revision":s["actor"]["revision"],
                "command":{"operation":"say","interaction_id":id,"message":text}}),
        );
        assert_eq!(done["ok"], true, "{done}");
    };
    if chat_of(&mut ws)["can_speak"] == true {
        say(&mut ws, 3, "今天广场上有人唱歌");
        say(&mut second, 3, "我也听见了");
    } else {
        say(&mut second, 3, "我也听见了");
        say(&mut ws, 3, "今天广场上有人唱歌");
    }
    // 名册对全镇广播：两页都该拿到两句话。
    let roster = until(&mut ws, |m| {
        m["type"] == "roster" && m.to_string().contains("我也听见了")
    });
    let line = |roster: &Value, id: &str| {
        members(roster)
            .into_iter()
            .find(|m| m["id"] == id)
            .unwrap_or(Value::Null)
    };
    let a = line(&roster, &mine);
    let b = line(&roster, &theirs);
    assert_eq!(a["speech"]["text"], "今天广场上有人唱歌", "{roster}");
    assert_eq!(b["speech"]["text"], "我也听见了", "{roster}");
    assert_eq!(a["speech"]["chat_id"], b["speech"]["chat_id"], "{roster}");
    assert!(a["chat"].is_object(), "说过的两个人都在聊：{roster}");
    assert!(b["chat"].is_object(), "{roster}");
    let seen = until(&mut second, |m| {
        m["type"] == "roster" && m.to_string().contains("今天广场上有人唱歌")
    });
    assert_eq!(line(&seen, &theirs)["speech"]["text"], "我也听见了");
    town.shutdown();
}
