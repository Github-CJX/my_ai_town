//! 谁是谁的化身：世界不认识账号，只按管理服务票面里的账号编号记一条不透明的绑定。
//!
//! 绑定落在世界存档旁边的 `*.owners.json`：世界重启后同一个账号还能接着用自己的化身，
//! 别的账号也拿不走。没有存档（`--no-save`）时只在内存里，跟这个世界同生共死。
//! 没有口令的世界（本机自己开的、测试夹具）拿不到账号编号，等于不认归属，行为与从前一致。
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Default, Clone)]
pub struct Owners {
    path: Option<PathBuf>,
    /// 化身编号 → 账号编号。
    map: BTreeMap<String, String>,
}

impl Owners {
    /// `path` 给了就从那个文件读；读不明白就当空表（世界照常起，只是没有归属记忆）。
    pub fn open(path: Option<PathBuf>) -> Self {
        let mut owners = Self {
            path,
            map: BTreeMap::new(),
        };
        let Some(path) = owners.path.clone() else {
            return owners;
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            return owners;
        };
        match serde_json::from_str::<BTreeMap<String, String>>(&text) {
            Ok(map) => owners.map = map,
            Err(error) => eprintln!(
                "[host] 化身归属文件 {} 读不明白，先当没有：{error}",
                path.display()
            ),
        }
        owners
    }

    /// 这个化身归谁。
    pub fn owner_of(&self, avatar: &str) -> Option<&str> {
        self.map.get(avatar).map(String::as_str)
    }

    /// 这个账号已经有的化身（一个账号一具身体：改名不换人）。
    pub fn owned_by(&self, account: &str) -> Option<&str> {
        self.map
            .iter()
            .find(|(_, owner)| owner.as_str() == account)
            .map(|(avatar, _)| avatar.as_str())
    }

    /// 认领一具化身。被别的账号占着时返回 Err(占有人)；本来就归自己时返回 Ok(false)。
    pub fn claim(&mut self, avatar: &str, account: &str) -> Result<bool, String> {
        match self.map.get(avatar) {
            Some(owner) if owner != account => Err(owner.clone()),
            Some(_) => Ok(false),
            None => {
                self.map.insert(avatar.into(), account.into());
                self.save();
                Ok(true)
            }
        }
    }

    /// 世界重置：旧化身编号全部作废，归属也一起忘掉，免得新世界沿用旧绑定。
    pub fn clear(&mut self) {
        if self.map.is_empty() {
            return;
        }
        self.map.clear();
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let text = match serde_json::to_string_pretty(&self.map) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("[host] 化身归属存不下来：{error}");
                return;
            }
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(error) = std::fs::write(path, format!("{text}\n")) {
            eprintln!("[host] 化身归属存不下来：{error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("town-owners-{stamp}"));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir.join("world.owners.json")
    }

    /// 认领之后世界重启还认得：同一个账号接着用，别的账号拿不走。
    #[test]
    fn an_account_keeps_its_avatar_across_a_restart() {
        let path = temp_file();
        let mut owners = Owners::open(Some(path.clone()));
        assert_eq!(owners.claim("player_avatar", "u-a"), Ok(true));
        assert_eq!(owners.claim("player_avatar", "u-a"), Ok(false));
        assert_eq!(
            owners.claim("player_avatar", "u-b"),
            Err("u-a".into()),
            "别的账号认领不了"
        );
        assert_eq!(owners.owned_by("u-a"), Some("player_avatar"));

        let reopened = Owners::open(Some(path));
        assert_eq!(reopened.owner_of("player_avatar"), Some("u-a"));
        assert_eq!(reopened.owned_by("u-b"), None);
    }

    /// 没有存档路径时只在内存里，不报错也不写盘。
    #[test]
    fn without_a_file_it_just_lives_in_memory() {
        let mut owners = Owners::open(None);
        assert_eq!(owners.claim("player_avatar@2", "u-a"), Ok(true));
        assert!(owners.owner_of("player_avatar@2").is_some());
        owners.clear();
        assert_eq!(owners.owner_of("player_avatar@2"), None);
    }
}
