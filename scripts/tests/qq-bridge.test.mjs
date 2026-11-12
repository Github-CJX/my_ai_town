// QQ 桥的两块纯逻辑：绑定表（一对一、游标）与私聊边界（60 分钟窗口、同一条最多 4 句）。
// 桥本体在 scripts/qq/bridge.mjs：这里起一个假的网关与假的世界，验「私聊变成传讯、她的信变成私聊」。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  bind,
  findByOpenid,
  findByResident,
  parseBindings,
  readBindings,
  saveBindings,
  setCursor,
  unbind,
} from '../qq/bindings.mjs'
import {
  createReplyTrack,
  letterContent,
  letterNotice,
  MAX_REPLIES,
  PASSIVE_MS,
} from '../qq/letters.mjs'
import { createBridge } from '../qq/bridge.mjs'

const entry = (over = {}) => ({
  openid: 'A1B2C3',
  account: 'u-alice',
  town: 'default-town',
  resident: 'resident_005',
  resident_name: '大肥鱼',
  ...over,
})

test('绑定表：一个 QQ 只代表一位村民，一位村民也只接一个 QQ', () => {
  const one = bind(parseBindings(null), entry(), { now: () => new Date('2026-11-13T00:00:00Z') })
  assert.equal(one.bindings.length, 1)
  assert.equal(findByOpenid(one, 'A1B2C3').resident_name, '大肥鱼')
  assert.equal(findByResident(one, 'resident_005').account, 'u-alice')
  // 同一个 QQ 换人：拒绝
  assert.throws(
    () => bind(one, entry({ resident: 'resident_006', resident_name: '小满' })),
    /已经在替「大肥鱼」收信/
  )
  // 同一位村民换 QQ：也拒绝
  assert.throws(() => bind(one, entry({ openid: 'ZZZ' })), /已经绑了别的 QQ/)
})

test('绑定表：同一个人重绑只留一条，游标取大的（别把没读过的信又读一遍）', () => {
  const first = bind(parseBindings(null), { ...entry(), cursor: 12 })
  const again = bind(first, { ...entry(), cursor: 3, resident_name: '大肥鱼' })
  assert.equal(again.bindings.length, 1)
  assert.equal(again.bindings[0].cursor, 12)
  const moved = setCursor(again, 'A1B2C3', 20)
  assert.equal(findByOpenid(moved, 'A1B2C3').cursor, 20)
  // 游标只增不减
  assert.equal(findByOpenid(setCursor(moved, 'A1B2C3', 4), 'A1B2C3').cursor, 20)
})

test('绑定表：解绑按 QQ 号或村民编号都行，缺字段要说清楚', () => {
  const one = bind(parseBindings(null), entry())
  assert.equal(unbind(one, { openid: 'A1B2C3' }).bindings.length, 0)
  assert.equal(unbind(one, { resident: 'resident_005' }).bindings.length, 0)
  assert.equal(unbind(one, { openid: 'nobody' }).bindings.length, 1)
  assert.throws(() => bind(parseBindings(null), entry({ account: '' })), /要写清楚 account/)
})

test('绑定表：没绑过读成空的，写过之后原样读回来', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qq-bindings-'))
  const file = path.join(root, 'qq-bindings.json')
  try {
    assert.deepEqual((await readBindings(file)).bindings, [])
    await saveBindings(file, bind(parseBindings(null), { ...entry(), cursor: 7 }))
    const back = await readBindings(file)
    assert.equal(back.bindings.length, 1)
    assert.equal(back.bindings[0].cursor, 7)
    assert.equal(back.bindings[0].resident, 'resident_005')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('私聊正文：剥掉 at 前缀、规整换行、按字数截到 400', () => {
  assert.equal(
    letterContent('<@!1234> 今天钓到鱼了吗\r\n\r\n\r\n还有酒吗'),
    '今天钓到鱼了吗\n\n还有酒吗'
  )
  assert.equal(letterContent('   '), '')
  assert.equal(letterContent(undefined), '')
  const long = '鱼'.repeat(500)
  assert.equal([...letterContent(long)].length, 400)
})

test('她写的信变成一句私聊', () => {
  assert.equal(
    letterNotice({ name: '大肥鱼', text: '钓到了，给你留了一条' }),
    '「大肥鱼」传讯给你：钓到了，给你留了一条'
  )
  assert.equal(letterNotice({ name: '', text: '在' }), '「镇里有人」传讯给你：在')
})

test('被动回复：同一条最多 4 句，超过 60 分钟就不回了', () => {
  let clock = 1_000_000
  const track = createReplyTrack({ now: () => clock })
  assert.equal(track.next(), null) // 还没收到话，没得回
  track.note('m1', clock)
  for (let i = 1; i <= MAX_REPLIES; i += 1)
    assert.deepEqual(track.next(), { msgId: 'm1', msgSeq: i, at: clock })
  assert.equal(track.next(), null)
  assert.equal(track.left(), 0)
  // 同一条重复投递不会把额度洗回来
  track.note('m1', clock)
  assert.equal(track.next(), null)
  // 新的一句话重新给 4 句
  track.note('m2', clock)
  assert.deepEqual(track.next(), { msgId: 'm2', msgSeq: 1, at: clock })
  // 窗口过了就只能走主动消息
  clock += PASSIVE_MS + 1
  assert.equal(track.next(), null)
  assert.equal(track.left(), 0)
})

/** 一座只够桥用的假世界：记下收到的信，按需回一批给她主人的信。 */
function fakeWorld({ connected = true } = {}) {
  const sent = []
  let inbox = []
  return {
    sent,
    push: (letter) => inbox.push(letter),
    link: {
      connected,
      connect() {},
      stop() {},
      async sendLetter({ to, text }) {
        sent.push({ to, text })
        return { ok: true, message: '信递到「大肥鱼」手上了', letter: { to_name: '大肥鱼' } }
      },
      async letters({ after }) {
        const letters = inbox.filter((letter) => letter.event_id > after)
        inbox = inbox.filter((letter) => letter.event_id > after)
        return { letters, cursor: letters.length ? letters[letters.length - 1].event_id : after }
      },
    },
  }
}

test('桥：主人一句话变成一封传讯，她回的信变成主人的私聊', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qq-bridge-'))
  const world = fakeWorld()
  const said = []
  let gatewaySpec = null
  try {
    await mkdir(path.join(root, 'config'), { recursive: true })
    await writeFile(
      path.join(root, 'config', 'qq.json'),
      JSON.stringify({ app_id: '1', app_secret: 's' })
    )
    await saveBindings(
      path.join(root, 'config', 'qq-bindings.json'),
      bind(parseBindings(null), entry())
    )
    const bridge = createBridge({
      root,
      endpointFor: () => 'ws://127.0.0.1:1/?session=x&ticket=y',
      log: () => {},
      send: async (message) => said.push(message),
      tokenFactory: async () => ({ token: 't', expiresAt: Date.now() + 3600_000 }),
      gatewayFactory: (spec) => {
        gatewaySpec = spec
        return { start() {}, stop() {} }
      },
      worldLinkFactory: () => world.link,
      pollMs: 5,
      mergeMs: 0, // 这几条测的是「一句话怎么走」，不掺合并的等待
    })
    await bridge.start()
    // 主人发来一句话：桥把它递给镇里那位村民，并回一句「收到了」
    await gatewaySpec.onEvent({
      name: 'C2C_MESSAGE_CREATE',
      data: { id: 'msg-1', content: '在吗', author: { user_openid: 'A1B2C3' } },
    })
    await settle()
    assert.deepEqual(world.sent, [{ to: 'resident_005', text: '在吗' }])
    assert.equal(said.length, 1)
    assert.match(said[0].content, /信递到/)
    assert.equal(said[0].msgId, 'msg-1')
    assert.equal(said[0].msgSeq, 1)
    // 她回了一句：桥把它送给主人的 QQ，并把游标记下来
    world.push({ event_id: 9, incoming: true, from_name: '大肥鱼', text: '在的，鱼刚钓上来' })
    await settle(20)
    const last = said[said.length - 1]
    assert.equal(last.openid, 'A1B2C3')
    assert.match(last.content, /大肥鱼.*鱼刚钓上来/)
    assert.equal(bridge.status().bindings[0].cursor, 9)
    bridge.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('桥：没绑村民的号码不理，世界没连上就回一句实话', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qq-bridge-'))
  const world = fakeWorld({ connected: false })
  const said = []
  let gatewaySpec = null
  try {
    await mkdir(path.join(root, 'config'), { recursive: true })
    await writeFile(
      path.join(root, 'config', 'qq.json'),
      JSON.stringify({ app_id: '1', app_secret: 's' })
    )
    await saveBindings(
      path.join(root, 'config', 'qq-bindings.json'),
      bind(parseBindings(null), entry())
    )
    const bridge = createBridge({
      root,
      endpointFor: () => null,
      log: () => {},
      send: async (message) => said.push(message),
      tokenFactory: async () => ({ token: 't', expiresAt: Date.now() + 3600_000 }),
      gatewayFactory: (spec) => {
        gatewaySpec = spec
        return { start() {}, stop() {} }
      },
      worldLinkFactory: () => world.link,
      pollMs: 5,
      mergeMs: 0, // 这几条测的是「一句话怎么走」，不掺合并的等待
    })
    await bridge.start()
    await gatewaySpec.onEvent({
      name: 'C2C_MESSAGE_CREATE',
      data: { id: 'msg-2', content: '在吗', author: { user_openid: 'OTHER' } },
    })
    await settle()
    assert.equal(said.length, 0) // 陌生号码不回：回一句就等于替主人认了人
    // 但留下一行待认领：网页上只看到尾号，完整 openid 只在内存里按 token 换
    const pending = bridge.claims()
    assert.equal(pending.length, 1)
    assert.ok(pending[0].masked)
    assert.notEqual(pending[0].masked, 'OTHER') // 网页上永远看不到完整 openid
    assert.equal(pending[0].token, bridge.claims()[0].token) // 同一个号码两次消息只留一行
    assert.equal(bridge.openidOf(pending[0].token), 'OTHER')
    assert.equal(bridge.openidOf('nonsense'), '')
    bridge.forget(pending[0].token)
    assert.equal(bridge.claims().length, 0)
    await gatewaySpec.onEvent({
      name: 'C2C_MESSAGE_CREATE',
      data: { id: 'msg-3', content: '在吗', author: { user_openid: 'A1B2C3' } },
    })
    await settle()
    assert.equal(said.length, 1)
    assert.match(said[0].content, /没连上/)
    bridge.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function settle(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('桥：连着敲的几句合成一封信，只回一句「到手了」', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qq-bridge-'))
  const world = fakeWorld()
  const said = []
  let gatewaySpec = null
  try {
    await mkdir(path.join(root, 'config'), { recursive: true })
    await writeFile(
      path.join(root, 'config', 'qq.json'),
      JSON.stringify({ app_id: '1', app_secret: 's' })
    )
    await saveBindings(
      path.join(root, 'config', 'qq-bindings.json'),
      bind(parseBindings(null), entry())
    )
    const bridge = createBridge({
      root,
      endpointFor: () => 'ws://127.0.0.1:1/?session=x&ticket=y',
      log: () => {},
      send: async (message) => said.push(message),
      tokenFactory: async () => ({ token: 't', expiresAt: Date.now() + 3600_000 }),
      gatewayFactory: (spec) => {
        gatewaySpec = spec
        return { start() {}, stop() {} }
      },
      worldLinkFactory: () => world.link,
      pollMs: 5,
      mergeMs: 30,
    })
    await bridge.start()
    // 三句话前后脚到：镇里只该收到一封信，内容按顺序连起来
    for (const [id, content] of [
      ['m-1', '在吗'],
      ['m-2', '今天镇上'],
      ['m-3', '下雨了吗'],
    ])
      await gatewaySpec.onEvent({
        name: 'C2C_MESSAGE_CREATE',
        data: { id, content, author: { user_openid: 'A1B2C3' } },
      })
    assert.equal(world.sent.length, 0) // 还在攒，没到时间不外发
    await settle(80)
    assert.deepEqual(world.sent, [{ to: 'resident_005', text: '在吗\n今天镇上\n下雨了吗' }])
    assert.equal(said.length, 1) // 三句话只回一句
    assert.equal(said[0].msgId, 'm-3') // 用的是最后一句的 msg_id（被动窗口按它算）
    bridge.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
