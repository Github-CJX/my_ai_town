// QQ 绑定接口：绑定只能落在自己账号下的 agent 上，一位村民只绑一个 QQ，一个 QQ 只替一位村民收信。
// 世界那侧还有一道 owner 校验（`crates/host/src/letters.rs`），这里管的是网页与绑定表这一层。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createManager } from '../town-manager.mjs'

const json = { 'content-type': 'application/json', 'x-town-client': '1' }

/** 请求管理服务：不抛错，把状态码和错误码一起交回来（要断言 400/404/409 与 code 用） */
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

/** 第一次打开先建管理员；之后管理员能再给朋友建账号。 */
async function admin(base) {
  const r = await fetch(`${base}/users/setup`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ name: '镇长', pin: '2468' }),
  })
  const data = await r.json()
  assert.equal(r.status, 200, JSON.stringify(data))
  return r.headers.get('set-cookie').split(';')[0]
}

test('QQ 绑定只认自己账号下的 agent，一位村民和一个号各只绑一个', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-qq-routes-'))
  let m
  try {
    m = await createManager({ root, port: 0, mockLlm: true, maxRunning: 1 })
    const base = `http://127.0.0.1:${m.server.address().port}/api/towns`
    const qq = `http://127.0.0.1:${m.server.address().port}/api/qq`
    const cookie = await admin(base)
    const api = call(base, cookie)
    const mine = call(qq, cookie)

    // 没有账号就没有「我的 agent」，绑定接口先要人
    const nobody = await call(qq, null)('/binding')
    assert.equal(nobody.status, 401)
    assert.equal(nobody.code, 'account')

    // 开镇、设定世界观、把两个 agent 投进去（都是镇长自己的）
    const opened = await api('/default-town/open', {})
    assert.equal(opened.status, 200, JSON.stringify(opened))
    const view = await m.hosts.query(
      'default-town',
      { type: 'get_world_settings' },
      (msg) => msg.type === 'world_settings'
    )
    await m.hosts.query(
      'default-town',
      {
        type: 'set_worldview',
        request_id: 'qq-view',
        world_id: view.state.world_id,
        expected_revision: view.state.revision,
        text: '一座海边的小镇',
      },
      (msg) => msg.type === 'world_settings_saved' && msg.request_id === 'qq-view' && msg.ok
    )
    const first = (await api('/agents', { fields: { name: '大肥鱼', intro: '海边捡回来的' } }))
      .agent
    const second = (await api('/agents', { fields: { name: '海鸥', intro: '常来码头' } })).agent
    const one = (await api('/default-town/deploy', { agent_id: first.id })).agent.deployed[0]
    const two = (await api('/default-town/deploy', { agent_id: second.id })).agent.deployed[0]
    assert.ok(one.resident && two.resident, '两位都该有村民编号')

    // 还没绑：候选是「我投放出去的那些」，绑定表与待认领都是空的（列表按新到旧，这里不假定顺序）
    const empty = await mine('/binding')
    assert.equal(empty.status, 200, JSON.stringify(empty))
    assert.equal(empty.config, path.join(root, 'config', 'qq.json'))
    assert.deepEqual(
      empty.agents
        .map(({ agent, name, town, resident }) => ({ agent, name, town, resident }))
        .sort((a, b) => a.resident.localeCompare(b.resident)),
      [
        { agent: first.id, name: '大肥鱼', town: 'default-town', resident: one.resident },
        { agent: second.id, name: '海鸥', town: 'default-town', resident: two.resident },
      ].sort((a, b) => a.resident.localeCompare(b.resident))
    )
    assert.deepEqual(empty.bindings, [])
    assert.deepEqual(empty.pending, [])

    // 手填的 openid 要像 openid：人常把 QQ 号码填进来，这里挡在写盘之前
    const bad = await mine('/binding', { agent: first.id, openid: '1234' })
    assert.equal(bad.status, 400)
    assert.match(bad.error, /QQ 号看起来不对/)

    // 认领用的短号过期/认过就没了：换不回 openid 就别bind
    const stale = await mine('/binding', { agent: first.id, pending: 'qnonsense' })
    assert.equal(stale.status, 409)
    assert.match(stale.error, /已经认领过/)

    // 绑上了：网页只看到尾号，绑定表里存完整的
    const bound = await mine('/binding', { agent: first.id, openid: 'AbCd1234EfGhJk' })
    assert.equal(bound.status, 200, JSON.stringify(bound))
    assert.equal(bound.bindings.length, 1)
    const [row] = bound.bindings
    assert.equal(row.resident, one.resident)
    assert.equal(row.resident_name, '大肥鱼')
    assert.equal(row.town, 'default-town')
    assert.equal(row.online, false, '测试机没连网关')
    assert.match(row.since, /^\d{4}-\d{2}-\d{2}T/, '绑上的时刻是 ISO 字符串')
    assert.notEqual(row.openid, 'AbCd1234EfGhJk', '网页上不该出现完整 openid')
    assert.ok(row.openid.length > 0)
    const kept = JSON.parse(
      await fs.readFile(path.join(root, 'config', 'qq-bindings.json'), 'utf8')
    )
    assert.equal(kept.bindings[0].openid, 'AbCd1234EfGhJk')
    assert.equal(kept.bindings[0].resident, one.resident)

    // 一个 QQ 只替一位村民收信：换个村民来绑同一个号要拦下
    const taken = await mine('/binding', { agent: second.id, openid: 'AbCd1234EfGhJk' })
    assert.equal(taken.status, 409)
    assert.match(taken.error, /这个 QQ 已经在替「大肥鱼」收信了/)

    // 一位村民也只绑一个号：给「大肥鱼」换号同样是冲突
    const again = await mine('/binding', { agent: first.id, openid: 'ZzYy9988XxWwVv' })
    assert.equal(again.status, 409)
    assert.match(again.error, /「大肥鱼」已经绑了别的 QQ/)

    // 别人的账号：既看不见镇长的绑定，也绑不了镇长的村民
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
    const theirs = await call(qq, friendCookie)('/binding')
    assert.equal(theirs.status, 200, JSON.stringify(theirs))
    assert.deepEqual(theirs.agents, [], '朋友没投放任何人')
    assert.deepEqual(theirs.bindings, [], '别人的绑定不该露出来')
    const stolen = await call(qq, friendCookie)('/binding', {
      agent: first.id,
      openid: 'Friend0000Openid',
    })
    assert.equal(stolen.status, 404, '读别人的 agent 应当当它不存在')
    assert.match(stolen.error, /没有这个 agent/)

    // 解绑：只有投放人能解，解开之后再说一遍就没有可解的了
    const notMine = await call(qq, friendCookie)('/unbind', { agent: first.id })
    assert.equal(notMine.status, 404)
    const off = await mine('/unbind', { agent: first.id })
    assert.equal(off.status, 200, JSON.stringify(off))
    assert.deepEqual(off.bindings, [])
    const nothing = await mine('/unbind', { agent: first.id })
    assert.equal(nothing.status, 404)
    assert.match(nothing.error, /还没绑 QQ/)
  } finally {
    await m?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
