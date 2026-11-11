// 账号自己的 agent：定义放在账号目录里、能换小镇复用；投进哪个小镇是一次手动动作，
// 投进去之后那一段记忆只留在那个小镇的存档里。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createManager } from '../town-manager.mjs'

const json = { 'content-type': 'application/json', 'x-town-client': '1' }
/** 请求管理服务：不抛错，把状态码和错误码一起交回来（要断言 409 与 code 用） */
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

test('an account keeps its own agent definitions and drops one into a town by hand', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-agents-'))
  let m
  try {
    m = await createManager({ root, port: 0, mockLlm: true, maxRunning: 1 })
    const base = `http://127.0.0.1:${m.server.address().port}/api/towns`
    const me = await admin(base)
    const api = call(base, me.cookie)
    // 还没建号/没选号：agent 是账号自己的东西，先说清楚
    const nobody = call(base, null)('/agents')
    assert.equal((await nobody).status, 401)
    assert.equal((await nobody).code, 'account')

    // 管理员不限个数；一开始一个也没有
    const empty = await api('/agents')
    assert.equal(empty.status, 200, JSON.stringify(empty))
    assert.deepEqual(empty.agents, [])
    assert.equal(empty.limit, null)

    // 小镇没在运行：拿不到模板，也投不进去
    const noTown = await api('/default-town/templates')
    assert.equal(noTown.status, 409)
    assert.match(noTown.error, /没在运行/)
    const early = await api('/default-town/deploy', { agent_id: 'a0' })
    assert.equal(early.status, 404)
    assert.match(early.error, /没有这个 agent/)

    // 进一次这个小镇，拿到镇上可用的村民模板
    const opened = await api('/default-town/open', {})
    assert.equal(opened.status, 200, JSON.stringify(opened))
    const picked = await api('/default-town/templates')
    assert.equal(picked.status, 200, JSON.stringify(picked))
    assert.ok(picked.templates.length > 0)
    const [first, second] = picked.templates

    // 建一个 agent：名字 + 模板（版本一起记下）
    const made = await api('/agents', {
      name: '阿岚',
      template_id: first.template_id,
      template_version: first.version,
    })
    assert.equal(made.status, 200, JSON.stringify(made))
    const agent = made.agent
    assert.equal(agent.name, '阿岚')
    assert.equal(agent.template_id, first.template_id)
    assert.deepEqual(agent.deployed, [])
    // 同名的不让建（不然镇上两个「阿岚」分不清谁是谁）
    const same = await api('/agents', {
      name: '阿岚',
      template_id: second.template_id,
      template_version: second.version,
    })
    assert.equal(same.status, 400)
    assert.match(same.error, /同名/)

    // 投放：村民真的住进去了，记下镇上给的居民编号
    const closed = await api('/default-town/close', {})
    assert.equal(closed.closed, true)
    const asleep = await api('/default-town/deploy', { agent_id: agent.id })
    assert.equal(asleep.status, 409)
    assert.match(asleep.error, /没在运行/)
    const reopened = await api('/default-town/open', {})
    assert.equal(reopened.status, 200, JSON.stringify(reopened))
    // 全新的小镇还没设定世界观：世界不在这里收人，管理服务先说清楚缺哪一步
    const unready = await api('/default-town/deploy', { agent_id: agent.id })
    assert.equal(unready.status, 409)
    assert.match(unready.error, /还没设定世界观/)
    // 管理员进镇里设定一次（页面上做的事，这里直接对世界发命令）
    const settings = () =>
      m.hosts.query(
        'default-town',
        { type: 'get_world_settings' },
        (msg) => msg.type === 'world_settings'
      )
    const view = await settings()
    await m.hosts.query(
      'default-town',
      {
        type: 'set_worldview',
        request_id: 'agents-view',
        world_id: view.state.world_id,
        expected_revision: view.state.revision,
        text: '一座安静的小镇',
      },
      (msg) => msg.type === 'world_settings_saved' && msg.request_id === 'agents-view' && msg.ok
    )
    const deployed = await api('/default-town/deploy', { agent_id: agent.id })
    assert.equal(deployed.status, 200, JSON.stringify(deployed))
    assert.equal(deployed.agent.deployed.length, 1)
    assert.equal(deployed.agent.deployed[0].town, 'default-town')
    assert.equal(deployed.agent.deployed[0].name, '阿岚')
    assert.ok(deployed.agent.deployed[0].resident)
    // 镇上的名册里确实多了这个人
    const population = await m.hosts.query(
      'default-town',
      { type: 'get_population' },
      (msg) => msg.type === 'population'
    )
    assert.ok(
      population.population.residents.some(
        (person) => person.id === deployed.agent.deployed[0].resident && person.name === '阿岚'
      )
    )

    // 同一个人不再投第二遍
    const again = await api('/default-town/deploy', { agent_id: agent.id })
    assert.equal(again.status, 409)
    assert.match(again.error, /已经在这个镇里了/)
    // 同一个模板已经有人在用了：换个模板，或换个名字也没用——模板只够住一个人
    const other = await api('/agents', {
      name: '阿树',
      template_id: first.template_id,
      template_version: first.version,
    })
    assert.equal(other.status, 200, JSON.stringify(other))
    const stuckTemplate = await api('/default-town/deploy', { agent_id: other.agent.id })
    assert.equal(stuckTemplate.status, 409)
    assert.match(stuckTemplate.error, /模板/)
    // 还在镇里的删不掉（记录和镇上的人得对得上）
    assert.equal((await api('/agents/delete', { id: agent.id })).status, 409)

    // 普通账号：最多一个 agent，也能把这个自己养的村民投进正在运行的小镇
    const madeUser = await api('/users', { name: '朋友', pin: '1357' })
    assert.equal(madeUser.status, 200, JSON.stringify(madeUser))
    const friend = call(base, `town_user=${madeUser.user.id}`)
    assert.equal((await friend('/agents')).limit, 1)
    const one = await friend('/agents', {
      name: '朋友的小人',
      template_id: second.template_id,
      template_version: second.version,
    })
    assert.equal(one.status, 200, JSON.stringify(one))
    const full = await friend('/agents', {
      name: '再来一个',
      template_id: second.template_id,
      template_version: second.version,
    })
    assert.equal(full.status, 403)
    assert.equal(full.code, 'limit')
    const friendDeploy = await friend('/default-town/deploy', { agent_id: one.agent.id })
    assert.equal(friendDeploy.status, 200, JSON.stringify(friendDeploy))
    assert.equal(friendDeploy.agent.deployed[0].town, 'default-town')
    // 他还没填自己的密钥：人照样投进去，但要说清楚「先在镇上等着」
    assert.match(friendDeploy.note ?? '', /还没选好模型和密钥/)
    // 各投各的：管理员的 agent 列表里看不到朋友的
    assert.equal((await api('/agents')).agents.length, 2)

    // 没投出去的那个可以删
    const deleted = await api('/agents/delete', { id: other.agent.id })
    assert.equal(deleted.status, 200, JSON.stringify(deleted))
    assert.equal((await api('/agents')).agents.length, 1)

    // 定义放在这个账号自己的目录下，里面不写别人的东西
    const path0 = path.join(root, 'users', me.current.id, 'agents', `${agent.id}.json`)
    const before = JSON.parse(await fs.readFile(path0, 'utf8'))
    assert.equal(before.name, '阿岚')
    assert.equal(before.deployed['default-town'].resident, deployed.agent.deployed[0].resident)

    // 收回：不在这个镇里的、小镇没在运行的，都说清楚原因
    const third = await api('/agents', {
      name: '阿石',
      template_id: 'tpl_not_in_town',
      template_version: 1,
    })
    assert.equal(third.status, 200, JSON.stringify(third))
    const notThere = await api('/default-town/withdraw', { agent_id: third.agent.id })
    assert.equal(notThere.status, 409)
    assert.match(notThere.error, /不在这个镇里/)
    assert.equal((await api('/default-town/close', {})).closed, true)
    const away = await api('/default-town/withdraw', { agent_id: agent.id })
    assert.equal(away.status, 409)
    assert.match(away.error, /没在运行/)
    await api('/default-town/open', {})

    // 真的收回：镇上没有这个人了，定义里也抹掉了这里的记录
    const back = await api('/default-town/withdraw', { agent_id: agent.id })
    assert.equal(back.status, 200, JSON.stringify(back))
    assert.match(back.message, /离开了小镇/)
    assert.deepEqual(back.agent.deployed, [])
    const left = await m.hosts.query(
      'default-town',
      { type: 'get_population' },
      (msg) => msg.type === 'population'
    )
    assert.ok(
      !left.population.residents.some((person) => person.id === deployed.agent.deployed[0].resident)
    )
    assert.ok(left.population.residents.some((person) => person.name === '朋友的小人'))

    // 朋友把这个账号自己的模型与密钥填上，再投一次：这回用他自己的密钥，不需要提醒
    const friendFile = await m.accountConfig({ id: madeUser.user.id, role: 'user' })
    const friendApp = JSON.parse(await fs.readFile(friendFile, 'utf8'))
    const providers = JSON.parse(await fs.readFile(friendApp.providers_path, 'utf8'))
    providers.active = { provider: 'deepseek', model: 'deepseek-chat' }
    providers.providers = [{ id: 'deepseek', base_url: 'https://api.deepseek.com' }]
    await fs.writeFile(friendApp.providers_path, JSON.stringify(providers))
    await fs.writeFile(friendApp.credentials_path, JSON.stringify({ deepseek: 'sk-friend' }))
    const friendOff = await friend('/default-town/withdraw', { agent_id: one.agent.id })
    assert.equal(friendOff.status, 200, JSON.stringify(friendOff))
    const friendAgain = await friend('/default-town/deploy', { agent_id: one.agent.id })
    assert.equal(friendAgain.status, 200, JSON.stringify(friendAgain))
    assert.equal(friendAgain.note, undefined, JSON.stringify(friendAgain))
    // 不能再收一次
    assert.equal((await api('/default-town/withdraw', { agent_id: agent.id })).status, 409)
    // 收回来之后就能删了
    assert.equal((await api('/agents/delete', { id: agent.id })).status, 200)
    assert.deepEqual(
      (await api('/agents')).agents.map((a) => a.name),
      ['阿石']
    )
  } finally {
    await m?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
