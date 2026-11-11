//! 常驻小镇：管理员在首页挑一个小镇一直开着（页面全关了也不停），别人只能进这个镇。
//! 记在数据目录的 resident.json 里；电脑版（scripts/towns/resident.mjs）读同一份。
use crate::error::ApiError;
use crate::storage::{read_json, write_json};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 现在常驻的是哪个小镇、按什么速度跑；没设或文件坏了都算没设。
pub fn read(root: &Path) -> (Option<String>, f64) {
    let value = read_json(&root.join("resident.json")).unwrap_or_default();
    let town = value["town"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let speed = value["speed"]
        .as_f64()
        .filter(|speed| *speed >= 0.0)
        .unwrap_or(1.0);
    (town, speed)
}

pub struct Resident {
    root: PathBuf,
    state: Mutex<(Option<String>, f64)>,
}

impl Resident {
    pub fn load(root: &Path) -> Self {
        let (town, speed) = read(root);
        Self {
            root: root.to_owned(),
            state: Mutex::new((town, speed)),
        }
    }

    pub fn town(&self) -> Option<String> {
        self.state.lock().unwrap().0.clone()
    }

    pub fn speed(&self) -> f64 {
        self.state.lock().unwrap().1
    }

    pub fn set(&self, town: Option<String>) -> Result<(), ApiError> {
        let mut state = self.state.lock().unwrap();
        state.0 = town;
        save(&self.root, &state)
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), ApiError> {
        let mut state = self.state.lock().unwrap();
        state.1 = speed;
        save(&self.root, &state)
    }
}

fn save(root: &Path, state: &(Option<String>, f64)) -> Result<(), ApiError> {
    let (town, speed) = state;
    let file = root.join("resident.json");
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_json(&file, &json!({ "town": town, "speed": speed }))
}
