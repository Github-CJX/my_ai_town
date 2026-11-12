import { button, el, query } from '../dom'
import { readUsage, type AccountUsage } from '../townApi'
import {
  budgetText,
  countText,
  dayText,
  hitText,
  missingText,
  moneyText,
  rowState,
  tokenText,
  weekOf,
} from './report'
import './accountUsage.css'

// 「我的用量」：这个账号投出去的 agent 今天在各镇花了多少、近 7 天折了账本里的几天、每日额度是多少。
// 数字全由管理服务算好（GET /api/towns/usage：世界按居民记，再折回账号的 agent），这里只摆。
// 额度的编辑留在首页那一行「每日额度」，这一块只说当前是多少、去哪里改。

export interface AccountUsageDeps {
  /** 读一份最新的用量；管理服务是老版本（还没有这个接口）时给 null */
  load?: () => Promise<AccountUsage | null>
}

const AGENT_HEAD = ['agent', '在哪', '状态', '调用', 'token', '缓存命中', '花费']
const DAY_HEAD = ['日期', '调用', 'token', '缓存命中', '花费']

function row(cells: (string | HTMLElement)[], cls = '') {
  const tr = el('tr', '', cls)
  for (const item of cells) {
    const cell = el('td')
    if (typeof item === 'string') cell.textContent = item
    else cell.append(item)
    tr.append(cell)
  }
  return tr
}

function table(head: string[], lines: HTMLElement[]) {
  const box = el('div', '', 'au-scroll')
  const grid = el('table', '', 'au-table')
  const headRow = el('tr')
  for (const name of head) headRow.append(el('th', name))
  grid.append(headRow, ...lines)
  box.append(grid)
  return box
}

export function initAccountUsage(root: HTMLElement, deps: AccountUsageDeps = {}) {
  const load = deps.load ?? readUsage
  root.classList.add('au')
  root.innerHTML = `
    <div class="au-head">
      <p class="au-today dim">今天：尚未读取</p>
      <button type="button" class="au-refresh">刷新</button>
    </div>
    <div class="au-cards">
      <div class="au-card"><span class="dim">今天调用</span><strong class="au-calls">—</strong>
        <span class="dim au-calls-hint">投出去的 agent 一起算</span></div>
      <div class="au-card"><span class="dim">今天 token</span><strong class="au-tokens">—</strong>
        <span class="dim au-tokens-hint">缓存命中 —</span></div>
      <div class="au-card"><span class="dim">今天花费</span><strong class="au-cost">—</strong>
        <span class="dim au-cost-hint">按价目表折算</span></div>
      <div class="au-card"><span class="dim">近 7 天</span><strong class="au-week">—</strong>
        <span class="dim au-week-hint">账本里记着的几天</span></div>
    </div>
    <p class="au-budget dim"></p>
    <div class="au-agents"></div>
    <div class="au-days"></div>
    <p class="au-note dim">世界按居民记账，管理服务把它折回这个账号的 agent。账本跨天留着，
      换天不归零；没回计量、价目表里没有模型的请求，钱算不出来，照实说。</p>
    <p class="au-status page-status" role="status"></p>
  `
  const today = query<HTMLElement>(root, '.au-today')
  const refreshButton = query<HTMLButtonElement>(root, '.au-refresh')
  const cards = {
    calls: query<HTMLElement>(root, '.au-calls'),
    callsHint: query<HTMLElement>(root, '.au-calls-hint'),
    tokens: query<HTMLElement>(root, '.au-tokens'),
    tokensHint: query<HTMLElement>(root, '.au-tokens-hint'),
    cost: query<HTMLElement>(root, '.au-cost'),
    costHint: query<HTMLElement>(root, '.au-cost-hint'),
    week: query<HTMLElement>(root, '.au-week'),
    weekHint: query<HTMLElement>(root, '.au-week-hint'),
  }
  const budgetLine = query<HTMLElement>(root, '.au-budget')
  const agentBox = query<HTMLElement>(root, '.au-agents')
  const dayBox = query<HTMLElement>(root, '.au-days')
  const status = query<HTMLElement>(root, '.au-status')
  let loading = false

  const say = (text: string, cls = '') => {
    status.textContent = text
    status.className = `au-status page-status ${cls}`.trimEnd()
  }

  function clear() {
    today.textContent = '今天：尚未读取'
    for (const node of Object.values(cards)) node.textContent = '—'
    budgetLine.textContent = ''
    agentBox.replaceChildren()
    dayBox.replaceChildren()
  }

  function showEmpty(text: string) {
    agentBox.replaceChildren(el('p', text, 'au-empty dim'))
  }

  function renderAgents(usage: AccountUsage) {
    agentBox.replaceChildren()
    if (!usage.agents.length) {
      showEmpty('这个账号还没有 agent 投出去。投出去以后，他花掉的每次请求都会记在这里。')
      return
    }
    const lines = usage.agents.map((agent) => {
      const state = rowState(agent)
      const badge = el('span', state.text, `au-state ${state.cls}`.trimEnd())
      return row([
        agent.name || agent.resident_name,
        agent.town_name,
        badge,
        countText(agent.calls),
        countText(agent.tokens),
        hitText(agent.cache_hit_tokens, agent.input_tokens),
        agent.calls > 0 ? moneyText(agent.cost_micros) : '—',
      ])
    })
    const note = el('h3', '按 agent', 'section-caption')
    agentBox.append(note, table(AGENT_HEAD, lines))
  }

  function renderDays(usage: AccountUsage) {
    dayBox.replaceChildren()
    const note = el('h3', '近 7 天', 'section-caption')
    if (!usage.history.length) {
      dayBox.append(
        note,
        el('p', '账本里还没有记录。今天之后再打开就能看到前几天的。', 'au-empty dim')
      )
      return
    }
    // 新的在前：账本本来就是这么给的，不再倒一遍，读者一眼看到今天
    const lines = usage.history.map((day) =>
      row([
        dayText(day.day),
        countText(day.calls),
        countText(day.tokens),
        hitText(day.cache_hit_tokens, day.input_tokens),
        day.calls > 0 ? moneyText(day.cost_micros) : '—',
      ])
    )
    dayBox.append(note, table(DAY_HEAD, lines))
  }

  function render(usage: AccountUsage) {
    const { totals } = usage
    const missing = missingText(totals)
    today.textContent = `今天：${countText(totals.calls)} 次 · ${tokenText(totals.tokens)}`
    cards.calls.textContent = countText(totals.calls)
    cards.callsHint.textContent = `${usage.agents.length} 位 agent 投出去了`
    cards.tokens.textContent = countText(totals.tokens)
    cards.tokensHint.textContent = `缓存命中 ${hitText(
      usage.agents.reduce((sum, a) => sum + a.cache_hit_tokens, 0),
      usage.agents.reduce((sum, a) => sum + a.input_tokens, 0)
    )}`
    cards.cost.textContent = totals.priced > 0 ? moneyText(totals.cost_micros) : '—'
    cards.costHint.textContent = missing || '按价目表折算，实际以服务商账单为准'
    const week = weekOf(usage.history)
    cards.week.textContent = week.days ? `${countText(week.calls)} 次` : '—'
    cards.weekHint.textContent = week.days
      ? `${week.days} 天 · ${tokenText(week.tokens)} · ${
          week.cost_micros > 0 ? moneyText(week.cost_micros) : '钱没算'
        }`
      : '账本里还没有记录'
    budgetLine.textContent = `每日额度：${budgetText(usage.budget)}（在首页「我的 agent」那一行的「每日额度」里改）`
    renderAgents(usage)
    renderDays(usage)
  }

  async function refresh() {
    if (loading) return
    loading = true
    refreshButton.disabled = true
    say('正在读取用量…')
    let usage: AccountUsage | null = null
    try {
      usage = await load()
    } catch {
      usage = null
    }
    loading = false
    refreshButton.disabled = false
    if (!usage) {
      clear()
      say('读不到用量：这个管理服务还是旧版（没有账号用量接口），或者刚刚断线了。', 'drop')
      return
    }
    render(usage)
    say('')
  }

  refreshButton.addEventListener('click', () => void refresh())
  say('')

  return { refresh }
}
