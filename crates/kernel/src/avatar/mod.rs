//! 化身身份与生命周期。动作、交谈、背包的结算仍由原领域模块负责。
//! 名字、外观与读档规则在 Profile 上；World 只做进场、离场与改资料的编排。
mod commands;
mod geometry;
mod placement;
mod reach;
mod view;
pub use crate::possession::Control;
use crate::{
    actor::Actor,
    error::{KernelError, Result},
    topology::Topology,
    World,
};
pub(crate) use geometry::distance;
pub use geometry::{
    Area, Obstacle, Point, Portal, Spot, Surface, WalkMap, RADIUS, REACH, TALK_REACH,
};
use protocol::{Appearance, At, Locus, MemberKind};
pub(crate) use reach::Reach;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const ID: &str = "player_avatar";
/// 同一个世界里可以有多个真人化身：第一个是 `player_avatar`，之后依次是 `player_avatar@2`、`player_avatar@3`。
/// 编号只是身份，不代表权限：控制谁由连接上的租约决定（见 crates/host 的 avatar 模块）。
pub fn is_id(id: &str) -> bool {
    id == ID
        || id
            .strip_prefix(ID)
            .is_some_and(|rest| rest.starts_with('@'))
}
/// 玩家操控的人（化身和附身的村民）走路是村民步速的几倍。村民的步速和模拟时间绑在一起，
/// 路线时长、到达时刻都按它算；玩家操控的人只求跟手，走多快不进入任何村民的计算。
pub const WALK_PACE: f64 = 2.5;
/// 按住奔跑键时是村民步速的几倍。
pub const RUN_PACE: f64 = 4.0;
/// 化身名字最多几个字；地图标记最多几个字符。
const NAME_MAX_CHARS: usize = 24;
const MARKER_MAX_CHARS: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub appearance: Appearance,
    pub last_locus: Locus,
    #[serde(flatten)]
    pub control: Control,
}

impl Profile {
    /// 名字 1–24 字，没有控制字符。
    fn check_name(name: &str) -> Result<()> {
        ensure!(
            !name.trim().is_empty()
                && name.trim().chars().count() <= NAME_MAX_CHARS
                && !name.chars().any(char::is_control),
            KernelError::action("名字须为 1–24 字")
        );
        Ok(())
    }

    /// 标记至多两个字符，颜色是 #RRGGBB；捏过的长相也要合格。
    fn check_appearance(appearance: &Appearance) -> Result<()> {
        ensure!(
            appearance.marker.chars().count() <= MARKER_MAX_CHARS
                && protocol::is_hex_color(&appearance.color),
            KernelError::action("外观颜色须为六位十六进制颜色，标记至多两个字符")
        );
        if let Some(look) = &appearance.look {
            look.check().map_err(KernelError::action)?;
        }
        Ok(())
    }

    /// 读档校验：化身不是居民、离场时不占活动、在场与上次的位置合法、回执账本合法。
    /// 自由位置和位置上报写入时用同一条规则（`WalkMap::check_free_locus`）；落脚点要在所在区域里。
    fn validate(&self, a: &Actor, map: Option<&WalkMap>, topo: &Topology) -> Result<()> {
        ensure!(
            is_id(&a.id) && a.home.is_none() && !a.actions.agent_controlled,
            KernelError::snapshot("化身不能注册为居民 Agent")
        );
        ensure!(
            a.present()
                || (a.plan.is_empty()
                    && a.current.action.is_none()
                    && a.current.interaction.is_none()),
            KernelError::snapshot("离场化身仍占用活动")
        );
        let map = map.ok_or_else(|| KernelError::snapshot("化身存档缺少行走地图"))?;
        for l in [&self.last_locus, &a.locus] {
            match l.at {
                At::Offstage => continue,
                At::Free { .. } => map.check_free_locus(l, topo)?,
                _ => {
                    let s = map
                        .station_locus(l)
                        .ok_or_else(|| KernelError::snapshot("化身位置无效"))?;
                    ensure!(
                        s.position.iter().all(|x| x.is_finite())
                            && map.locale_at(&s.space, s.position, &s.locale)
                                == Some(s.locale.as_str()),
                        KernelError::snapshot("化身位置不属于所在区域")
                    );
                }
            }
        }
        ensure!(
            self.control.receipts_valid(),
            KernelError::snapshot("化身回执账本无效")
        );
        Ok(())
    }
}

impl Actor {
    /// 第一次进入小镇的化身：没有住宅，不交给 Agent。
    fn new_avatar(id: &str, name: &str, appearance: Appearance, spot: &Spot, now: f64) -> Self {
        let mut a = Actor::waiting(id, name.trim(), &spot.locale, String::new(), now);
        a.kind = MemberKind::Avatar;
        a.avatar = Some(Profile {
            appearance,
            last_locus: spot.locus(),
            control: Control::default(),
        });
        a
    }
}

impl World {
    /// 主化身：`player_avatar` 在场时就是它，否则第一个化身。
    /// 单人玩法（附身、`player_id`）走这条；多人玩法按编号取，见 `avatar_of`、`avatars`。
    pub fn avatar(&self) -> Option<&Actor> {
        self.actors
            .get(ID)
            .filter(|a| a.is_avatar())
            .or_else(|| self.avatars().next())
    }
    /// 按编号取化身；编号不是化身（例如居民）时为空。
    pub fn avatar_of(&self, id: &str) -> Option<&Actor> {
        self.actors.get(id).filter(|a| a.is_avatar())
    }
    /// 世界里所有化身，包括离场的。
    pub fn avatars(&self) -> impl Iterator<Item = &Actor> {
        self.actors.values().filter(|a| a.is_avatar())
    }
    /// 下一个可用的化身编号：主编号空着就用它，否则按 @2、@3… 往后找。
    fn avatar_next_id(&self) -> String {
        if !self.actors.contains_key(ID) {
            return ID.into();
        }
        (2..)
            .map(|n| format!("{ID}@{n}"))
            .find(|id| !self.actors.contains_key(id))
            .expect("化身编号不会用完")
    }
    /// 单人玩法：世界里不能有人正附身村民时再进化身。
    pub fn avatar_enter(&mut self, name: &str, appearance: Appearance) -> Result<String> {
        ensure!(
            self.possessed().is_none(),
            KernelError::action("请先交还村民")
        );
        self.avatar_join(name, appearance)
    }
    /// 多人玩法进场：不管世界里有没有人附身，只管给自己排一个化身编号。
    pub fn avatar_join(&mut self, name: &str, appearance: Appearance) -> Result<String> {
        let id = match self.avatar() {
            // 离开过的化身再进来还是同一个人，位置和回执都接着用。
            Some(a) if !a.present() => a.id.clone(),
            _ => self.avatar_next_id(),
        };
        self.avatar_enter_as(&id, name, appearance)
    }
    /// 按编号让化身进场：编号已存在就接管（在场就留在原地，离场就回上次的位置），否则新建。
    /// 返回进场后的编号。附身别的村民不算占位——一个连接一次只控制一个目标由宿主把关。
    pub fn avatar_enter_as(
        &mut self,
        id: &str,
        name: &str,
        appearance: Appearance,
    ) -> Result<String> {
        ensure!(
            is_id(id),
            KernelError::action("化身编号须为 player_avatar 或 player_avatar@N")
        );
        if self.actors.contains_key(id) {
            ensure!(
                self.avatar_of(id).is_some(),
                KernelError::action("化身编号已被占用")
            );
        }
        let map = self
            .walk_map
            .clone()
            .ok_or_else(|| KernelError::navigation("此地图暂不支持化身"))?;
        self.check_avatar_profile(id, name, &appearance)?;
        // 已经在场（页面关了、这具身体没人握着）就留在原地，别把人挪走；否则算一个落脚点。
        let present = self.avatar_of(id).is_some_and(|a| a.present());
        let spot = if present {
            None
        } else {
            let origin = self.avatar_origin_of(id)?;
            let station = map
                .station_locus(&origin)
                .ok_or_else(|| KernelError::navigation("化身保存的位置没有几何"))?;
            Some(
                map.safe_near(&station, &self.avatar_obstacles())
                    .ok_or_else(|| KernelError::navigation("入口附近没有安全位置"))?,
            )
        };
        if self.avatar_of(id).is_some() {
            // 改名不换人：再次进场时报的名字和样子就是新身份（「回到小镇」对话框就是这么承诺的）。
            let a = self.actor_mut(id);
            a.name = name.trim().into();
            a.avatar.as_mut().expect("化身有资料").appearance = appearance;
            if let Some(spot) = spot {
                a.locus = spot.locus();
            }
        } else {
            let spot = spot.expect("新化身有落脚点");
            let mut a = Actor::new_avatar(id, name, appearance, &spot, self.minutes);
            a.locus = spot.locus();
            self.actors.insert(id.into(), a);
        }
        let now = self.minutes;
        let a = self.actor_mut(id);
        a.reset_idle(now, true);
        let a = &self.actors[id];
        self.log(a.event_info(), format!("{} 来到小镇", a.name));
        Ok(id.into())
    }
    /// 化身从哪里进场：离开过的回到上次的位置，第一次来从地图入口进来。
    fn avatar_origin_of(&self, id: &str) -> Result<Locus> {
        if let Some(a) = self.avatar_of(id) {
            ensure!(!a.present(), KernelError::action("化身已经在场"));
            return Ok(a.avatar.as_ref().expect("化身有资料").last_locus.clone());
        }
        let entry = self
            .topo
            .spawn_candidates(None)?
            .into_iter()
            .next()
            .ok_or_else(|| KernelError::navigation("地图没有入口"))?;
        let station = entry
            .station
            .or_else(|| self.topo.default_station.get(&entry.locale).cloned())
            .ok_or_else(|| KernelError::navigation("入口没有落脚点"))?;
        Ok(Locus {
            at: At::Station { station },
            locale: entry.locale,
        })
    }
    /// 名字与外观的格式规则在 Profile 上；名字不能和居民或别的化身重名要看人物表。
    /// 只有**在场**的化身才占名字：关掉页面走掉的化身不该把名字永久占住。
    fn check_avatar_profile(&self, id: &str, name: &str, appearance: &Appearance) -> Result<()> {
        Profile::check_name(name)?;
        ensure!(
            !self
                .actors
                .values()
                .any(|a| a.id != id && !a.is_avatar() && a.name.trim() == name.trim()),
            KernelError::action("名字与居民重复")
        );
        ensure!(
            !self
                .avatars()
                .any(|a| a.id != id && a.present() && a.name.trim() == name.trim()),
            KernelError::action("名字与其他化身重复")
        );
        Profile::check_appearance(appearance)
    }
    pub fn avatar_profile(&mut self, name: &str, appearance: Appearance) -> Result<()> {
        let id = self.avatar().map_or(ID, |a| a.id.as_str()).to_owned();
        self.avatar_profile_of(&id, name, appearance)
    }
    pub fn avatar_profile_of(
        &mut self,
        id: &str,
        name: &str,
        appearance: Appearance,
    ) -> Result<()> {
        // 附身的村民没有化身资料，改不了身份；别的页面在附身别人不影响这里改名。
        ensure!(
            self.avatar_of(id).is_some(),
            KernelError::action("附身不能修改村民身份")
        );
        self.check_avatar_profile(id, name, &appearance)?;
        let a = self
            .actors
            .get_mut(id)
            .ok_or_else(|| KernelError::action("尚未创建化身"))?;
        a.name = name.trim().into();
        a.avatar.as_mut().expect("化身资料").appearance = appearance;
        Ok(())
    }
    pub fn avatar_leave(&mut self) -> Result<()> {
        let id = self.avatar().map_or(ID, |a| a.id.as_str()).to_owned();
        self.avatar_leave_of(&id)
    }
    pub fn avatar_leave_of(&mut self, id: &str) -> Result<()> {
        let Some(a) = self.avatar_of(id) else {
            return Ok(());
        };
        if !a.present() {
            return Ok(());
        }
        let locus = a.locus.clone();
        let name = a.name.clone();
        self.end_walks_of(id, "离开了小镇");
        self.interrupt_actions(id, "化身离开小镇");
        let now = self.minutes;
        let a = self.actor_mut(id);
        a.avatar.as_mut().expect("化身资料").last_locus = locus;
        a.locus.at = At::Offstage;
        a.reset_idle(now, true);
        let info = a.event_info();
        self.log(info, format!("{name} 离开小镇"));
        Ok(())
    }
    pub fn avatar_stop(&mut self) {
        let id = self.player_id().to_owned();
        self.avatar_stop_of(&id);
    }
    pub fn avatar_stop_of(&mut self, id: &str) {
        if self.actors.contains_key(id) {
            self.interrupt_actions(id, "停止当前活动");
            let now = self.minutes;
            self.actor_mut(id).reset_idle(now, false);
        }
    }
    pub fn avatar_control_epoch(&mut self, epoch: String) {
        let id = self.player_id().to_owned();
        self.avatar_control_epoch_of(&id, epoch);
    }
    pub fn avatar_control_epoch_of(&mut self, id: &str, epoch: String) {
        if let Some(p) = self.actor_control_mut(id) {
            p.reset(epoch);
        }
    }
    pub fn avatar_remember(&mut self, sequence: u64, receipt: serde_json::Value) {
        let id = self.player_id().to_owned();
        self.avatar_remember_of(&id, sequence, receipt);
    }
    pub fn avatar_remember_of(&mut self, id: &str, sequence: u64, receipt: serde_json::Value) {
        if let Some(p) = self.actor_control_mut(id) {
            p.remember(sequence, receipt);
        }
    }
    pub(crate) fn validate_avatar(&self, actors: &BTreeMap<String, Actor>) -> Result<()> {
        for a in actors.values().filter(|a| a.is_avatar()) {
            ensure!(
                is_id(&a.id),
                KernelError::snapshot("化身编号须为 player_avatar 或 player_avatar@N")
            );
        }
        // 附身与在场化身可以并存：多人玩法里各页面控制各的。单人玩法的「世界里只有一个
        // 控制者」由 `possess`、`avatar_enter` 的守护保证，不写进存档校验。
        for a in actors.values() {
            ensure!(
                a.is_avatar() == a.avatar.is_some(),
                KernelError::snapshot("化身身份与资料不一致")
            );
            if let Some(p) = &a.avatar {
                p.validate(a, self.walk_map.as_deref(), &self.topo)?;
            }
            self.validate_player_actor(a)?;
        }
        Ok(())
    }
}
