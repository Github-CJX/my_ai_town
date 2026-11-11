//! 摆道具界面问「哪里能放」：格子只回给发问的页面；地点不认识时是 null；
//! 真地点给出的格子形状和它自己给的尺寸对得上（逐行逐列一格一个字符）。
use crate::support::*;
use host::application::{
    COMPATIBILITY_PATH, LEGACY_PROP_CATALOG_PATH, PROP_CATALOG_PATH, SCENE_ASSETS_PATH,
};
use serde_json::{json, Value};

const TOWN_2D: &str = "data/maps/2d-town/map.json";

fn published(relative: &str) -> String {
    repo_root().join(relative).to_string_lossy().into_owned()
}

/// 用仓库里发布的正式地图起一个镇：只有这批地图带三维导航，放置器才算得出格子。
fn town_on_published_map() -> Town {
    let path = published(TOWN_2D);
    let mut town = Town::empty();
    town.write(
        "config/application.json",
        json!({
            "port":0,"topology_path":path,
            "prop_catalog_path":published(PROP_CATALOG_PATH),
            "legacy_prop_catalog_path":published(LEGACY_PROP_CATALOG_PATH),
            "scene_assets_path":published(SCENE_ASSETS_PATH),
            "compatibility_path":published(COMPATIBILITY_PATH),
            "providers_path":"config/providers.json","credentials_path":"config/credentials.json"
        }),
    );
    town.args = map_args(&path);
    town
}

#[test]
fn the_placement_grid_answers_the_page_that_asked_and_nothing_for_unknown_places() {
    let mut town = town_on_published_map();
    let mut first = town.start();
    let catalog = reply(&mut first, json!({"type":"get_props"}), "props");
    let places: Vec<String> = catalog["catalog"]["locations"]
        .as_array()
        .expect("道具目录里有地点")
        .iter()
        .map(|p| p["id"].as_str().expect("地点编号").to_string())
        .collect();
    assert!(!places.is_empty(), "正式地图没有任何能放道具的地点");

    let mut second = connect_again(&first);
    for (i, place) in places.iter().enumerate() {
        send(
            &mut first,
            json!({"type":"get_place_grid","request_id":format!("grid-{i}"),"locale":place}),
        );
    }
    send(
        &mut second,
        json!({"type":"get_place_grid","request_id":"grid-unknown","locale":"no_such_place"}),
    );
    let grids: Vec<Value> = received_until(&mut first, |m| {
        m["request_id"] == format!("grid-{}", places.len() - 1)
    });

    // 每一份回执都对上自己问的地点，请求编号不串，别人的问题不会回到这边。
    for (i, place) in places.iter().enumerate() {
        let receipt = grids
            .iter()
            .find(|m| m["request_id"] == format!("grid-{i}"))
            .unwrap_or_else(|| panic!("没有地点 {place} 的回执：{grids:?}"));
        assert_eq!(receipt["type"], "place_grid");
        assert_eq!(receipt["locale"], place.as_str());
        assert!(
            !grids.iter().any(|m| m["request_id"] == "grid-unknown"),
            "别人的回执串到了这边：{grids:?}"
        );
    }

    // 仓库发布的是二维地图：没有三维 navigation 数据，格子由 WalkMap 的房间矩形算出来。
    // 每个能放道具的地点都必须给出格子，且形状自洽、至少有一个空位。
    for (i, place) in places.iter().enumerate() {
        let receipt = grids
            .iter()
            .find(|m| m["request_id"] == format!("grid-{i}"))
            .unwrap_or_else(|| panic!("没有地点 {place} 的回执：{grids:?}"));
        let grid = receipt["grid"]
            .as_object()
            .unwrap_or_else(|| panic!("地点 {place} 没有格子：{receipt}"));
        let cells = grid["cells"].as_str().expect("cells 是字符串");
        let rows = grid["rows"].as_u64().expect("rows") as usize;
        let columns = grid["columns"].as_u64().expect("columns") as usize;
        assert_eq!(cells.len(), rows * columns, "{place}: {grid:?}");
        assert_eq!(
            grid["by"].as_str().expect("by 与 cells 逐格对应").len(),
            cells.len(),
            "{place}"
        );
        assert!(
            grid["props"].as_array().is_some(),
            "by 里的序号要有对应的道具编号：{place}"
        );
        assert!(
            cells.chars().any(|c| c == '.'),
            "{place} 一个空位都没有：{grid:?}"
        );
        assert!(
            cells
                .chars()
                .all(|c| "._aprbs w".replace(' ', "").contains(c)),
            "{place} 出现了没约定的格子字符：{cells}"
        );
        assert_eq!(grid["locale"], place.as_str());
        let step = grid["step"].as_f64().expect("step");
        assert!(step >= 0.5, "{place} 的格距太小：{step}");
        assert!(
            rows > 0 && columns > 0 && rows <= 200 && columns <= 200,
            "{place} 的格子太多：{rows}x{columns}"
        );
    }

    let unknown = until(&mut second, |m| m["request_id"] == "grid-unknown");
    assert_eq!(unknown["type"], "place_grid");
    assert!(unknown["grid"].is_null(), "{unknown}");
}
