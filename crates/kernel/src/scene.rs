//! 场景结果：一条世界命令执行完之后，模型能依据的事实边界（AI-WP-06 的 `SceneOutcome`）。
//!
//! 「模型提议，世界确认」在回执上的落点：状态由世界给，事件编号是真正落进世界的那几条，
//! `facts` 是执行之后本人真实的位置、姿态、活动、身边的人和正在进行的接触。
//! 叙述只许照这里说——状态不是成功就不能写成完成，亲近被拒就不能写成牵上了。
use crate::intent::BuiltinVerb;
use crate::world::{Actor, World};
use protocol::{ActionGroup, GroupStatus, Interaction, InteractionKind, InteractionStatus};
use serde::Serialize;

/// 命令结束时本人的真实状态。只投影后续叙述与对话真正需要的几项：
/// 在哪、什么姿态、在做什么、身边有谁、和谁有接触。门与复杂道具留到需要时再加。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SceneFacts {
    pub locale: String,
    pub place: String,
    pub posture: &'static str,
    pub verb: String,
    /// 同一处所里、能看见的其他人（名字）。
    pub with: Vec<String>,
    /// 正在牵手、依偎或拥抱的人（名字）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub touch: Option<String>,
}

impl SceneFacts {
    pub fn of(world: &World, actor: &str) -> Option<Self> {
        let me = world.actor(actor)?;
        let locale = me.locus.locale.clone();
        Some(Self {
            place: world.topo.locale_name(&locale),
            posture: posture_of(me),
            verb: me.current.verb.clone(),
            with: world
                .actor_ids()
                .into_iter()
                .filter(|id| id != actor)
                .filter_map(|id| {
                    let other = world.actor(&id)?;
                    (other.present() && other.locus.locale == locale).then(|| other.name.clone())
                })
                .collect(),
            touch: contact_of(world, actor),
            locale,
        })
    }
}

/// 一条命令的结果。`command_id` 与 `event_ids` 让文字、动画和世界事件能对上。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SceneOutcome {
    pub command_id: String,
    /// running / succeeded / failed / interrupted；互动另有 offered / declined / cancelled / expired。
    pub status: &'static str,
    /// 这次命令真正落进世界的事件编号，按升序去重。
    pub event_ids: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub facts: SceneFacts,
}

impl SceneOutcome {
    pub fn of_group(world: &World, actor: &str, group: &ActionGroup) -> Option<Self> {
        Some(Self {
            command_id: group.id.clone(),
            status: match group.status {
                GroupStatus::Running => "running",
                GroupStatus::Succeeded => "succeeded",
                GroupStatus::Failed => "failed",
                GroupStatus::Interrupted => "interrupted",
            },
            event_ids: sorted(
                group
                    .results
                    .iter()
                    .flat_map(|r| r.event_ids.iter().copied()),
            ),
            reason: group.results.iter().find_map(|r| r.reason.clone()),
            facts: SceneFacts::of(world, actor)?,
        })
    }

    pub fn of_interaction(world: &World, actor: &str, item: &Interaction) -> Option<Self> {
        Some(Self {
            command_id: item.id.clone(),
            status: match item.status {
                InteractionStatus::Offered => "offered",
                InteractionStatus::Running => "running",
                InteractionStatus::Succeeded => "succeeded",
                InteractionStatus::Declined => "declined",
                InteractionStatus::Cancelled => "cancelled",
                InteractionStatus::Expired => "expired",
                InteractionStatus::Interrupted => "interrupted",
            },
            event_ids: sorted(item.event_ids.values().flat_map(|ids| ids.iter().copied())),
            reason: item.reason.clone(),
            facts: SceneFacts::of(world, actor)?,
        })
    }
}

fn sorted(ids: impl Iterator<Item = u64>) -> Vec<u64> {
    let mut ids: Vec<u64> = ids.collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// 姿态：以世界里的活动为准，不看模型怎么说。
fn posture_of(a: &Actor) -> &'static str {
    if a.current.is_travel() {
        return "walking";
    }
    match BuiltinVerb::parse(&a.current.verb) {
        Some(BuiltinVerb::Sit) => "sitting",
        Some(BuiltinVerb::Lie) => "lying",
        Some(BuiltinVerb::Goto) => "walking",
        _ => "standing",
    }
}

/// 正在进行的亲近（牵手、依偎、拥抱）对象；其他互动不算接触。
fn contact_of(world: &World, actor: &str) -> Option<String> {
    world
        .interactions()
        .for_actor(actor)
        .into_iter()
        .find(|i| {
            i.status == InteractionStatus::Running
                && matches!(i.kind, InteractionKind::Touch { .. })
        })
        .and_then(|i| world.actor(&i.partner))
        .map(|p| p.name.clone())
}
