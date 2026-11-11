// 摆道具：地图左下角「摆道具」进入。点地图上的一个地点，点的位置旁边浮出道具列表（手机上从底部升起），
// 点一行就放到点的位置附近；浮窗不关，可以接着放、撤销刚放的那件。浮窗顶上列出这个地点已有的东西，
// 可以顺手移除。摆道具时点地图上已有的道具，弹出小菜单：在它旁边再放东西，或者移除它。
// 道具目录和命令回执都经道具页（page.ts），这里只管界面。
import type { ClientMsg, PlaceGrid } from '../protocol'
import type { GameMap, PlaceSpot } from '../gameMap'
import { gameIcon } from '../game/icons'
import { visibleMapRect } from '../mapView'
import { slot } from '../design/ui'
import { newId } from '../ids'
import { button, el } from './dom'
import { nearestFree, snapToCell } from './grid'
import { propPicture } from './picture'
import { PURPOSES, usesOf } from './worldView'
import type { Definition, PropCatalog, PropView } from './types'
import './placing.css'

export type PlacingMap = Pick<
  GameMap,
  | 'setPlacing'
  | 'placeSpotAt'
  | 'setPlaceHighlight'
  | 'setPlaceMarker'
  | 'setPlaceGrid'
  | 'walkTargetOf'
>

export interface PlacingDeps {
  map: PlacingMap
  catalog(): PropCatalog | null
  localeName(id: string): string
  /** 要一份最新的道具目录 */
  refresh(): void
  /** 问这个地点哪里能放：回执到了调 got；没连上时返回 false */
  grid(locale: string, got: (grid: PlaceGrid | null) => void): boolean
  /** 放置、移除：回执到了调 done；没连上时返回 false */
  command(
    kind: 'place_prop' | 'remove_prop',
    build: (world_id: string, request_id: string) => ClientMsg,
    done: (ok: boolean, message: string) => void
  ): boolean
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string }
  | { kind: 'placed'; id: string; name: string; locale: string }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string }

/** 道具库里每件道具取最新一版；公告要先选公告栏，从「书与公告」贴，不在这里放 */
function choices(c: PropCatalog) {
  const latest = new Map<string, Definition>()
  for (const d of c.definitions) {
    if (d.readable?.kind === 'bulletin') continue
    const old = latest.get(d.id)
    if (!old || d.version > old.version) latest.set(d.id, d)
  }
  return [...latest.values()]
}

const definitionId = (reference: string | null | undefined) => (reference ?? '').split('@')[0]

/** 地点里摆在地图上的东西：撤下的、收进背包和容器的不算 */
function placedIn(c: PropCatalog, locale: string) {
  return c.instances.filter((p) => p.locale === locale && !p.withdrawn && p.on_map !== false)
}

function matches(d: Definition, query: string, purpose: string) {
  if (purpose) {
    const read = purpose === 'read' && (!!d.readable || d.bulletin_board)
    if (!read && !d.actions.some((a) => usesOf(a).includes(purpose))) return false
  }
  return `${d.name} ${d.description} ${d.actions.map((a) => a.label).join(' ')}`
    .toLowerCase()
    .includes(query)
}

export function createPlacing(deps: PlacingDeps) {
  const mapEl = document.getElementById('map')!
  const listeners = new AbortController()
  const { signal } = listeners
  let active = false
  let spot: (PlaceSpot & { client: [number, number] }) | null = null
  let query = ''
  let purpose = ''
  let status: Status = { kind: 'idle' }
  /** 这次摆道具放过的道具（定义编号），最近的在前 */
  let recent: string[] = []
  /** 眼下这个地点的格子：点格子吸附到格心，地图上画出哪儿能放 */
  let grid: { cells: PlaceGrid; space: string } | null = null
  let lastPointer: [number, number] = [0, 0]
  const watchers: ((active: boolean) => void)[] = []

  const hint = el('div', '', 'place-hint')
  hint.setAttribute('role', 'status')
  hint.append(
    el('span', '摆道具：点地图上的地点，白格能放，点格子对准'),
    button('完成', () => setActive(false))
  )
  const follow = el('div', '', 'place-follow')
  const picker = el('section', '', 'place-picker')
  picker.setAttribute('role', 'dialog')
  picker.setAttribute('aria-label', '选要放的道具')
  const menu = el('div', '', 'place-menu')
  menu.setAttribute('role', 'menu')
  for (const node of [hint, follow, picker, menu]) {
    node.hidden = true
    // 和地图上的按钮一样隔开：在浮窗里点、滚不能被地图当成点地面、拖动或缩放
    for (const type of ['pointerdown', 'dblclick', 'wheel'])
      node.addEventListener(type, (event) => event.stopPropagation(), { signal })
  }
  mapEl.append(hint, follow, picker, menu)

  // 浮窗里的固定部件：搜索框重画时不能丢焦点，只换列表、已有物品和底栏
  const title = el('b')
  const here = el('div', '', 'place-here')
  const search = el('input')
  search.type = 'search'
  search.placeholder = '搜索道具或能做的事，比如「喝水」'
  search.autocomplete = 'off'
  search.setAttribute('aria-label', '搜索道具')
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase()
    renderList()
  })
  const segments = el('div', '', 'place-seg')
  segments.setAttribute('role', 'group')
  segments.setAttribute('aria-label', '用途')
  const segButtons = PURPOSES.map((p) => {
    const b = button(p.label, () => {
      purpose = p.value
      for (const [i, s] of segButtons.entries())
        s.setAttribute('aria-pressed', String(PURPOSES[i].value === purpose))
      renderList()
    })
    b.setAttribute('aria-pressed', String(p.value === purpose))
    return b
  })
  segments.append(...segButtons)
  const list = el('div', '', 'place-list')
  const foot = el('div', '', 'place-foot')
  foot.setAttribute('aria-live', 'polite')
  {
    const head = el('header', '', 'place-head')
    const where = el('span', '', 'place-where')
    where.append(el('small', '放到'), title)
    const close = button('', () => closePicker(), 'place-close')
    close.setAttribute('aria-label', '关闭')
    close.append(gameIcon('close', true))
    head.append(where, close)
    const box = el('label', '', 'place-search')
    box.append(gameIcon('search', true), search)
    picker.append(head, here, box, segments, list, foot)
  }

  function setActive(on: boolean) {
    if (on === active) return
    active = on
    deps.map.setPlacing?.(on)
    mapEl.classList.toggle('placing', on)
    hint.hidden = !on
    if (on) {
      recent = []
      deps.refresh()
    } else {
      closePicker()
      closeMenu()
      follow.hidden = true
    }
    for (const watch of watchers) watch(on)
  }

  function openPicker(at: PlaceSpot, client: [number, number]) {
    closeMenu()
    follow.hidden = true
    spot = { ...at, client }
    status = { kind: 'idle' }
    deps.map.setPlaceHighlight?.(at.locale)
    deps.map.setPlaceMarker?.(at.near)
    title.textContent = deps.localeName(at.locale)
    picker.hidden = false
    mapEl.classList.add('place-picking')
    render()
    deps.refresh()
    askGrid(at)
    if (document.documentElement.dataset.layout !== 'compact') search.focus({ preventScroll: true })
  }

  /** 问这个地点的格子；回来时浮窗可能已经关了或者换到别处了，只认同一个地点 */
  function askGrid(at: PlaceSpot) {
    setGrid(null, '')
    const asked = at.locale
    const sent = deps.grid(asked, (next) => {
      if (!next || !spot || spot.locale !== asked) return
      setGrid(next, spot.near.space)
    })
    if (!sent && active) flash('没连上小镇，这一次不显示格子', lastPointer)
  }

  /** 换上格子：画到地图上，顺手把定位点吸到最近的空格心（原来是点的原位置） */
  function setGrid(next: PlaceGrid | null, space: string) {
    if (!next || !space) {
      grid = null
      deps.map.setPlaceGrid?.(null, null)
      return
    }
    grid = { cells: next, space }
    deps.map.setPlaceGrid?.(next, space)
    if (!spot) return
    const snapped = nearestFree(next, spot.near.position)
    if (!snapped) return
    spot = { ...spot, near: { ...spot.near, position: snapped } }
    deps.map.setPlaceMarker?.(spot.near)
  }

  function closePicker() {
    if (!spot) return
    spot = null
    grid = null
    picker.hidden = true
    mapEl.classList.remove('place-picking')
    deps.map.setPlaceHighlight?.(null)
    deps.map.setPlaceMarker?.(null)
    deps.map.setPlaceGrid?.(null, null)
  }

  /** 宽屏贴着点的位置，放不下就翻到左边；不压右侧面板、缩放钮和左下角的按钮。手机上是底部抽屉，交给样式 */
  function position() {
    if (!spot) return
    if (document.documentElement.dataset.layout === 'compact') {
      picker.style.left = picker.style.top = picker.style.maxHeight = ''
      return
    }
    const m = mapEl.getBoundingClientRect()
    const area = visibleMapRect(mapEl)
    picker.style.maxHeight = `${Math.max(240, area.bottom - area.top - 24 - 56)}px`
    const w = picker.offsetWidth,
      h = picker.offsetHeight
    const [x, y] = spot.client
    let left = x + 28
    if (left + w > area.right - 72) left = x - 28 - w
    left = Math.max(area.left + 12, Math.min(left, area.right - w - 72))
    const top = Math.max(area.top + 12, Math.min(y - 60, area.bottom - h - 56))
    picker.style.left = `${left - m.left}px`
    picker.style.top = `${top - m.top}px`
  }

  function render() {
    renderHere()
    renderFoot()
    renderList()
  }

  function renderHere() {
    const c = deps.catalog()
    if (!spot || !c) {
      here.replaceChildren()
      return
    }
    const items = placedIn(c, spot.locale)
    const count = new Map<string, number>()
    for (const p of items)
      count.set(definitionId(p.definition), (count.get(definitionId(p.definition)) ?? 0) + 1)
    here.replaceChildren(
      el('span', items.length ? `这里已有 ${items.length} 件` : '这里还没有东西', 'place-cap')
    )
    for (const p of items) {
      const dup = (count.get(definitionId(p.definition)) ?? 0) > 1
      const chip = el('span', '', dup ? 'place-chip dup' : 'place-chip')
      chip.title = dup ? '这里有好几件一样的' : p.name
      const remove = button('', () => removeProp(p))
      remove.setAttribute('aria-label', `移除 ${p.name}`)
      remove.append(gameIcon('close', true))
      chip.append(el('span', p.name), remove)
      here.append(chip)
    }
  }

  /** 换了搜索词或分类从头看起；目录更新（放下、移除之后）留在原来滚到的地方 */
  function renderList(keepScroll = false) {
    const c = deps.catalog()
    const scroll = keepScroll ? list.scrollTop : 0
    list.replaceChildren()
    if (!spot) return
    if (!c) {
      list.append(el('p', '正在读取道具库…', 'place-empty'))
      return
    }
    const have = new Map<string, number>()
    for (const p of placedIn(c, spot.locale))
      have.set(definitionId(p.definition), (have.get(definitionId(p.definition)) ?? 0) + 1)
    const all = choices(c)
    const found = all.filter((d) => matches(d, query, purpose))
    const groups: [string, Definition[]][] = []
    if (query) groups.push([`找到 ${found.length} 件`, found])
    else if (purpose) groups.push([PURPOSES.find((p) => p.value === purpose)!.label, found])
    else {
      // 书很多，排在最后，不把能用的东西挤到下面去
      const book = (d: Definition) => d.readable?.kind === 'book'
      groups.push(
        ['刚放过', recent.flatMap((id) => all.filter((d) => d.id === id))],
        ['道具', found.filter((d) => !book(d))],
        ['书', found.filter(book)]
      )
    }
    for (const [label, items] of groups) {
      if (!items.length) continue
      list.append(el('p', label, 'place-group'))
      for (const d of items) list.append(row(d, have.get(d.id) ?? 0))
    }
    if (!found.length) list.append(el('p', '没有符合的道具，换个词或分类试试。', 'place-empty'))
    list.scrollTop = scroll
    // 列表变长变短后浮窗的高度跟着变，重新摆一下，别伸到左下角的按钮上
    position()
  }

  function row(d: Definition, count: number) {
    const reference = `${d.id}@${d.version}`
    const item = button('', () => place(d), 'place-row')
    const name = el('span', '', 'place-name')
    name.append(el('span', d.name))
    if (count) name.append(el('span', `已有 ${count}`, 'place-have'))
    const text = el('span', '', 'place-text')
    const uses = d.actions.map((a) => a.label).join('、')
    text.append(name, el('span', uses || d.description || '摆设', 'place-desc'))
    item.title = d.description || d.name
    item.append(
      slot(propPicture(reference, d.readable ? 'book' : 'bag'), 'sm'),
      text,
      el('span', count ? '再放一件' : '放下', count ? 'place-act again' : 'place-act')
    )
    return item
  }

  function renderFoot() {
    foot.replaceChildren()
    foot.classList.toggle('error', status.kind === 'error')
    if (status.kind === 'placed') {
      const ok = el('span', '', 'place-ok')
      ok.append(gameIcon('check', true))
      const text = el('span', `已放到${deps.localeName(status.locale)}：`)
      text.append(el('strong', status.name))
      foot.append(ok, text, button('撤销', undo))
    } else if (status.kind === 'idle') {
      foot.append(el('span', '点一行就放下，浮窗不会关，可以接着放。'))
    } else foot.append(el('span', status.text))
  }

  function setStatus(next: Status) {
    status = next
    renderFoot()
    // 浮窗关着（从菜单里移除，或者回执到时已经关了）：结果写在指针旁边
    if (spot || next.kind === 'idle') return
    flash(
      next.kind === 'placed' ? `已放到${deps.localeName(next.locale)}：${next.name}` : next.text,
      lastPointer
    )
  }

  function place(d: Definition) {
    if (!spot) return
    const { locale, near } = spot
    const id = `user:${newId()}`
    const sent = deps.command(
      'place_prop',
      (world_id, request_id) => ({
        type: 'place_prop',
        request_id,
        world_id,
        instance: { id, definition: `${d.id}@${d.version}`, locale },
        near,
      }),
      (ok, message) => {
        if (!ok) return setStatus({ kind: 'error', text: `没放成：${message}` })
        recent = [d.id, ...recent.filter((r) => r !== d.id)].slice(0, 3)
        setStatus({ kind: 'placed', id, name: d.name, locale })
        renderList(true)
        // 放下之后那附近站不下人了：重新问一次格子，定位点跟着吸到新的空位
        if (spot) askGrid(spot)
      }
    )
    setStatus(
      sent
        ? { kind: 'busy', text: `正在放「${d.name}」…` }
        : { kind: 'error', text: '小镇的连接断了，连上后再放' }
    )
  }

  function undo() {
    if (status.kind !== 'placed') return
    const { id, name } = status
    remove(id, name, `已撤销「${name}」`)
  }

  function removeProp(p: PropView) {
    // 有人正在用：移除会打断他，先问一声
    if (p.occupants.length && !window.confirm(`有人正在用「${p.name}」，移除会打断他。确定移除？`))
      return
    remove(p.id, p.name, `已移除「${p.name}」`)
  }

  function remove(id: string, name: string, done: string) {
    const sent = deps.command(
      'remove_prop',
      (world_id, request_id) => ({ type: 'remove_prop', request_id, world_id, id }),
      (ok, message) =>
        setStatus(
          ok ? { kind: 'note', text: done } : { kind: 'error', text: `没移除成：${message}` }
        )
    )
    setStatus(
      sent
        ? { kind: 'busy', text: `正在移除「${name}」…` }
        : { kind: 'error', text: '小镇的连接断了，连上后再试' }
    )
  }

  /** 摆道具时点了地图上已有的道具：在点的位置弹出小菜单 */
  function openMenu(p: PropView) {
    closeMenu()
    follow.hidden = true
    const near = deps.map.walkTargetOf?.('prop', p.id)
    menu.replaceChildren(
      el('p', p.name, 'place-menu-title'),
      el('p', deps.localeName(p.locale), 'place-menu-sub')
    )
    if (near)
      menu.append(
        button('在这里再放东西', () => {
          closeMenu()
          openPicker({ locale: p.locale, near }, lastPointer)
        })
      )
    menu.append(
      button(
        '移除这个道具',
        () => {
          closeMenu()
          if (spot?.locale !== p.locale) closePicker()
          removeProp(p)
        },
        'danger'
      ),
      button('取消', closeMenu)
    )
    menu.hidden = false
    const m = mapEl.getBoundingClientRect()
    const [x, y] = lastPointer
    const left = Math.min(x - m.left + 8, m.width - menu.offsetWidth - 12)
    const top = Math.min(y - m.top + 8, m.height - menu.offsetHeight - 12)
    menu.style.left = `${Math.max(12, left)}px`
    menu.style.top = `${Math.max(12, top)}px`
  }

  function closeMenu() {
    menu.hidden = true
  }

  let flashTimer = 0
  /** 指针旁边的一句短提示，两秒后收起 */
  function flash(text: string, [x, y]: [number, number]) {
    if (!text) return
    const m = mapEl.getBoundingClientRect()
    follow.textContent = text
    follow.classList.add('flash')
    follow.style.left = `${x - m.left}px`
    follow.style.top = `${y - m.top}px`
    follow.hidden = false
    clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => {
      follow.hidden = true
      follow.classList.remove('flash')
    }, 2000)
  }

  // 指针在地图画面上移动：描出指着的地点，旁边写「放到 X」；浮窗开着时不跟
  let frame = 0
  let pointer: PointerEvent | null = null
  const onMap = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('#map > svg') && !target.closest('[data-prop-id]')
  const propAt = (target: EventTarget | null) =>
    target instanceof Element
      ? target.closest('#map > svg [data-prop-id]')?.getAttribute('data-prop-id')
      : undefined
  mapEl.addEventListener(
    'pointermove',
    (event) => {
      if (!active || spot || !menu.hidden || event.pointerType === 'touch') return
      pointer = event
      frame ||= requestAnimationFrame(() => {
        frame = 0
        const e = pointer
        if (!e || !active || spot || !menu.hidden || follow.classList.contains('flash')) return
        const at = onMap(e.target) ? deps.map.placeSpotAt?.([e.clientX, e.clientY]) : undefined
        deps.map.setPlaceHighlight?.(at?.locale ?? null)
        const prop = deps.catalog()?.instances.find((p) => p.id === propAt(e.target))
        if (!onMap(e.target) && !prop) {
          follow.hidden = true
          return
        }
        const m = mapEl.getBoundingClientRect()
        follow.textContent = prop
          ? `${prop.name}：点它可以移除，或在旁边再放`
          : at
            ? `放到 ${deps.localeName(at.locale)}`
            : '这里放不了东西'
        follow.style.left = `${e.clientX - m.left}px`
        follow.style.top = `${e.clientY - m.top}px`
        follow.hidden = false
      })
    },
    { signal }
  )
  mapEl.addEventListener(
    'pointerleave',
    () => {
      follow.hidden = true
      if (active && !spot) deps.map.setPlaceHighlight?.(null)
    },
    { signal }
  )
  mapEl.addEventListener('pointerdown', (event) => (lastPointer = [event.clientX, event.clientY]), {
    signal,
    capture: true,
  })
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!menu.hidden && !menu.contains(event.target as Node)) closeMenu()
    },
    { signal, capture: true }
  )
  document.addEventListener(
    'keydown',
    (event) => {
      if (!active || event.key !== 'Escape') return
      if (!menu.hidden) closeMenu()
      else if (spot) closePicker()
      else setActive(false)
      event.preventDefault()
      event.stopPropagation()
    },
    { signal, capture: true }
  )
  window.addEventListener('resize', () => position(), { signal })

  return {
    active: () => active,
    toggle: () => setActive(!active),
    exit: () => setActive(false),
    /** 按钮跟着进出摆道具模式 */
    watch(update: (active: boolean) => void) {
      watchers.push(update)
      update(active)
    },
    /** 摆道具时点了空地 */
    clickAt(client: [number, number]) {
      if (!active) return
      const at = deps.map.placeSpotAt?.(client)
      if (!at) {
        closePicker()
        closeMenu()
        flash('这里不在能放东西的地点里', client)
        return
      }
      // 浮窗已经开着、又点回同一个地点：把定位点吸到这格上，不重新开窗、列表也不重画
      if (spot && grid && spot.locale === at.locale) {
        const snapped = snapToCell(grid.cells, at.near.position)
        if (!snapped) {
          flash('这一格放不下，换一格', client)
          return
        }
        spot = { ...spot, near: { ...spot.near, position: snapped } }
        deps.map.setPlaceMarker?.(spot.near)
        return
      }
      openPicker(at, client)
    },
    /** 摆道具时点了已有的道具：弹出菜单；不在摆道具时返回 false，照常打开卡片 */
    propClick(id: string) {
      if (!active) return false
      const p = deps.catalog()?.instances.find((i) => i.id === id)
      if (p) openMenu(p)
      return true
    },
    /** 道具目录更新：已有物品和列表跟着变 */
    refreshed() {
      if (!spot) return
      renderHere()
      renderList(true)
    },
    disconnected() {
      if (status.kind === 'busy') setStatus({ kind: 'error', text: '小镇的连接断了，没收到结果' })
    },
    reset() {
      setActive(false)
    },
    dispose() {
      setActive(false)
      listeners.abort()
      for (const node of [hint, follow, picker, menu]) node.remove()
    },
  }
}
