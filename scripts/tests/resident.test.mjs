// 常驻小镇：管理员在首页挑一个一直在后台跑，别人只能进它；管理员还能在首页改它的速度与天气。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createManager } from '../town-manager.mjs'
import { seal } from '../mapgen/document.mjs'
import { root as source } from './support.mjs'

const json = { 'content-type': 'application/json', 'x-town-client': '1' }
/** 请求管理服务：不抛错，把状态码和错误码一起交回来（要断言 403 与 code 用） */
function call(base, cookie) {
  return async (route, body) => {
    const r = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : json) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: r.status, ...(await r.json()) }
  }
}
/** 等一个条件成立（世界要过一拍才把新状态广播出来） */
async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check().catch(() => null)
    if (value) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

/** 第一次打开先建管理员（第一次打开自己建号，见 accounts） */
async function admin(base, name = '管理员', pin = '2468') {
  const r = await fetch(`${base}/users/setup`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ name, pin }),
  })
  const data = await r.json()
  assert.equal(r.status, 200, JSON.stringify(data))
  return { cookie: r.headers.get('set-cookie').split(';')[0], ...data }
}

test('the admin keeps a town running in the background: others can only enter it, and its speed and weather are set from the home page', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-resident-'))
  let m
  try {
    // 隔壁镇：直接放一份地图进去（产品里是页面建镇，这里只关心常驻规则）
    const map = JSON.parse(
      await fs.readFile(path.join(source, 'data/maps/2d-town/map.json'), 'utf8')
    )
    delete map.content_hash
    await fs.mkdir(path.join(root, 'towns/next-town'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'towns/next-town/map.json'),
      JSON.stringify(seal({ ...map, name: '隔壁镇' }))
    )
    m = await createManager({ root, port: 0, mockLlm: true, maxRunning: 1 })
    const base = `http://127.0.0.1:${m.server.address().port}/api/towns`
    const me = await admin(base)
    const api = call(base, me.cookie)
    // 朋友：管理员建的普通账号（没有管理员权限）
    const made = await api('/users', { name: '朋友', pin: '1357' })
    assert.equal(made.status, 200, JSON.stringify(made))
    const login = await fetch(`${base}/users/select`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ id: made.user.id, pin: '1357' }),
    })
    assert.equal(login.status, 200)
    const friend = call(base, login.headers.get('set-cookie').split(';')[0])

    // 一开始没有常驻
    assert.equal((await api('')).resident, null)
    assert.equal((await friend('')).resident, null)

    // 管理员挑 default-town 一直在后台跑
    const on = await api('/default-town/resident', { on: true })
    assert.equal(on.status, 200, JSON.stringify(on))
    assert.equal(on.resident, 'default-town')
    const list = await api('')
    assert.equal(list.resident, 'default-town')
    assert.equal(list.towns.find((town) => town.id === 'default-town').resident, true)
    assert.equal(list.towns.find((town) => town.id === 'default-town').running, true)
    // 全新的小镇还没设定世界观：先停着，等管理员进镇里设定一次（不会假装在跑）
    assert.equal(on.ready, false)
    assert.equal(list.status.ready, false)
    assert.equal(list.status.speed, 0)
    // 没设定好之前，首页的「开始」也推不动：说清楚缺哪一步
    const early = await api('/default-town/control', { kind: 'speed', speed: 1 })
    assert.equal(early.status, 409)
    assert.match(early.error, /还没设定世界观/)

    // 别人只能进常驻的那个：点别的小镇会被挡住，并说明原因
    const blocked = await friend('/next-town/open', {})
    assert.equal(blocked.status, 403)
    assert.equal(blocked.code, 'resident')
    assert.match(blocked.error, /后台运行的是「/)
    // 朋友也不能改常驻、不能控制
    assert.equal((await friend('/next-town/resident', { on: true })).status, 403)
    assert.equal((await friend('/default-town/control', { kind: 'speed', speed: 4 })).status, 403)

    // 管理员自己可以进别的小镇（常驻的那个留在后台，不占同时运行的名额）
    const went = await api('/next-town/open', {})
    assert.equal(went.status, 200, JSON.stringify(went))
    // 朋友关不掉它：常驻的小镇不因为没人看着就停
    const kept = await friend('/default-town/close', {})
    assert.equal(kept.closed, false)
    assert.equal((await api('')).towns.find((town) => town.id === 'default-town').running, true)

    // 管理员进镇里设定一次世界观、打开天气（页面上做的事，这里直接对世界发命令）
    const settings = (id) =>
      m.hosts.query(
        'default-town',
        { type: 'get_world_settings' },
        (msg) => msg.type === 'world_settings'
      )
    const view = await settings()
    const world_id = view.state.world_id
    const savedAs = (requestId) => (msg) =>
      msg.type === 'world_settings_saved' && msg.request_id === requestId && msg.ok
    await m.hosts.query(
      'default-town',
      {
        type: 'set_worldview',
        request_id: 'resident-view',
        world_id,
        expected_revision: view.state.revision,
        text: '一座安静的小镇',
      },
      savedAs('resident-view')
    )
    const climate = await settings()
    await m.hosts.query(
      'default-town',
      {
        type: 'set_physiology',
        request_id: 'resident-climate',
        world_id,
        expected_revision: climate.state.revision,
        switches: { ...climate.state.physiology, weather: true },
      },
      savedAs('resident-climate')
    )
    // 世界观设好、天气打开之后，首页才看得到这些开关
    assert.ok(await until(async () => (await api('')).status?.ready))
    assert.ok(await until(async () => (await api('')).status?.weather))

    // 首页控制：暂停／继续
    const paused = await api('/default-town/control', { kind: 'speed', speed: 0 })
    assert.equal(paused.status, 200, JSON.stringify(paused))
    assert.equal((await api('')).status.speed, 0)
    assert.equal((await api('/default-town/control', { kind: 'speed', speed: 3 })).status, 200)
    assert.equal((await api('')).status.speed, 3)
    assert.equal((await api('/default-town/control', { kind: 'speed', speed: 100 })).status, 400)
    // 首页控制：天气
    const weather = await api('/default-town/control', {
      kind: 'weather',
      mode: 'fixed',
      weather: 'rain',
    })
    assert.equal(weather.status, 200, JSON.stringify(weather))
    assert.equal(weather.weather.kind, 'rain')
    assert.equal((await api('')).status.weather.kind, 'rain')
    assert.equal(
      (await api('/default-town/control', { kind: 'weather', mode: 'fixed', weather: '下雪' }))
        .status,
      400
    )
    // 只有常驻的那个能控制
    assert.equal((await api('/next-town/control', { kind: 'speed', speed: 1 })).status, 403)

    // 取消常驻：世界不因此停下，但之后谁都不能再拿它当挡箭牌
    const off = await api('/default-town/resident', { on: false })
    assert.equal(off.resident, null)
    assert.equal((await api('')).resident, null)
    assert.equal((await api('')).towns.find((town) => town.id === 'default-town').running, true)
    assert.equal((await friend('/next-town/open', {})).status, 200)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'resident.json'), 'utf8')), {
      town: null,
      speed: 3,
    })
  } finally {
    await m?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
