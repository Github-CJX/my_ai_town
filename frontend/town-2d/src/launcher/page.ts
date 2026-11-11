import 'town-shared/style.css'
import './style.css'
import type { MapEntry } from 'town-shared/mapDocument'
import type { GameMap } from 'town-shared/gameMap'
import { $, button, query } from 'town-shared/dom'
import { errorText } from 'town-shared/format'
import { loadDocument } from '../assets'
import { createMapRenderer } from '../mapRenderers'
import { gameUrl, openMap, readTowns } from './catalog'
import { initCreator } from './creator'
import { PREFABS, type Prefab } from 'town-shared/prefabs/index'
import { generatePrefab, isBuiltinTown, missingPrefabs, prefabTownId } from './prefabEntry'
import { api, TownApiError } from './api'
import {
  ACCOUNT_NEEDED,
  controlTown,
  deleteAgent,
  deployAgent,
  keepRunning,
  readAgents,
  readUsage,
  saveBudget,
  type AccountUsage,
  type HomeAgent,
  type ResidentStatus,
  withdrawAgent,
} from 'town-shared/townApi'
import { gameIcon } from 'town-shared/game/icons'
import { lookKey, portraitFor } from 'town-shared/portraits'
import { installVillagerEditor } from './villagers'
import { warmSelectedGame } from '../startupWarmup'
import { createMusicController } from 'town-shared/audio/music'
import { installPlatform, isCompact, isTouch, onBack, systemBars } from 'town-shared/platform'
import { installSelects } from 'town-shared/design/select'
import { installFavicon, logoUrl } from 'town-shared/brand/brand'
import { installHomeSettings } from './settings'
// 小镇选择页：一句话说清这是什么游戏、小镇列表（写着玩到第几天、住了几个人）、静态预览、进入或继续玩。
// 预览不启动世界。
installPlatform()
installSelects()
systemBars('night')
installFavicon()
query<HTMLImageElement>(document, '.launcher-mark').src = logoUrl
// 手机布局里预览在列表上面
const previewNote = document.querySelector<HTMLElement>('.launcher-preview-note')
const notePreview = () => {
  if (previewNote)
    previewNote.textContent = isCompact()
      ? '上面是选中小镇的预览，可以拖动和缩放。'
      : '选中的小镇显示在右边，可以拖动和缩放。'
}
notePreview()
window.addEventListener('resize', notePreview)

const enter = query<HTMLButtonElement>(document, '#enter-game')
const retry = query<HTMLButtonElement>(document, '#preview-retry')
const scenic = query<HTMLButtonElement>(document, '#preview-scenic')
const launcher = query<HTMLElement>(document, '.map-launcher')
let scenicScrollY = 0
/** 只展开现有静态预览，不连接世界，也不改变存档的时钟或天气。 */
function setScenic(enabled: boolean) {
  if (enabled === launcher.classList.contains('is-scenic')) return
  if (enabled) scenicScrollY = window.scrollY
  launcher.classList.toggle('is-scenic', enabled)
  scenic.setAttribute('aria-pressed', String(enabled))
  scenic.textContent = enabled ? '返回选镇' : '赏景'
  scenic.title = enabled ? '返回选择小镇（Esc）' : '展开地图，欣赏小镇景色'
  window.scrollTo(0, enabled ? 0 : scenicScrollY)
  scenic.focus({ preventScroll: true })
}
scenic.onclick = () => setScenic(!launcher.classList.contains('is-scenic'))
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !launcher.classList.contains('is-scenic')) return
  event.preventDefault()
  setScenic(false)
})
const launcherMusic = createMusicController(
  query<HTMLButtonElement>(document, '#launcher-music-toggle'),
  { fixedTrackId: 'daylife-gathering' }
)
window.addEventListener('pagehide', () => launcherMusic.dispose(), { once: true })
const homeSettings = installHomeSettings({ music: launcherMusic, onAccount: () => void refresh() })
/** 刚建好的小镇：预览出来后先看整张图 */
let fitNext = ''
let selected: MapEntry | undefined,
  request = 0,
  maps: MapEntry[] = []
/** 管理员安排成「在后台一直跑」的那个小镇，以及它此刻的速度与天气 */
let residentId: string | null = null
let residentStatus: ResidentStatus | null = null
let amAdmin = false

type Preview = { host: HTMLElement; map: GameMap }
// 桌面保留最近两张预览，避免来回切换时重新生成地面和 WebGL 场景；触屏设备只保留一张，控制显存。
const previews = new Map<string, Preview>()
let pendingPreview: Preview | undefined
const previewKey = (map: MapEntry) => (map.mapHash ? `${map.id}:${map.mapHash}` : '')
function dropPendingPreview() {
  const pending = pendingPreview
  pendingPreview = undefined
  if (!pending) return
  pending.map.dispose()
  pending.host.remove()
}
function dropPreview(key: string) {
  const preview = previews.get(key)
  if (!preview) return
  previews.delete(key)
  preview.map.dispose()
  preview.host.remove()
}
function showPreview(key: string) {
  for (const [id, preview] of previews) preview.host.hidden = id !== key
  const preview = previews.get(key)
  if (preview) {
    previews.delete(key)
    previews.set(key, preview)
  }
}
function finishPreview(map: MapEntry) {
  $('preview-state').hidden = true
  scenic.disabled = false
  if (fitNext === map.id) {
    fitNext = ''
    $('map-preview')
      .querySelector<HTMLButtonElement>('.map-preview-scene:not([hidden]) .zoom-readout')
      ?.click()
  }
}

function describe(map: MapEntry) {
  document
    .querySelectorAll<HTMLElement>('[data-map-id]')
    .forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.mapId === map.id)))
  const detail = document.querySelector<HTMLElement>('.map-detail')
  if (detail) detail.hidden = false
  $('selected-map-name').textContent = map.name
  $('selected-map-description').textContent = map.description
  $('selection-status').textContent = `已选择 · ${map.name}`
  const played = !!map.progress
  $('pause-status').textContent = played
    ? '接着上次的进度玩。这里只是预览，进去后小镇才接着走。'
    : '这里只是预览，进去后小镇才开始。'
  enter.replaceChildren(played ? '继续玩 ' : '进入游戏 ', arrow())
  updateActions()
  enter.disabled = deleting || !map.available
}

async function select(map: MapEntry) {
  setScenic(false)
  scenic.disabled = true
  actions.open = false
  selected = map
  const current = ++request
  const url = new URL(location.href)
  url.searchParams.set('map', map.id)
  history.replaceState(null, '', url)
  describe(map)
  retry.hidden = true
  dropPendingPreview()
  const key = previewKey(map)
  showPreview(key)
  if (key && previews.has(key)) {
    finishPreview(map)
    warmSelectedGame(map)
    return
  }
  $('preview-state').hidden = false
  $('preview-state').textContent = '正在加载预览…'
  // 先把选中状态画出来再干重活；连点时只建最后一张预览
  await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120)))
  if (current !== request) return
  warmSelectedGame(map)
  try {
    const mapDocument = await loadDocument(map.id, map.mapHash)
    if (current !== request) return
    // 先让加载提示有机会显示，再在主线程计算地面和创建场景。
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (current !== request) return
    const limit = isTouch() ? 1 : 2
    while (previews.size >= limit) dropPreview(previews.keys().next().value!)
    const host = document.createElement('div')
    host.className = 'map-preview-scene'
    $('map-preview').append(host)
    let rendered: GameMap
    try {
      rendered = await createMapRenderer(mapDocument, host)
    } catch (error) {
      host.remove()
      throw error
    }
    if (current !== request) {
      rendered.dispose()
      host.remove()
      return
    }
    const pending = (pendingPreview = { host, map: rendered })
    // 立体场景建好再拿掉「正在加载预览…」：之前只有底色和放大的地名
    await rendered.ready
    if (current !== request) {
      if (pendingPreview === pending) dropPendingPreview()
      return
    }
    pendingPreview = undefined
    // 没有摘要时不能判断内容是否变化，只在本次选中期间保留。
    const cacheKey = key || `${map.id}:request:${current}`
    previews.set(cacheKey, { host, map: rendered })
    finishPreview(map)
  } catch (error) {
    if (current === request) {
      $('preview-state').textContent = errorText(error)
      retry.hidden = false
    }
  }
}

function arrow() {
  const span = document.createElement('span')
  span.setAttribute('aria-hidden', 'true')
  span.textContent = '→'
  return span
}

/** 列表上的小字：玩到第几天、住了几个人；自带的小镇没玩过时写「自带的小镇」 */
function progressText(map: MapEntry) {
  if (!map.available) return '无法打开'
  const p = map.progress
  if (p && p.residents > 0) return `第 ${p.day} 天 · ${p.residents} 位村民`
  if (p) return `第 ${p.day} 天 · 还没有村民`
  return map.origin === 'builtin' ? '自带的小镇 · 还没开始' : '还没开始'
}

function mapOption(map: MapEntry) {
  const b = document.createElement('button')
  b.className = 'map-option'
  b.dataset.mapId = map.id
  b.setAttribute('aria-pressed', 'false')
  b.setAttribute('aria-label', `选择${map.name}`)
  const text = document.createElement('span'),
    name = document.createElement('strong'),
    status = document.createElement('span')
  name.textContent = map.name
  status.className = 'map-option-status'
  status.textContent = progressText(map)
  text.append(name, status)
  b.append(text)
  if (isBuiltinTown(map)) {
    b.classList.add('is-builtin')
    const badge = document.createElement('span')
    badge.className = 'map-option-badge'
    badge.textContent = '内置'
    name.append(badge)
  }
  if (map.resident) {
    const badge = document.createElement('span')
    badge.className = 'map-option-badge is-resident'
    badge.textContent = '后台运行'
    badge.title = '这个小镇在后台一直跑着，别人只能进这里'
    name.append(badge)
  }
  b.onclick = () => {
    if (selected?.id === map.id && selected.mapHash === map.mapHash && retry.hidden) return
    void select(map)
  }
  return b
}

function prefabOption(prefab: Prefab) {
  const b = mapOption({
    id: prefabTownId(prefab),
    name: prefab.name,
    description: prefab.description,
    origin: 'builtin',
    available: true,
  } as MapEntry)
  b.querySelector('.map-option-status')!.textContent = '还没开始'
  b.onclick = () => void buildPrefab(prefab)
  return b
}

// 第一次选中预制小镇：生成岛、存成内置小镇，再像别的小镇一样选中预览；重新开始也走这里
let building = false
async function buildPrefab(prefab: Prefab) {
  if (building) return
  building = true
  const current = ++request
  selected = undefined
  dropPendingPreview()
  showPreview('')
  document
    .querySelectorAll<HTMLElement>('[data-map-id]')
    .forEach((el) =>
      el.setAttribute('aria-pressed', String(el.dataset.mapId === prefabTownId(prefab)))
    )
  const detail = document.querySelector<HTMLElement>('.map-detail')
  if (detail) detail.hidden = false
  $('selected-map-name').textContent = prefab.name
  $('selected-map-description').textContent = prefab.description
  $('pause-status').textContent = ''
  enter.disabled = true
  actions.hidden = true
  retry.hidden = true
  $('preview-state').hidden = false
  $('preview-state').textContent = '正在生成岛…'
  try {
    const id = await generatePrefab(prefab)
    building = false
    if (current !== request) return
    fitNext = id
    await refresh(id)
  } catch (error) {
    building = false
    if (current === request) $('preview-state').textContent = errorText(error)
  }
}

async function refresh(id?: string) {
  try {
    const list = await readTowns()
    maps = list.towns
    residentId = list.resident ?? null
    residentStatus = list.status ?? null
    amAdmin = list.admin === true
    void loadAgents()
    // 还没生成的预制小镇也排在内置小镇里，选中时才生成
    const options = maps.map(mapOption)
    const after = maps.filter(isBuiltinTown).length
    options.splice(after, 0, ...missingPrefabs(maps).map(prefabOption))
    $('map-list').replaceChildren(...options)
    $('map-count').textContent = `${maps.length} 个`
    $('map-empty').hidden = maps.length > 0
    const wanted = id ?? new URLSearchParams(location.search).get('map')
    const initial = maps.find((m) => m.id === wanted)
    const prefab = PREFABS.find((p) => prefabTownId(p) === wanted)
    if (!initial && prefab) await buildPrefab(prefab)
    else if (initial ?? maps[0]) await select(initial ?? maps[0]!)
    return true
  } catch (error) {
    // 这台电脑上还没有账号（第一次打开、或者档案被删了）：先让人在设定里建一个
    if (error instanceof TownApiError && error.code === ACCOUNT_NEEDED) {
      $('selection-status').textContent = '还没有账号'
      $('pause-status').textContent =
        '这台电脑上还没有账号：在「设定 · 账号」里给自己起个名字、设一个密码。'
      homeSettings.openAccounts()
      return false
    }
    $('selection-status').textContent = '小镇列表加载失败'
    $('pause-status').textContent = errorText(error)
    $('pause-retry').hidden = false
    $('pause-retry').textContent = '重新连接'
    return false
  }
}
enter.onclick = async () => {
  if (!selected?.available || deleting) return
  const map = selected
  enter.disabled = true
  $('pause-status').textContent = '正在打开小镇…'
  try {
    // 不再先停住世界：镇上没人看的时候也照常走，进游戏页直接用宿主现在的速度。
    await openMap(map.id)
    if (selected === map) location.assign(gameUrl(map))
  } catch (error) {
    $('pause-status').textContent = errorText(error)
    enter.disabled = false
  }
}
retry.onclick = () => {
  if (selected) void select(selected)
}
$('pause-retry').onclick = () => {
  void refresh()
}
const actions = query<HTMLDetailsElement>(document, '#town-actions')
const close = query<HTMLButtonElement>(document, '#close-town')
const remove = query<HTMLButtonElement>(document, '#delete-town')
const reset = query<HTMLButtonElement>(document, '#reset-town')
const keep = query<HTMLButtonElement>(document, '#keep-town')
const unkeep = query<HTMLButtonElement>(document, '#unkeep-town')
const controls = $('resident-controls')
const residentNote = $('resident-note')
const speedButton = query<HTMLButtonElement>(document, '#resident-speed')
const weatherSelect = query<HTMLSelectElement>(document, '#resident-weather-select')
/** 天气下拉：和世界那边的字面值一一对应（见 protocol 的 WeatherKind） */
const WEATHERS: [string, string][] = [
  ['natural', '自然变化'],
  ['clear', '晴天'],
  ['overcast', '阴天'],
  ['light_rain', '小雨'],
  ['rain', '中雨'],
  ['heavy_rain', '大雨'],
  ['thunderstorm', '雷暴'],
  ['snow', '下雪'],
]
weatherSelect.replaceChildren(...WEATHERS.map(([value, label]) => new Option(label, value)))
/** 控制请求在飞：按钮先按住，免得连点 */
let controlling = false
/** 暂停前跑的是几倍速：点「开始」时回到这个速度 */
let lastSpeed = 1

/** 后台运行的那个小镇：首页显示它的状态和两个开关 */
function renderControls() {
  const on = amAdmin && !!selected?.resident
  controls.hidden = !on
  if (!on) return
  const running = (residentStatus?.speed ?? 0) > 0
  if (running) lastSpeed = residentStatus!.speed
  const ready = residentStatus?.ready ?? false
  residentNote.textContent = !ready
    ? '还没设定世界观：进这个小镇设定一次，回来就能在首页让它跑起来。'
    : running
      ? '这个小镇在后台一直跑着，别人只能进这里。'
      : '这个小镇在后台跑着，这会儿是暂停的。'
  speedButton.textContent = running ? '暂停' : '开始'
  speedButton.disabled = controlling || !ready
  const weather = residentStatus?.weather ?? null
  weatherSelect.value = weather?.mode === 'fixed' ? weather.kind : 'natural'
  weatherSelect.disabled = controlling || !weather
  weatherSelect.title = weather ? '' : '这个小镇没开天气：进镇里的设定打开'
}

// 账号自己养的村民：定义跟着账号走，投进哪个小镇由人点一下（不自动跟着人进镇）。
// 建人用的是镇里那套建村民的界面（捏长相、编人设、一句话让模型生成），首页只摆头像卡。
const agentBox = $('agent-box')
const agentNote = $('agent-note')
const agentList = $('agent-list')
const agentTip = $('agent-tip')
const villagers = installVillagerEditor(
  $('villager-dialog') as HTMLDialogElement,
  $('villager-view')
)
let myAgents: HomeAgent[] = []
/** 这个账号最多能建几个：null 是不限（管理员） */
let agentLimit: number | null = null
/** 头像条上选中了谁：下面那排按钮只对这位生效 */
let agentPicked: string | null = null
let agentBusy = false
/** 这个账号今天用了多少（管理服务是旧版/没问到时是 null） */
let accountUsage: AccountUsage | null = null

/** 数字摆好看些：一万以上按 k 说，不再显示零碎 */
function tokens(count: number) {
  if (count < 1000) return `${count} token`
  const scale = count >= 10_000 ? 0 : 1
  return `${(count / 1000).toFixed(scale)}k token`
}

/** 微元（元 × 1 000 000）→ 钱。少到一分以下就说「不到 ¥0.01」，不写成 ¥0 */
function money(micros: number) {
  if (!micros) return '¥0'
  const yuan = micros / 1_000_000
  return yuan < 0.01 ? '不到 ¥0.01' : `¥${yuan.toFixed(2)}`
}

// 额度弹层：账号自己的每日上限，存下来顺手发给正在跑的小镇
const budgetDialog = $('budget-dialog') as HTMLDialogElement
const budgetCalls = $('budget-calls') as HTMLInputElement
const budgetTokens = $('budget-tokens') as HTMLInputElement
const budgetConcurrent = $('budget-concurrent') as HTMLInputElement
const budgetRate = $('budget-rate') as HTMLInputElement
const budgetTip = $('budget-tip')

function budgetSay(text: string) {
  budgetTip.textContent = text
  budgetTip.hidden = !text
}

function openBudget() {
  const budget = accountUsage?.budget ?? {}
  budgetCalls.value = budget.calls_per_day ? String(budget.calls_per_day) : ''
  budgetTokens.value = budget.tokens_per_day ? String(budget.tokens_per_day) : ''
  budgetConcurrent.value = budget.max_concurrent ? String(budget.max_concurrent) : ''
  budgetRate.value = budget.per_minute ? String(budget.per_minute) : ''
  budgetSay('')
  budgetDialog.showModal()
}

/** 空着 = 回到小镇自己的上限；填了就要大于 0 */
function budgetOf(input: HTMLInputElement) {
  const text = input.value.trim()
  if (!text) return undefined
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0)
    throw new Error('额度要填不小于 1 的整数（不想限就空着）')
  return value
}

/** 并发/速率这类小名额：空着 = 不限，填了就得在世界的范围里 */
function capOf(input: HTMLInputElement, low: number, high: number, label: string) {
  const text = input.value.trim()
  if (!text) return undefined
  const value = Number(text)
  if (!Number.isInteger(value) || value < low || value > high)
    throw new Error(`${label}要填 ${low}–${high} 的整数（不想限就空着）`)
  return value
}

type BudgetBody = {
  calls_per_day?: number
  tokens_per_day?: number
  max_concurrent?: number
  per_minute?: number
}

async function storeBudget(body: BudgetBody) {
  try {
    const reply = await saveBudget(body)
    budgetDialog.close()
    agentSay(
      reply.notes.length ? reply.notes.join('；') : '每日额度存下来了，正在跑的小镇马上就按它算。'
    )
    await loadAgents()
  } catch (error) {
    budgetSay(errorText(error))
  }
}

$('budget-close').addEventListener('click', () => budgetDialog.close())
$('budget-save').addEventListener('click', () => {
  try {
    void storeBudget({
      calls_per_day: budgetOf(budgetCalls),
      tokens_per_day: budgetOf(budgetTokens),
      max_concurrent: capOf(budgetConcurrent, 1, 16, '同时在想几件事'),
      per_minute: capOf(budgetRate, 1, 600, '每分钟最多请求'),
    })
  } catch (error) {
    budgetSay(errorText(error))
  }
})
$('budget-clear').addEventListener('click', () => void storeBudget({}))

const townName = (id: string) => maps.find((map) => map.id === id)?.name ?? id
function agentSay(text: string) {
  agentTip.textContent = text
  agentTip.hidden = false
}

/** 这个账号的 agent 们；老版本管理服务没有这一块，首页就不摆 */
async function loadAgents() {
  const data = await readAgents()
  if (!data) {
    agentBox.hidden = true
    return
  }
  myAgents = data.agents
  agentLimit = data.limit
  if (!myAgents.some((agent) => agent.id === agentPicked)) agentPicked = myAgents[0]?.id ?? null
  agentBox.hidden = false
  accountUsage = await readUsage()
  renderAgents()
}

/** 头像完全在浏览器里画：捏过长相按长相出图，老定义退回到模板编号 */
function agentPortrait(agent: HomeAgent) {
  const look = agent.fields?.appearance.look
  const url = portraitFor(look ? lookKey(look) : agent.template_id)
  const frame = document.createElement('span')
  frame.className = 'agent-face'
  if (url) {
    const img = document.createElement('img')
    img.src = url
    img.alt = `${agent.name}的像素头像`
    frame.append(img)
  } else frame.textContent = agent.name.slice(0, 1)
  return frame
}

/** 选中那位的按钮：投放、收回、改人设、删 */
function renderAgentActions(agent: HomeAgent, here: MapEntry | undefined) {
  const box = document.createElement('div')
  box.className = 'agent-actions'
  const at = here ? agent.deployed.find((place) => place.town === here.id) : undefined
  if (here && !at) {
    const deploy = button('投到这里', () => void deployTo(agent, here), 'agent-deploy')
    deploy.disabled = agentBusy
    deploy.title = `把「${agent.name}」投进「${here.name}」`
    box.append(deploy)
  }
  if (here && at) {
    const recall = button(
      `收回「${here.name}」`,
      () => void recallFrom(agent, at.town),
      'agent-recall'
    )
    recall.disabled = agentBusy || !here.running
    recall.title = here.running
      ? `请「${agent.name}」离开「${here.name}」`
      : '先让这个小镇跑起来，才收得回来'
    box.append(recall)
  }
  // 投在别的小镇的那几份：得正好选中那个镇、并且它跑着才收得回来
  for (const place of agent.deployed) {
    if (place.town === here?.id) continue
    const live = selected?.id === place.town && !!selected.running
    const recall = button(
      `收回「${townName(place.town)}」`,
      () => void recallFrom(agent, place.town),
      'agent-recall'
    )
    recall.disabled = agentBusy || !live
    recall.title = live
      ? `请「${agent.name}」离开「${townName(place.town)}」`
      : '先选中那个小镇、让它跑着，才收得回来'
    box.append(recall)
  }
  const edit = button(
    '编辑',
    () => {
      agentTip.hidden = true
      villagers.open({
        agent,
        townId: here?.id ?? null,
        onSaved: (saved, joinAfter) => {
          agentPicked = saved.id
          // 点的是「保存并加入小镇」：这个人还没在这个镇里，就顺手投进来
          const already = saved.deployed.some((place) => place.town === here?.id)
          if (joinAfter && here && !already) {
            void deployTo(saved, here)
            return
          }
          agentSay(`「${saved.name}」的人设改好了。已经投出去的那位不会跟着变，收回再投才更新。`)
          void loadAgents()
        },
      })
    },
    'agent-edit'
  )
  edit.disabled = agentBusy || !agent.fields
  edit.title = agent.fields ? '改名字、人设、长相' : '这份定义是老版本的：删掉重做一个'
  box.append(edit)
  // 已经住进某个镇的定义删不掉（记录和镇上的人得对得上）：要删先收回来
  if (!agent.deployed.length) {
    const drop = button('删', () => void dropAgent(agent), 'agent-drop')
    drop.disabled = agentBusy
    drop.title = `删掉 agent「${agent.name}」`
    box.append(drop)
  }
  return box
}

function renderAgents() {
  const map = selected
  const here = map?.running ? map : undefined
  const room = agentLimit === null || myAgents.length < agentLimit
  const count =
    agentLimit === null ? '不限个数' : `还能建 ${Math.max(agentLimit - myAgents.length, 0)} 个`
  // 投出去的村民跑起来用的是你自己账号的模型与密钥（管理员那份就是小镇的）
  const billing = amAdmin ? '用的是小镇的模型与密钥' : '用的是你自己的模型与密钥'
  // 今天花了多少钱：逐请求记了模型再按价目表折算；没价的那几次照实说，不写成 0
  const priced = accountUsage?.totals.priced ?? 0
  const unpriced = accountUsage?.totals.unpriced ?? 0
  const spent = priced > 0 ? ` · 约 ${money(accountUsage!.totals.cost_micros)}` : ''
  const noPrice = unpriced > 0 ? `（其中 ${unpriced} 次价目表里没有，钱没算）` : ''
  // 今天花了多少：世界按居民记，管理服务换回这个账号的 agent
  const used = accountUsage
    ? ` · 今天 ${accountUsage.totals.calls} 次 / ${tokens(accountUsage.totals.tokens)}${spent}${noPrice}`
    : ''
  const unknown =
    accountUsage && accountUsage.totals.unmetered > 0
      ? `（其中 ${accountUsage.totals.unmetered} 次服务商没回计量）`
      : ''
  const cap = accountUsage?.budget ?? {}
  const capped = cap.calls_per_day || cap.tokens_per_day
  const quota = capped
    ? ` · 额度 ${cap.calls_per_day ?? '不限'} 次 / ${cap.tokens_per_day ? tokens(cap.tokens_per_day) : '不限'}`
    : ''
  // 账号里多人共用的小名额：同账号投出去的 agent 一起算
  const shared =
    cap.max_concurrent || cap.per_minute
      ? ` · 同时 ${cap.max_concurrent ?? '不限'} 位 / 每分钟 ${cap.per_minute ?? '不限'} 次`
      : ''
  // 跨天账本：今天之外的也算上，换天归零不会把这些丢了
  const week = accountUsage
    ? accountUsage.history.reduce(
        (sum, day) => ({
          calls: sum.calls + day.calls,
          tokens: sum.tokens + day.tokens,
          cost_micros: sum.cost_micros + day.cost_micros,
        }),
        { calls: 0, tokens: 0, cost_micros: 0 }
      )
    : null
  const longer =
    week && week.calls > accountUsage!.totals.calls
      ? ` · 近 7 天 ${week.calls} 次 / ${tokens(week.tokens)}${
          week.cost_micros > 0 ? ` / 约 ${money(week.cost_micros)}` : ''
        }`
      : ''
  agentNote.textContent = `我的 agent · ${count} · ${billing}${used}${unknown}${quota}${shared}${longer}`

  const strip = document.createElement('div')
  strip.className = 'agent-strip'
  for (const agent of myAgents) {
    const tile = button(
      '',
      () => {
        agentPicked = agent.id
        agentTip.hidden = true
        renderAgents()
      },
      'agent-tile'
    )
    tile.classList.toggle('on', agent.id === agentPicked)
    tile.title = agent.fields?.intro || agent.name
    const at = map ? agent.deployed.find((place) => place.town === map.id) : undefined
    const others = agent.deployed
      .filter((place) => place.town !== map?.id)
      .map((place) => `「${townName(place.town)}」`)
    const face = agentPortrait(agent)
    // 右上角小点：在这个镇里挂亮的，投在别处挂暗的
    if (agent.deployed.length) {
      const dot = document.createElement('span')
      dot.className = at ? 'agent-dot' : 'agent-dot elsewhere'
      dot.title = at ? '就在这个小镇里' : `住在${others.join('、')}`
      face.append(dot)
    }
    const name = document.createElement('span')
    name.className = 'agent-tile-name'
    name.textContent = agent.name
    const where = document.createElement('span')
    where.className = 'agent-tile-where'
    where.textContent = at ? '在这个镇里' : others.length ? `在${others.join('、')}` : '还没投出去'
    tile.append(face, name, where)
    strip.append(tile)
  }

  // 末尾那张虚线卡：建一个（走镇里那套建村民的界面）
  const add = button(
    '',
    () => {
      agentTip.hidden = true
      villagers.open({
        townId: here?.id ?? null,
        onSaved: (agent, joinAfter) => {
          agentPicked = agent.id
          // 没有正在跑的小镇时「保存并加入小镇」只存下了定义：说清楚，别让人以为投放了
          if (joinAfter && here) {
            void deployTo(agent, here)
            return
          }
          agentSay(
            joinAfter
              ? `已经建好「${agent.name}」了。先选中一个跑着的小镇，再投放。`
              : `已经建好「${agent.name}」了，存进了我的 agent。`
          )
          void loadAgents()
        },
      })
    },
    'agent-tile agent-add'
  )
  add.disabled = agentBusy || !room
  add.title = room ? '建一个 agent：长相、人设都能捏' : `这个账号最多 ${agentLimit} 个 agent`
  const plus = document.createElement('span')
  plus.className = 'agent-face'
  plus.append(gameIcon('plus', true))
  const addName = document.createElement('span')
  addName.className = 'agent-tile-name'
  addName.textContent = '邀请'
  add.append(plus, addName)
  strip.append(add)

  const picked = myAgents.find((agent) => agent.id === agentPicked)
  // 额度是账号自己的：不跟着选中的 agent 走，所以单独一行
  const wallet = document.createElement('div')
  wallet.className = 'agent-actions'
  const limit = button(
    '每日额度',
    () => {
      agentTip.hidden = true
      openBudget()
    },
    'agent-budget'
  )
  limit.title = '限定这个账号投出去的 agent 每天最多用多少'
  wallet.append(limit)
  agentList.replaceChildren(
    ...(picked ? [strip, renderAgentActions(picked, here), wallet] : [strip, wallet])
  )
}

async function deployTo(agent: HomeAgent, map: MapEntry) {
  if (agentBusy) return
  agentBusy = true
  agentTip.hidden = true
  renderAgents()
  try {
    const result = await deployAgent(map.id, agent.id)
    agentSay(`「${agent.name}」住进「${map.name}」了。`)
    if (result.note) agentSay(result.note)
  } catch (error) {
    agentSay(errorText(error))
  } finally {
    agentBusy = false
    void loadAgents()
  }
}

async function recallFrom(agent: HomeAgent, town: string) {
  if (agentBusy) return
  if (
    !window.confirm(
      `请「${agent.name}」离开「${townName(town)}」？他在这里的经历留在小镇的存档里。`
    )
  )
    return
  agentBusy = true
  agentTip.hidden = true
  renderAgents()
  try {
    await withdrawAgent(town, agent.id)
    agentSay(`「${agent.name}」已经离开「${townName(town)}」了，镇上那份模板空出来了。`)
  } catch (error) {
    agentSay(errorText(error))
  } finally {
    agentBusy = false
    void loadAgents()
  }
}

async function dropAgent(agent: HomeAgent) {
  if (agentBusy) return
  if (!window.confirm(`删掉 agent「${agent.name}」？`)) return
  agentBusy = true
  agentTip.hidden = true
  renderAgents()
  try {
    await deleteAgent(agent.id)
    agentSay(`「${agent.name}」已经删掉了。`)
  } catch (error) {
    agentSay(errorText(error))
  } finally {
    agentBusy = false
    void loadAgents()
  }
}

function updateActions() {
  close.hidden = !selected?.running || !!selected?.resident
  remove.hidden = !selected?.deletable
  reset.hidden = !selected?.id.startsWith('prefab-')
  // 后台运行只给管理员安排：别人看到的是「现在后台跑的是哪个」
  keep.hidden = !amAdmin || !selected || !!selected.resident
  unkeep.hidden = !amAdmin || !selected?.resident
  actions.hidden = close.hidden && remove.hidden && reset.hidden && keep.hidden && unkeep.hidden
  if (actions.hidden) actions.open = false
  renderControls()
  // 换了个小镇：投放按钮与「在哪个镇里」都要跟着重新算
  renderAgents()
}
document.addEventListener('click', (event) => {
  if (event.target instanceof Node && !actions.contains(event.target)) actions.open = false
})
actions.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    actions.open = false
    actions.querySelector('summary')?.focus()
  }
})
close.title = '保存当前进度并关闭小镇，下次进入时继续'
close.onclick = async () => {
  const map = selected
  if (!map?.running || closing) return
  actions.open = false
  closing = true
  ++runningRequest
  close.disabled = true
  try {
    await api(`/${encodeURIComponent(map.id)}/close`, {})
    map.running = false
    if (selected?.id === map.id) {
      selected.running = false
      updateActions()
      $('pause-status').textContent = '进度已保存，小镇已关闭'
    }
  } catch (error) {
    $('pause-status').textContent = errorText(error)
  } finally {
    closing = false
    close.disabled = false
    void syncRunning()
  }
}
// 后台运行：管理员挑一个小镇一直跑着，别人只能进这一个（同时只跑一个世界）
keep.onclick = async () => {
  const map = selected
  if (!map || controlling) return
  actions.open = false
  controlling = true
  $('pause-status').textContent = `正在把「${map.name}」放到后台…`
  try {
    const entry = await keepRunning(map.id, true)
    $('pause-status').textContent =
      entry.ready === false
        ? '已经在后台运行了。这个小镇还没设定世界观：进去设定一次，它就会自己跑起来。'
        : `「${map.name}」在后台一直跑着，别人只能进这里。`
    await refresh(map.id)
  } catch (error) {
    $('pause-status').textContent = errorText(error)
  } finally {
    controlling = false
    renderControls()
    void syncRunning()
  }
}
unkeep.onclick = async () => {
  const map = selected
  if (!map || controlling) return
  actions.open = false
  controlling = true
  try {
    await keepRunning(map.id, false)
    $('pause-status').textContent = '不再让它在后台一直跑了。它还开着的话，照常开着。'
    await refresh(map.id)
  } catch (error) {
    $('pause-status').textContent = errorText(error)
  } finally {
    controlling = false
    renderControls()
    void syncRunning()
  }
}
// 首页控制后台的小镇：暂停／继续
speedButton.onclick = async () => {
  const map = selected
  if (!map?.resident || controlling) return
  const running = (residentStatus?.speed ?? 0) > 0
  const speed = running ? 0 : lastSpeed || 1
  controlling = true
  renderControls()
  try {
    await controlTown(map.id, { kind: 'speed', speed })
    $('pause-status').textContent = running
      ? '已经在后台暂停了。点「开始」接着跑。'
      : `已经在后台跑起来了（${speed} 倍速）。`
  } catch (error) {
    $('pause-status').textContent = errorText(error)
  } finally {
    controlling = false
    void syncRunning()
  }
}
// 首页控制后台的小镇：天气
weatherSelect.onchange = async () => {
  const map = selected
  if (!map?.resident || controlling) return
  const value = weatherSelect.value
  const mode = value === 'natural' ? 'natural' : 'fixed'
  controlling = true
  renderControls()
  try {
    await controlTown(map.id, {
      kind: 'weather',
      mode,
      ...(mode === 'fixed' ? { weather: value } : {}),
    })
    const label = WEATHERS.find(([id]) => id === value)?.[1] ?? value
    $('pause-status').textContent =
      mode === 'natural' ? '天气交还给小镇自己了。' : `天气改成了${label}。`
  } catch (error) {
    $('pause-status').textContent = errorText(error)
  } finally {
    controlling = false
    void syncRunning()
  }
}
// 只更新运行状态，避免轮询重画预览或覆盖操作提示。
let closing = false,
  runningRequest = 0
async function syncRunning() {
  if (document.hidden || closing || deleting) return
  const current = ++runningRequest
  try {
    const latest = await readTowns()
    if (current !== runningRequest || closing || deleting) return
    residentId = latest.resident ?? null
    residentStatus = latest.status ?? null
    amAdmin = latest.admin === true
    for (const map of maps) {
      const town = latest.towns.find((item) => item.id === map.id)
      map.running = town?.running ?? false
      map.resident = town?.resident ?? false
    }
    if (selected) selected.resident = residentId === selected.id
    updateActions()
  } catch {
    if (current === runningRequest) {
      close.hidden = true
      actions.hidden = remove.hidden && reset.hidden && keep.hidden && unkeep.hidden
      if (actions.hidden) actions.open = false
    }
  }
}
window.addEventListener('pageshow', () => {
  void syncRunning()
})
window.addEventListener('focus', () => {
  void syncRunning()
})
document.addEventListener('visibilitychange', () => {
  void syncRunning()
})
window.setInterval(() => {
  void syncRunning()
}, 5000)
let deleting = false
remove.onclick = async () => {
  const map = selected
  if (!map?.deletable || deleting) return
  actions.open = false
  if (
    !window.confirm(
      `删除“${map.name}”？\n\n该小镇的地图、居民、记忆和全部游戏进度将永久删除，无法恢复。正在运行的服务也会关闭。`
    )
  )
    return
  deleting = true
  remove.disabled = true
  enter.disabled = true
  close.disabled = true
  $('pause-status').textContent = '正在关闭服务并删除地图…'
  try {
    await api(`/${encodeURIComponent(map.id)}/delete`, {})
    for (const key of previews.keys()) if (key.startsWith(`${map.id}:`)) dropPreview(key)
    if (selected?.id === map.id) {
      selected = undefined
      ++request
      dropPendingPreview()
      remove.hidden = true
      document.querySelector<HTMLElement>('.map-detail')!.hidden = true
    }
    if (await refresh(selected?.id)) $('pause-status').textContent = `已删除“${map.name}”。`
  } catch (error) {
    $('pause-status').textContent = errorText(error)
  } finally {
    deleting = false
    remove.disabled = false
    close.disabled = false
    enter.disabled = !selected?.available
  }
}
// 预制小镇重新开始：清掉这一局（地图、居民、进度）、重新生成岛，进镇后重新出开局设置
reset.onclick = async () => {
  const map = selected
  const prefab = PREFABS.find((p) => map && prefabTownId(p) === map.id)
  if (!map || !prefab || deleting) return
  actions.open = false
  if (!window.confirm(`重新开始“${map.name}”？\n\n这一局的村民、记忆和进度都会清掉，从头开始。`))
    return
  deleting = true
  enter.disabled = true
  $('pause-status').textContent = '正在清掉这一局…'
  try {
    await api(`/${encodeURIComponent(map.id)}/reset`, {})
    for (const key of previews.keys()) if (key.startsWith(`${map.id}:`)) dropPreview(key)
    deleting = false
    await buildPrefab(prefab)
  } catch (error) {
    $('pause-status').textContent = errorText(error)
    enter.disabled = !selected?.available
  } finally {
    deleting = false
  }
}
// 建镇：电脑版由管理服务生成，手机应用在页面里生成（见 localCreation.ts）
initCreator(
  (id, problem) => {
    // 刚建好的小镇先看整张图，不停在开场的近景；保存后没能进镇时在这里说原因
    fitNext = id
    void refresh(id).then(() => {
      if (problem) $('pause-status').textContent = problem
    })
  },
  () => maps.map((m) => m.name),
  () => homeSettings.connect(),
  // 保存并进镇：打开小镇就直接进游戏页，世界保持宿主当前的速度（不再先停住）
  async (id) => {
    const town = await openMap(id)
    location.assign(gameUrl(town))
  }
)
// 安卓返回键：先收起「更多操作」，其余交给应用壳（再按一次退出）
onBack(() => {
  if (launcher.classList.contains('is-scenic')) {
    setScenic(false)
    return true
  }
  if (!actions.open) return false
  actions.open = false
  return true
})
void refresh()
