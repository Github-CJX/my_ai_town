import 'town-shared/style.css'
import './style.css'
import type { MapEntry } from 'town-shared/mapDocument'
import type { GameMap } from 'town-shared/gameMap'
import { $, query } from 'town-shared/dom'
import { errorText } from 'town-shared/format'
import { loadDocument } from '../assets'
import { createMapRenderer } from '../mapRenderers'
import { gameUrl, openMap, readTowns } from './catalog'
import { initCreator } from './creator'
import { PREFABS, type Prefab } from 'town-shared/prefabs/index'
import { generatePrefab, isBuiltinTown, missingPrefabs, prefabTownId } from './prefabEntry'
import { api, TownApiError } from './api'
import { ACCOUNT_NEEDED, controlTown, keepRunning, type ResidentStatus } from 'town-shared/townApi'
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
