// 村民的目标、动作结果、互动、记忆和身体记录体积大、变得慢：名册每拍只带状态，这些变了才单独发一次
// （resident_detail）。这里按村民编号记下最新的一份，合并回每拍的名册帧，面板照旧读
// member.resident_agent / member.body，不用关心它是分几路送来的。
import type {
  ResidentAgentFull,
  ResidentAgentView,
  ResidentDetailView,
  RosterMember,
  ServerMsg,
} from '../protocol'

/** 名册里的成员，带上面板要读的完整村民状态 */
export type DetailedMember = Omit<RosterMember, 'resident_agent'> & {
  resident_agent?: ResidentAgentFull
}

/** 细节里并进 resident_agent 的那几项；身体记录并回 member.body.history */
type AgentDetail = Omit<ResidentDetailView, 'body_history'>

const EMPTY: AgentDetail = {
  goals: [],
  results: [],
  interactions: [],
  memories: [],
}

const details = new Map<string, ResidentDetailView>()

/** 收到一条 resident_detail：记下这人的最新细节 */
export function rememberDetail(msg: Extract<ServerMsg, { type: 'resident_detail' }>) {
  details.set(msg.resident, msg.detail)
}

/** 世界重置、断线时清掉：新世界的人可能同名，别拿旧细节冒充 */
export function forgetDetails() {
  details.clear()
}

/** 把单独发来的细节并进这位成员；还没收到细节时给空列表，面板不用判空 */
export function withDetail(member: RosterMember): DetailedMember {
  const saved = details.get(member.id)
  const detail: AgentDetail = saved ?? EMPTY
  const body =
    member.body && saved?.body_history.length
      ? { ...member.body, history: saved.body_history }
      : member.body
  const agent: ResidentAgentView | undefined = member.resident_agent
  return {
    ...member,
    body,
    resident_agent: agent ? { ...agent, ...detail } : agent,
  }
}
