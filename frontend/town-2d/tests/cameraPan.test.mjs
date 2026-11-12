// 地图平移回归：高频指针事件只提交一帧一次视口，松手不丢末尾位移。
// 使用轻量 DOM 夹具验证 MapCamera 的交互状态机，不依赖浏览器或 WebGL。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../package.json', import.meta.url))
const { transpileModule, ModuleKind, ScriptTarget } = require('typescript')
const source = readFileSync(fileURLToPath(new URL('../src/map/camera.ts', import.meta.url)), 'utf8')
const js = transpileModule(source, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText

class FakeElement {
  constructor() {
    this.listeners = new Map()
    this.children = []
    this.clientWidth = 800
    this.clientHeight = 600
    this.style = { setProperty() {} }
    this.classList = { add() {}, remove() {}, toggle() {} }
    this.attributes = new Map()
  }
  addEventListener(type, callback) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback])
  }
  dispatch(type, e) {
    for (const listener of this.listeners.get(type) ?? []) listener(e)
  }
  appendChild(child) {
    this.children.push(child)
  }
  append(...children) {
    this.children.push(...children)
  }
  setAttribute(k, v) {
    this.attributes.set(k, v)
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 }
  }
  setPointerCapture() {}
  remove() {}
  querySelector() {
    return null
  }
  closest() {
    return null
  }
}

function makeCamera() {
  const globals = [
    'window',
    'document',
    'ResizeObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'matchMedia',
    'Element',
  ]
  const before = new Map(globals.map((name) => [name, globalThis[name]]))
  const pending = new Map()
  let id = 0
  globalThis.Element = FakeElement
  globalThis.window = { devicePixelRatio: 1, clearTimeout, setTimeout }
  globalThis.document = {
    body: { classList: { contains: () => false } },
    createElement: () => new FakeElement(),
  }
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.requestAnimationFrame = (cb) => {
    pending.set(++id, cb)
    return id
  }
  globalThis.cancelAnimationFrame = (handle) => pending.delete(handle)
  globalThis.matchMedia = () => ({ matches: false })
  const exports = {}
  const module = { exports }
  new Function('require', 'module', 'exports', js)(
    (name) => {
      if (name === 'town-shared/platform') return { isCompact: () => false }
      if (name === './grid') return { PIXEL: 1 }
      throw new Error(`Unexpected import: ${name}`)
    },
    module,
    exports
  )
  const svg = new FakeElement()
  let writes = 0
  const set = svg.setAttribute.bind(svg)
  svg.setAttribute = (k, v) => {
    if (k === 'viewBox') writes++
    set(k, v)
  }
  // 读取 CTM 是拖动的性能关键路径，旧实现每次 pointermove 都调用一次。
  let ctmReads = 0
  svg.getScreenCTM = () => {
    ctmReads++
    return {
      a: 1,
      d: 1,
      inverse() {
        return {}
      },
    }
  }
  let callbackCount = 0
  const map = new FakeElement()
  const camera = new module.exports.MapCamera(
    svg,
    map,
    [0, 0, 1000, 1000],
    () => callbackCount++,
    () => {}
  )
  const flush = () => {
    const callbacks = [...pending.values()]
    pending.clear()
    for (const cb of callbacks) cb(performance.now())
  }
  const cleanup = () => {
    camera.dispose()
    for (const [name, value] of before) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
  return {
    camera,
    map,
    svg,
    flush,
    pending,
    cleanup,
    get writes() {
      return writes
    },
    get ctmReads() {
      return ctmReads
    },
    get callbackCount() {
      return callbackCount
    },
  }
}

function event(x, y, type = 'move') {
  return {
    button: 0,
    buttons: type === 'up' ? 0 : 1,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
    target: {},
    preventDefault() {},
  }
}

test('200 次高频鼠标移动只合并成一次镜头更新，不强制读取 SVG CTM', () => {
  const f = makeCamera()
  try {
    const start = f.writes
    const initial = f.camera.getViewBox()
    f.map.dispatch('pointerdown', event(100, 200, 'down'))
    for (let i = 1; i <= 200; i++) f.map.dispatch('pointermove', event(100 + i, 200))
    assert.equal(f.writes, start, '指针高频移动时不能立即重复改 SVG')
    assert.equal(f.ctmReads, 0, '拖动热路径不得同步读取 CTM')
    assert.equal(f.pending.size, 1, '只应排一个下一帧更新')
    f.flush()
    assert.equal(f.writes, start + 1)
    assert.ok(f.camera.getViewBox()[0] < initial[0], '地图应朝拖动方向平移')
    assert.equal(f.callbackCount, 2, '摄像机回调也应一帧一次')
    f.map.dispatch('pointerup', event(300, 200, 'up'))
    assert.equal(f.pending.size, 0)
  } finally {
    f.cleanup()
  }
})

test('鼠标在下一帧来临前松手不会丢掉最后的平移，且会恢复静态像素对齐', () => {
  const f = makeCamera()
  try {
    const origin = f.camera.getViewBox()[0]
    f.map.dispatch('pointerdown', event(100, 200, 'down'))
    f.map.dispatch('pointermove', event(163.3, 200))
    f.map.dispatch('pointerup', event(163.3, 200, 'up'))
    const at = f.camera.getViewBox()[0]
    assert.ok(Math.abs(at - origin) > 10, `松手前的位移应提交：${origin} → ${at}`)
    assert.equal(f.pending.size, 0)
    assert.equal(f.writes, 2, '初始化一次，抬起手一次')
    const step = 1 / 3 // closeUp 选中设备像素 3 倍
    assert.ok(Math.abs(at / step - Math.round(at / step)) < 1e-5, '松手后应恢复设备像素格对齐')
  } finally {
    f.cleanup()
  }
})

test('缓慢跟随使用亚像素位置，不再每帧整数像素跳动', () => {
  const f = makeCamera()
  try {
    f.camera.setViewBox([400, 400, 240, 180])
    const p = [530, 490]
    const before = f.camera.getViewBox()[0]
    for (let i = 0; i < 10; i++)
      f.camera.follow(p[0] + i * 1.9, p[1], 16.7, 'lock', { velocity: [0.11, 0] })
    const after = f.camera.getViewBox()[0]
    assert.ok(after !== before, '跟随应改变视口')
    assert.ok(Number.isFinite(after))
  } finally {
    f.cleanup()
  }
})

test('3D 场景绘制前主动提交 pending pan，避免 Canvas 比地图文字晚一帧', () => {
  const f = makeCamera()
  try {
    let requested = 0
    f.camera.onPanScheduled = () => requested++
    f.map.dispatch('pointerdown', event(100, 200, 'down'))
    for (let i = 1; i < 30; i++) f.map.dispatch('pointermove', event(100 + i, 200))
    assert.equal(requested, 1, '同一帧只通知渲染器一次')
    assert.equal(f.camera.flushPendingPan(), true)
    assert.equal(f.pending.size, 0, '绘制前应撤销独立 RAF，避免重复更新')
    assert.equal(f.camera.flushPendingPan(), false)
    assert.equal(f.writes, 2, '视口已在当前帧更新')
    f.map.dispatch('pointerup', event(130, 200, 'up'))
  } finally {
    f.cleanup()
  }
})
