//! 给页面用的绑定接口：把「我的某个 agent」和「一个 QQ 号」绑起来。
//!
//! 只认自己的 agent：`readAgent(root, me.id, id)` 找不到就 404，所以这里写不出别人的绑定，
//! 也不需要再比一次主人；世界那侧还有一道 `owner` 校验，写错了也递不出去。

import { accountNeeded } from '../towns/accounts.mjs'
import { listAgents, readAgent } from '../towns/agents.mjs'
import { HttpError } from '../towns/http.mjs'
import { bind, findByResident, readBindings, saveBindings, unbind } from './bindings.mjs'
import { maskId } from './gateway.mjs'

/** QQ 的 openid：一串字母数字，长度不短；不合法就别往绑定表里写。 */
const OPENID = /^[A-Za-z0-9_-]{8,128}$/

export function createQqRoutes({ root, current, bridge, config, bindings }) {
  const bindingsFile = bindings
  const configFile = config
  const mine = (headers) => {
    const me = current(headers)
    if (!me) throw accountNeeded()
    return me
  }

  /** 我的 agent 里已经投放的那些：能绑的候选。 */
  const deployed = async (userId) => {
    const agents = await listAgents(root, userId)
    const rows = []
    for (const agent of agents)
      for (const record of Object.entries(agent.deployed ?? {}))
        rows.push({
          agent: agent.id,
          name: agent.name,
          town: record[0],
          resident: record[1].resident,
          resident_name: record[1].name,
        })
    return rows
  }

  const listing = async (userId) => {
    const data = await readBindings(bindingsFile)
    const status = new Map((bridge?.status().bindings ?? []).map((row) => [row.resident, row]))
    return {
      ok: true,
      config: configFile,
      agents: await deployed(userId),
      bindings: data.bindings
        .filter((item) => item.account === userId)
        .map((item) => ({
          resident: item.resident,
          resident_name: item.resident_name,
          town: item.town,
          openid: maskId(item.openid),
          since: item.since,
          online: Boolean(status.get(item.resident)?.connected),
        })),
    }
  }

  /** 从「我的哪个 agent」找到要绑的那位村民：投放记录是唯一的来源。 */
  const target = async (userId, body) => {
    const agent = String(body.agent ?? '').trim()
    if (!agent) throw new HttpError(400, '先选一个 agent')
    const record = await readAgent(root, userId, agent)
    const entries = Object.entries(record.deployed ?? {})
    if (!entries.length) throw new HttpError(400, `「${record.name}」还没投放到镇上`)
    const town = String(body.town ?? '').trim()
    const hit = town ? entries.find(([id]) => id === town) : entries[0]
    if (!hit)
      throw new HttpError(
        400,
        `「${record.name}」不在 ${town}：她投放的镇是 ${entries.map(([id]) => id).join('、')}`
      )
    return { town: hit[0], resident: hit[1].resident, resident_name: hit[1].name }
  }

  return [
    [
      // 我的 agent 与它们的 QQ 绑定
      'GET',
      /^\/api\/qq\/binding$/,
      async ({ headers }) => listing(mine(headers).id),
    ],
    [
      'POST',
      /^\/api\/qq\/binding$/,
      async ({ body, headers }) => {
        const me = mine(headers)
        const openid = String(body.openid ?? '').trim()
        if (!OPENID.test(openid))
          throw new HttpError(400, 'QQ 号看起来不对：用 AppID 后台报的 openid，不是 QQ 号码')
        const { town, resident, resident_name } = await target(me.id, body)
        const data = await readBindings(bindingsFile)
        let next
        try {
          next = bind(data, {
            openid,
            account: me.id,
            town,
            resident,
            resident_name,
          })
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : String(error))
        }
        await saveBindings(bindingsFile, next)
        await bridge?.reload()
        return listing(me.id)
      },
    ],
    [
      'POST',
      /^\/api\/qq\/unbind$/,
      async ({ body, headers }) => {
        const me = mine(headers)
        const { resident } = await target(me.id, body)
        const data = await readBindings(bindingsFile)
        const hit = findByResident(data, resident)
        if (!hit || hit.account !== me.id) throw new HttpError(404, '这位村民还没绑 QQ')
        await saveBindings(bindingsFile, unbind(data, { resident }))
        await bridge?.reload()
        return listing(me.id)
      },
    ],
  ]
}
