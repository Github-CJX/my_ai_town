// 小镇列表、地图、开关世界、删除与道具摆放。同一个小镇的写操作按小镇串行。
import { HttpError } from './http.mjs'
import { safeId } from './storage.mjs'
import { positions } from './positions.mjs'
import {
  apiOf,
  createAgent,
  listAgents,
  publicAgent,
  readAgent,
  recordDeploy,
  recordTemplate,
  recordWithdraw,
  removeAgent,
  updateAgent,
} from './agents.mjs'
import { hasBudget, pushBudget, readBudget, saveBudget, townName, usageSummary } from './usage.mjs'
import { withTicket } from './ticket.mjs'

/** 天气可以选的那几种（与 protocol 的 WeatherKind 一致） */
const WEATHER = ['clear', 'overcast', 'light_rain', 'rain', 'heavy_rain', 'thunderstorm', 'snow']
/** 只给本机的地址 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** 请求的 Host 里那台主机：去掉端口，IPv6 去掉方括号 */
function hostName(host = '') {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end) : host
  }
  return host.split(':')[0]
}

/**
 * 页面拿到的世界地址：主机换成本次请求用的那台，路径换成本服务的 `/ws/<镇>`，
 * 由管理服务把连接转给世界进程——放到服务器上只开一个端口就够，反代也只需要转这一个。
 * 只在本机看时不改，世界进程本来就在 127.0.0.1 上，直连更省一层。
 * 套了 TLS（反代给 `x-forwarded-proto: https`）时给 wss。
 * `ticket` 是这次登录账号的入场票：世界凭票认人，地址上挂上它。
 */
export function publicEndpoint(headers, info, ticket, id) {
  let page = info
  const name = hostName(headers?.host)
  if (info?.endpoint && name && !LOOPBACK.has(name)) {
    try {
      const url = new URL(info.endpoint)
      const secure = `${headers['x-forwarded-proto'] ?? ''}`.toLowerCase() === 'https'
      // 反代给的是公开域名（多半没端口）；直连 IP 时 Host 里带着页面所在的那个端口，得留着
      const netloc = headers['x-forwarded-host'] || headers.host
      const [, onlyPort] = /:(\d+)$/.exec(netloc) ?? []
      url.protocol = secure ? 'wss:' : 'ws:'
      url.hostname = hostName(netloc)
      url.port = onlyPort ?? ''
      if (id) url.pathname = `/ws/${id}`
      page = { ...info, endpoint: url.toString() }
    } catch {
      page = info
    }
  }
  if (!page?.endpoint || !ticket) return page
  return { ...page, endpoint: withTicket(page.endpoint, ticket) }
}

/** 让正在运行的世界按这个速度走（0 是暂停）：刚拉起来、管理员在首页改过速度之后都走这一下 */
export async function applySpeed(hosts, id, speed) {
  if (!hosts.isRunning(id)) return
  await hosts.query(
    id,
    { type: 'set_speed', request_id: `resident-${id}`, speed },
    (m) => m.type === 'roster' && Math.abs(m.speed - speed) < 1e-9
  )
}

/** 看一眼正在运行的世界：选定的速度、此刻的天气、世界观设好没有（首页的控制按钮据此显示） */
export async function observe(hosts, id) {
  if (!hosts.isRunning(id)) return null
  try {
    const [roster, settings] = await Promise.all([
      hosts.query(id, null, (m) => m.type === 'roster'),
      hosts.query(id, { type: 'get_world_settings' }, (m) => m.type === 'world_settings'),
    ])
    return {
      speed: typeof roster.speed === 'number' ? roster.speed : null,
      weather: roster.environment
        ? { mode: roster.environment.mode, kind: roster.environment.kind }
        : null,
      ready: Boolean(settings.state?.ready),
      climate: Boolean(settings.state?.physiology?.weather),
    }
  } catch {
    return null
  }
}

/**
 * 把一位村民的密钥交给世界：世界只记内存，回执只有一句人话。
 * 回 null 表示送进去了；回一句人话表示没送进去（只当提示，不影响人已经投进去这件事）。
 */
async function handKey(hosts, id, resident, api) {
  const requestId = `key-${resident}-${Date.now()}`
  try {
    const reply = await hosts.query(
      id,
      {
        type: 'set_resident_key',
        request_id: requestId,
        resident,
        provider: api.provider,
        base_url: api.base_url,
        api_key: api.api_key,
      },
      (m) => m.type === 'resident_key_saved' && m.request_id === requestId,
      5000
    )
    return reply.ok ? null : reply.message || '世界没有收下这把密钥'
  } catch (e) {
    return e.message || '世界没有回应'
  }
}

/**
 * 把账号里的整份人设写进这个镇的村民库，回（模板编号，版本）。
 * 镇上那份还在、人也没改过 → 直接用；改过一版 → 按镇上当前版本重写；不在 → 新建一份。
 */
async function materialize(hosts, id, agent, cards) {
  const known = agent.templates?.[id]
  const current = known && cards.find((card) => card.template_id === known.template_id)
  if (
    known &&
    current &&
    (agent.revision ?? 0) === (known.revision ?? 0) &&
    current.version === known.version
  ) {
    return { template_id: known.template_id, version: known.version }
  }
  // 重写用的是镇上那份模板现在的版本号：有人在镇里改过它，也不会把人的改动盖掉
  const requestId = `template-${agent.id}-${Date.now()}`
  const reply = await hosts.query(
    id,
    {
      type: 'save_resident_template',
      request_id: requestId,
      fields: agent.fields,
      ...(known && current
        ? { template_id: known.template_id, expected_version: current.version }
        : {}),
    },
    (m) => m.type === 'template_saved' && m.request_id === requestId,
    20_000
  )
  if (!reply.ok) throw new HttpError(409, reply.message || '镇上写不进这份人设')
  if (!reply.template?.template_id) throw new HttpError(409, '镇上没给新模板的编号')
  return { template_id: reply.template.template_id, version: reply.template.version }
}

/**
 * 世界一重新拉起来，内存里的密钥就没了：按账号把投在这个镇里的 agent 的密钥再送一遍。
 * 送不进去只记一行日志——世界照常跑，村民会先在镇上等着，人还能收回再投一次。
 */
export async function sendOwnerKeys({ root, hosts, accounts, accountConfig }, id) {
  let users = []
  try {
    users = accounts.list()
  } catch {
    return
  }
  for (const user of users) {
    let agents = []
    try {
      agents = await listAgents(root, user.id)
    } catch {
      agents = []
    }
    // 每日额度也补一遍：世界重启后存档里还在，重置过的镇就没有了
    const budget = await readBudget(root, user.id)
    if (hasBudget(budget)) {
      try {
        await pushBudget(hosts, id, agents, budget, user.id)
      } catch (e) {
        console.error(`[town-manager] 重发「${user.name}」的每日额度没成功：${e.message}`)
      }
    }
    let api = null
    try {
      api = await apiOf(await accountConfig(user))
    } catch {
      api = null
    }
    if (!api) continue
    for (const agent of agents) {
      const record = agent.deployed?.[id]
      if (!record) continue
      const bad = await handKey(hosts, id, record.resident, api)
      if (bad) console.error(`[town-manager] 给「${agent.name}」重发密钥没成功：${bad}`)
    }
  }
}

export function createTownRoutes({
  source,
  root,
  storage,
  hosts,
  serial,
  configOf,
  current,
  resident,
  accounts,
  accountConfig,
}) {
  const inTown = (id, fn) => serial('town-' + safeId(id), fn)
  /** 这次请求是谁：agent 是账号自己的东西，没账号就没得谈 */
  const mine = (headers) => {
    const me = current(headers)
    if (!me) throw new HttpError(401, '先在首页「设定」里创建或选择一个账号', 'account')
    return me
  }
  /** 村民模板可以选的那几个（世界里说「可加入」的） */
  const library = async (id) => {
    const reply = await hosts.query(
      id,
      { type: 'get_resident_library' },
      (m) => m.type === 'resident_library'
    )
    return reply.templates ?? []
  }
  /** 镇上的居民与这个世界的编号：投人之前先看清重名没有 */
  const population = (id) =>
    hosts
      .query(id, { type: 'get_population' }, (m) => m.type === 'population')
      .then((m) => m.population)
  /** 只有管理员能决定哪个小镇在后台运行、能改它的速度与天气 */
  const admin = (headers) => {
    const me = current(headers)
    if (me?.role !== 'admin') throw new HttpError(403, '只有管理员能管理后台运行的小镇')
    return me
  }
  /** 首页要看到的：常驻小镇此刻的速度与天气（没见过就 null） */
  const look = (id) => observe(hosts, id)
  /** 被挤掉的小镇 → 挤掉它的小镇：另一个页面进了别的小镇时，这个页面断线后不自动抢回来 */
  const displaced = new Map()
  /** 正在被页面打开的小镇（关掉旧的、启动新的这段时间里它既不在运行也不在启动，也算占着） */
  const claiming = new Set()
  /** 把一个小镇拉起来：跑满了就先保存并关掉最久没人进过的那个，常驻的不参与挤占 */
  const bringUp = async (id, headers) => {
    claiming.add(id)
    try {
      while (!hosts.isRunning(id) && hosts.full()) {
        const oldest = hosts.leastRecent(id)
        if (!oldest) break
        displaced.set(oldest, id)
        await inTown(oldest, () => hosts.close(oldest))
      }
      displaced.delete(id)
      // 世界用开它的那个账号的配置（密钥）跑
      return await inTown(id, async () => hosts.open(id, await configOf(headers)))
    } finally {
      claiming.delete(id)
    }
  }
  return [
    [
      'GET',
      /^\/api\/towns\/health$/,
      ({ headers }) => ({
        kind: 'town-manager',
        version: 1,
        pid: process.pid,
        source,
        user: current(headers),
      }),
    ],
    [
      'GET',
      /^\/api\/towns$/,
      async ({ headers }) => {
        const residentId = resident.town()
        return {
          towns: (await storage.list()).map((town) => ({
            ...town,
            running: hosts.isRunning(town.id),
            resident: town.id === residentId,
          })),
          resident: residentId,
          // 只有管理员能安排后台运行、能改常驻小镇的速度和天气：首页据此显示那几个按钮
          admin: current(headers)?.role === 'admin',
          // 常驻小镇此刻的速度与天气：首页的控制按钮要显示当前值
          status: residentId ? await look(residentId) : null,
        }
      },
    ],
    [
      'GET',
      /^\/api\/towns\/agents$/,
      async ({ headers }) => {
        const me = mine(headers)
        return {
          agents: (await listAgents(root, me.id)).map(publicAgent),
          limit: me.agent_limit ?? null,
        }
      },
    ],
    [
      'POST',
      /^\/api\/towns\/agents$/,
      async ({ body, headers }) => {
        const me = mine(headers)
        const agent = await serial('agents-' + me.id, () =>
          createAgent(root, me.id, body, me.agent_limit ?? null)
        )
        return { ok: true, agent: publicAgent(agent) }
      },
    ],
    [
      'POST',
      /^\/api\/towns\/agents\/delete$/,
      async ({ body, headers }) => {
        const me = mine(headers)
        await serial('agents-' + me.id, () => removeAgent(root, me.id, body?.id))
        return { ok: true }
      },
    ],
    [
      // 改定义：人设、长相、落脚点。已经投出去的那位不会跟着变，收回再投才更新
      'POST',
      /^\/api\/towns\/agents\/update$/,
      async ({ body, headers }) => {
        const me = mine(headers)
        const agent = await serial('agents-' + me.id, () => updateAgent(root, me.id, body))
        return { ok: true, agent: publicAgent(agent) }
      },
    ],
    [
      // 今天用了多少：世界按居民记，这里换回账号的 agent 再加起来
      'GET',
      /^\/api\/towns\/usage$/,
      async ({ headers }) => {
        const me = mine(headers)
        return usageSummary({ root, userId: me.id, hosts, storage })
      },
    ],
    [
      // 账号自己的每日额度：存下来，顺手发给正在跑的小镇
      'POST',
      /^\/api\/towns\/budget$/,
      async ({ body, headers }) => {
        const me = mine(headers)
        const budget = await saveBudget(root, me.id, body)
        const agents = await listAgents(root, me.id)
        const notes = []
        const towns = new Set(agents.flatMap((agent) => Object.keys(agent.deployed ?? {})))
        for (const town of towns) {
          if (!hosts.isRunning(town)) continue
          try {
            await pushBudget(hosts, town, agents, budget, me.id)
          } catch (e) {
            notes.push(`「${await townName(storage, town)}」还没接受这个额度（${e.message}）`)
          }
        }
        return { ok: true, budget, notes }
      },
    ],
    [
      'GET',
      /^\/api\/towns\/([a-z0-9-]+)\/templates$/,
      async ({ params: [id] }) => {
        id = safeId(id)
        if (!hosts.isRunning(id))
          throw new HttpError(409, '这个小镇没在运行：先进一次，或让它在后台运行')
        const cards = await library(id)
        return {
          templates: cards
            .filter((card) => card.status === 'available')
            .map((card) => ({
              template_id: card.template_id,
              version: card.version,
              name: card.name,
              intro: card.intro,
              tags: card.tags ?? [],
            })),
        }
      },
    ],
    [
      // 首页建村民时用：按字段渲染人设全文（世界那边是纯函数，不落盘）
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/persona$/,
      async ({ params: [id], body }) => {
        id = safeId(id)
        if (!hosts.isRunning(id))
          throw new HttpError(409, '这个小镇没在运行：先进一次，或让它在后台运行，才能预览人设')
        const reply = await hosts.query(
          id,
          { type: 'preview_template_persona', fields: body?.fields },
          (m) => m.type === 'template_persona'
        )
        return { persona: reply.persona ?? '', error: reply.error ?? null }
      },
    ],
    [
      // 首页建村民时用：世界的工具模型按一句话描述生成一整份人设
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/generate$/,
      async ({ params: [id], body }) => {
        id = safeId(id)
        if (!hosts.isRunning(id))
          throw new HttpError(409, '这个小镇没在运行：先进一次，或让它在后台运行，才能用模型生成')
        const requestId = `generate-${Date.now()}`
        const reply = await hosts.query(
          id,
          { type: 'generate_resident_template', request_id: requestId, brief: body?.brief },
          (m) => m.type === 'template_generated' && m.request_id === requestId,
          120_000
        )
        return { ok: Boolean(reply.ok), message: reply.message ?? '', fields: reply.fields ?? null }
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/deploy$/,
      async ({ params: [id], body, headers }) => {
        const me = mine(headers)
        id = safeId(id)
        const agent = await readAgent(root, me.id, body?.agent_id)
        if (agent.deployed?.[id]) throw new HttpError(409, '这个 agent 已经在这个镇里了')
        if (!hosts.isRunning(id))
          throw new HttpError(409, '这个小镇没在运行：先进一次，或让它在后台运行，再投放')
        return inTown(id, async () => {
          // 世界观没设好的世界还不收人：先说清楚缺哪一步，别让世界回一句「请先设置世界观」
          const state = await observe(hosts, id)
          if (!state?.ready)
            throw new HttpError(409, '这个小镇还没设定世界观：先进镇里设定一次，再投放')
          const view = await population(id)
          if (view.residents.some((person) => person.name === agent.name))
            throw new HttpError(409, `镇上已经有叫「${agent.name}」的居民了，换一个名字再投`)
          const cards = await library(id)
          let template = null
          if (agent.fields) {
            // 新形状：定义里带着整份人设，投放时在镇上写一份模板（人改过一版就重写）
            const made = await materialize(hosts, id, agent, cards)
            await serial('agents-' + me.id, () =>
              recordTemplate(root, me.id, agent, id, made.template_id, made.version)
            )
            template = made
          } else {
            // 老形状：定义只记着某个镇的模板，那份模板得还在、并且还没人占用
            template = cards.find(
              (card) =>
                card.template_id === agent.template_id &&
                card.version === agent.template_version &&
                card.status === 'available'
            )
            if (!template)
              throw new HttpError(
                409,
                '这个镇没有这个模板（或者它已经在用了）：换个模板，或在这个镇重新建一个 agent'
              )
          }
          // 他自己的模型与密钥：世界只记内存，重启后由这里重发
          const api = await apiOf(await accountConfig(me)).catch(() => null)
          const opId = `agent-${agent.id}-${Date.now()}`
          const command = {
            type: 'join_resident',
            op_id: opId,
            world_id: view.world_id,
            template_id: template.template_id,
            template_version: template.version,
            name: agent.name,
            ...(api ? { model: { provider: api.provider, model: api.model } } : {}),
            ...(agent.home && view.homes.some((home) => home.locale === agent.home)
              ? { home: agent.home }
              : {}),
          }
          const ask = (op) =>
            hosts.query(
              id,
              command,
              (m) =>
                (m.type === 'resident_joined' && m.outcome?.op_id === op) ||
                (m.type === 'join_result' && m.op_id === op),
              20_000
            )
          let reply = await ask(opId)
          // 世界的服务商名单里没有他账号里选的那家（他自己加过一个服务商）：先让他进来等着，
          // 别因为这一句就把人挡在门外
          let stranger = false
          if (
            api &&
            !reply.outcome?.ok &&
            `${reply.outcome?.message ?? ''}`.includes('模型服务尚未配置')
          ) {
            stranger = true
            delete command.model
            command.op_id = `${opId}-plain`
            reply = await hosts.query(
              id,
              command,
              (m) =>
                (m.type === 'resident_joined' && m.outcome?.op_id === command.op_id) ||
                (m.type === 'join_result' && m.op_id === command.op_id),
              20_000
            )
          }
          const outcome = reply.outcome
          if (!outcome?.ok) throw new HttpError(409, outcome?.message || '没能投进这个小镇')
          const saved = await serial('agents-' + me.id, () =>
            recordDeploy(root, me.id, agent, id, {
              resident: outcome.resident_id,
              name: outcome.name ?? agent.name,
            })
          )
          // 他自己设过每日额度的话，跟着发给镇上这位居民（世界按居民记，投别人不受影响）
          const budget = await readBudget(root, me.id)
          let budgetNote = ''
          if (hasBudget(budget)) {
            try {
              await pushBudget(hosts, id, [saved], budget, me.id)
            } catch (e) {
              budgetNote = `他自己的每日额度没送到世界那边（${e.message}）：先按全镇额度算`
            }
          }
          const note = stranger
            ? `这个镇还不认识他账号里选的服务商（${api.provider}）：人已经投进去了，会先在镇上等着。把这家服务商加进小镇的名单之后，收回他再投一次`
            : !api
              ? '他这个账号还没选好模型和密钥：人已经投进去了，会先在镇上等着。你在「设定 · 账号」里配好之后，收回他再投一次'
              : await handKey(hosts, id, saved.deployed?.[id]?.resident, api)
          const said = [
            note
              ? stranger || !api
                ? note
                : `他已经在镇上了，但密钥没送到世界那边（${note}）：先让他等着，过一会儿再投放一次`
              : '',
            budgetNote,
          ].filter(Boolean)
          return {
            ok: true,
            agent: publicAgent(saved),
            ...(said.length ? { note: said.join('；') } : {}),
          }
        })
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/withdraw$/,
      async ({ params: [id], body, headers }) => {
        const me = mine(headers)
        id = safeId(id)
        const agent = await readAgent(root, me.id, body?.agent_id)
        const record = agent.deployed?.[id]
        if (!record) throw new HttpError(409, '这个 agent 不在这个镇里')
        if (!hosts.isRunning(id))
          throw new HttpError(409, '这个小镇没在运行：先进一次，或让它在后台运行，才收得回来')
        return inTown(id, async () => {
          const requestId = `withdraw-${agent.id}-${Date.now()}`
          const reply = await hosts.query(
            id,
            { type: 'remove_resident', request_id: requestId, resident: record.resident },
            (m) => m.type === 'resident_removed' && m.request_id === requestId,
            20_000
          )
          const save = (again) =>
            serial('agents-' + me.id, () => recordWithdraw(root, me.id, again, id))
          if (!reply.ok) {
            const message = reply.message || '没能请他离开'
            // 世界那边本来就没这个人了（重置过、或存档换过）：记录跟着清掉，不然这个 agent 永远删不掉
            if (message.includes('名册里没有')) {
              const again = await save(agent)
              return { ok: true, agent: publicAgent(again), note: message }
            }
            throw new HttpError(409, message)
          }
          const again = await save(agent)
          return { ok: true, agent: publicAgent(again), message: reply.message }
        })
      },
    ],
    [
      'GET',
      /^\/api\/towns\/([a-z0-9-]+)\/map$/,
      async ({ params: [id], url }) => {
        const document = await storage.map(safeId(id))
        if (url.searchParams.has('hash') && url.searchParams.get('hash') !== document.content_hash)
          throw Error('地图已变化，请返回小镇列表重新打开')
        return document
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/open$/,
      async ({ params: [id], body, headers }) => {
        // 页面断线后自动重开（automatic）：这个小镇是被另一个页面进的小镇挤掉的、那个还开着，
        // 就不抢回来，告诉页面原因，由玩家自己决定回不回来；不然两个页面会来回互相挤
        const by = displaced.get(id)
        if (body?.automatic && by && (hosts.isRunning(by) || claiming.has(by))) {
          const { name } = await storage.labels(by, await storage.map(by))
          throw new HttpError(409, `另一个页面打开了「${name}」，同一时间只能运行一个小镇`)
        }
        // 有后台运行的小镇时，别人只能进那一个：管理员想换，先在首页把常驻换过来
        const residentId = resident.town()
        if (residentId && residentId !== id && current(headers)?.role !== 'admin') {
          const { name } = await storage.labels(residentId, await storage.map(residentId))
          throw new HttpError(
            403,
            `现在后台运行的是「${name}」，同一时间只有一个小镇在跑`,
            'resident'
          )
        }
        const info = await bringUp(id, headers)
        // 世界是新的，内存里没有密钥：把投在这个镇里的 agent 再送一遍
        if (hosts.isRunning(id)) await sendOwnerKeys({ root, hosts, accounts, accountConfig }, id)
        const me = current(headers)
        return publicEndpoint(headers, info, hosts.ticket(id, me?.id, me?.role === 'admin'), id)
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/close$/,
      async ({ params: [id], body }) => {
        // 常驻小镇不因为有人离开就停：它在后台跑，要它停得管理员先在首页取消常驻
        if (resident.town() === id) return { ok: true, closed: false, resident: true }
        // 带着打开凭证来关：之后又有页面打开过这个小镇（比如刷新），旧页面晚到的关闭不算数
        const closed = await inTown(id, async () => {
          if (body?.lease && hosts.isRunning(id) && !hosts.holds(id, body.lease)) return false
          await hosts.close(id)
          return true
        })
        return { ok: true, closed }
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/resident$/,
      async ({ params: [id], body, headers }) => {
        admin(headers)
        // 取消常驻只是不再后台看着它：正开着的世界不动，谁想进还能进
        if (body?.on === false) {
          if (resident.town() !== id) return { ok: true, resident: resident.town() }
          await resident.set(null)
          hosts.setResident(null)
          return { ok: true, resident: null }
        }
        await storage.map(safeId(id))
        await resident.set(id)
        hosts.setResident(id)
        const info = await bringUp(id, headers)
        if (hosts.isRunning(id)) await sendOwnerKeys({ root, hosts, accounts, accountConfig }, id)
        // 世界观设好的小镇才谈得上「在后台跑」：没设好的先停着，等管理员进镇设一次
        const state = await look(id)
        if (state?.ready) {
          try {
            await applySpeed(hosts, id, resident.speed())
          } catch (e) {
            // 速度没设上不影响常驻：留在后台，一会儿心跳再试
            console.error('[town-manager] 常驻小镇的速度没设上：', e.message)
          }
        }
        return publicEndpoint(
          headers,
          { ...info, resident: id, ready: Boolean(state?.ready) },
          hosts.ticket(id, current(headers)?.id, current(headers)?.role === 'admin'),
          id
        )
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/control$/,
      async ({ params: [id], body, headers }) => {
        admin(headers)
        if (resident.town() !== id) throw new HttpError(403, '只能控制后台运行的那个小镇')
        const state = await look(id)
        if (!state) throw new HttpError(409, '这个小镇正在拉起来，稍等一会儿再试')
        if (body?.kind === 'speed') {
          const speed = Number(body.speed)
          if (!Number.isFinite(speed) || speed < 0 || speed > 64)
            throw new HttpError(400, '速度不对')
          if (!state.ready) throw new HttpError(409, '这个小镇还没设定世界观，先进镇里设定一次')
          await resident.setSpeed(speed)
          await applySpeed(hosts, id, speed)
          return { ok: true, speed }
        }
        if (body?.kind === 'weather') {
          if (!state.weather) throw new HttpError(409, '这个小镇没开天气，先进镇里的设定打开')
          const environment = await hosts
            .query(id, null, (m) => m.type === 'roster')
            .then((roster) => roster.environment)
          if (!environment) throw new HttpError(409, '这个世界还没有天气')
          const mode = body.mode === 'fixed' ? 'fixed' : 'natural'
          if (mode === 'fixed' && !WEATHER.includes(body.weather))
            throw new HttpError(400, '没有这种天气')
          const command = {
            type: 'set_weather',
            request_id: `resident-weather-${Date.now()}`,
            world_id: environment.world_id,
            expected_revision: environment.revision,
            mode,
            ...(mode === 'fixed' ? { kind: body.weather } : {}),
          }
          const saved = await hosts.query(
            id,
            command,
            (m) => m.type === 'weather_saved' && m.request_id === command.request_id
          )
          if (!saved.ok) throw new HttpError(409, saved.message || '天气没能改')
          return {
            ok: true,
            weather: saved.environment
              ? { mode: saved.environment.mode, kind: saved.environment.kind }
              : { mode },
          }
        }
        throw new HttpError(400, '不认识的控制')
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/delete$/,
      ({ params: [id] }) =>
        inTown(id, async () => {
          if (!storage.canDelete(id)) throw new HttpError(403, '内置地图不能删除')
          if (resident.town() === id) {
            await resident.set(null)
            hosts.setResident(null)
          }
          await hosts.close(id)
          await storage.remove(id)
          return { ok: true }
        }),
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/reset$/,
      ({ params: [id] }) =>
        inTown(id, async () => {
          if (!id.startsWith('prefab-')) throw new HttpError(403, '只有预制小镇能重新开始')
          await hosts.close(id)
          await storage.remove(id, true)
          return { ok: true }
        }),
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/positions$/,
      ({ params: [id], body }) =>
        inTown(id, async () => {
          const document = await storage.map(id)
          if (document.content_hash !== body.map_hash) throw Error('地图版本不匹配')
          return { positions: await positions(storage, id, document, body.instances) }
        }),
    ],
  ]
}
