// 桥连世界的那一头：管理进程现算地址、现签票，真世界必须认这张票。
// 这段是「信一封也递不出去」的典型坏法：端口/口令/票任一样错，桥只会安静地重连，
// 页面上看着一切正常。所以这里用真的 `Hosts` + 真的 `host` 验一次。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createManager } from '../town-manager.mjs'
import { createWorldEndpoint } from '../qq/endpoint.mjs'
import { createWorldLink } from '../qq/world.mjs'
import { WebSocket } from '../towns/socket.mjs'

const json = { 'content-type': 'application/json', 'x-town-client': '1' }

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

/** 第一次打开先建管理员，顺手把他的账号编号带回来 */
async function admin(base) {
  const r = await fetch(`${base}/users/setup`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ name: '镇长', pin: '2468' }),
  })
  const data = await r.json()
  assert.equal(r.status, 200, JSON.stringify(data))
  return { cookie: r.headers.get('set-cookie').split(';')[0], id: data.current.id }
}

async function until(check, ms = 5_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw Error('等太久了')
}

test('现算的地址与现签的票能连上真世界，票里认的是这个人', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-qq-world-'))
  let m
  let link
  let socket
  try {
    m = await createManager({ root, port: 0, mockLlm: true, maxRunning: 1 })
    const base = `http://127.0.0.1:${m.server.address().port}/api/towns`
    const me = await admin(base)
    const api = call(base, me.cookie)
    const opened = await api('/default-town/open', {})
    assert.equal(opened.status, 200, JSON.stringify(opened))
    const view = await m.hosts.query(
      'default-town',
      { type: 'get_world_settings' },
      (msg) => msg.type === 'world_settings'
    )
    const worldId = view.state.world_id
    assert.ok(worldId, '世界该有编号')
    // 没设世界观时世界不让人做任何事，先设一句话（和网页第一次打开时一样）
    await m.hosts.query(
      'default-town',
      {
        type: 'set_worldview',
        request_id: 'qq-world-view',
        world_id: worldId,
        expected_revision: view.state.revision,
        text: '一座海边的小镇',
      },
      (msg) => msg.type === 'world_settings_saved' && msg.request_id === 'qq-world-view' && msg.ok
    )

    // 没开的镇问不到地址：桥会按这个 null 稍后再试，而不是拿半截地址去连
    const endpoint = createWorldEndpoint(m.hosts)
    assert.equal(endpoint('no-such-town', me.id), null)

    const url = endpoint('default-town', me.id)
    assert.ok(url, '开着的镇该给得出地址')
    const parsed = new URL(url)
    assert.equal(parsed.protocol, 'ws:')
    assert.equal(parsed.searchParams.get('session'), m.hosts.worldSecret('default-town'))
    assert.ok(parsed.searchParams.get('ticket'), '地址里要有票')

    // 用桥自己的连接器连（也用它自己的重连/配对逻辑）
    link = createWorldLink({ endpoint: () => endpoint('default-town', me.id), retryMs: 200 })
    await link.connect()
    await until(() => link.connected)
    assert.equal(await link.worldId(), worldId)

    // 递给自己投放的村民：这条路是桥真正在用的（QQ 里一句话 → 世界里的信）。
    // 但世界先要「这个人」站在镇上：账号本身不够，还得以化身进过一次镇。
    const agent = (await api('/agents', { fields: { name: '大肥鱼', intro: '海边捡回来的' } }))
      .agent
    const placed = (await api('/default-town/deploy', { agent_id: agent.id })).agent.deployed[0]
    assert.ok(placed.resident, '该有村民编号')
    const before = await link
      .sendLetter({ to: placed.resident, text: '海边见' })
      .catch((error) => ({ ok: false, message: error.message }))
    assert.equal(before.ok, false)
    assert.match(String(before.message), /还没有你的化身/)

    // 和页面一样：拿同一张票进镇，用「老陈」这个名字站进去
    socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = () => reject(Error('连不上世界'))
    })
    const entered = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('进镇没有回音')), 5_000)
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.type !== 'avatar_result' || message.request_id !== 'enter') return
        clearTimeout(timer)
        resolve(message)
      }
      socket.send(
        JSON.stringify({
          type: 'avatar',
          world_id: worldId,
          request_id: 'enter',
          epoch: '',
          sequence: 1,
          command: {
            kind: 'enter',
            name: '老陈',
            appearance: { marker: '我', color: '#387963' },
          },
        })
      )
    })
    assert.equal(entered.ok, true, JSON.stringify(entered))

    // 票里认的是这个账号：朋友投放的村民递不进去（跨账号错投是桥最怕的静默错）
    const friend = (await api('/users', { name: '朋友', pin: '1357' })).user
    const friendCookie = await (async () => {
      const r = await fetch(`${base}/users/select`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ id: friend.id, pin: '1357' }),
      })
      assert.equal(r.status, 200)
      return r.headers.get('set-cookie').split(';')[0]
    })()
    const theirs = call(base, friendCookie)
    const theirAgent = (await theirs('/agents', { fields: { name: '小海', intro: '码头上的' } }))
      .agent
    const theirResident = (await theirs('/default-town/deploy', { agent_id: theirAgent.id })).agent
      .deployed[0]
    const stranger = await link
      .sendLetter({ to: theirResident.resident, text: '在吗' })
      .catch((error) => ({ ok: false, message: error.message }))
    assert.equal(stranger.ok, false)
    assert.match(String(stranger.message), /只有投放这位村民的账号/)

    const sent = await link
      .sendLetter({ to: placed.resident, text: '海边见' })
      .catch((error) => ({ ok: false, message: error.message }))
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.match(String(sent.message), /大肥鱼/)

    // 读信这头：自己发出去的也在流水里（`incoming === false`），桥只转发 true 的那些。
    // 游标是「这本账读到第几条」，不是全局流水号。
    const read = await link.letters({ after: 0 })
    assert.deepEqual(
      read.letters.filter((letter) => letter.incoming),
      [],
      '自己写的信不是「新到的信」'
    )
    assert.equal(read.letters.at(-1).text, '海边见')
    assert.ok(read.cursor >= 1, '读到过东西，游标就该往前走')
    // 关键的一条：老陈关了页面（化身那条连接断掉）之后，桥还得能替他递信——
    // QQ 消息来的时候他人多半不在电脑前。世界按「账号名下的化身」认人，不按连着的标签页。
    socket.close()
    socket = null
    await new Promise((resolve) => setTimeout(resolve, 200))
    const afterClosed = await link
      .sendLetter({ to: placed.resident, text: '我下了班再来' })
      .catch((error) => ({ ok: false, message: error.message }))
    assert.equal(afterClosed.ok, true, JSON.stringify(afterClosed))
  } finally {
    socket?.close()
    link?.stop()
    await m?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
