// QQ 网关的重连策略。线上出过的事：连续部署几次，`/gateway/bot` 被限流
// （`{"message":"接口调用超过频率限制","code":100017}`），旧代码重试 5 次就不再连了，
// 于是机器人永远收不到私聊——网页上看就是「没有一行『就是这位』」，跟没绑一样。
// 这里钉住两件事：限流时一直退避重试，并且不把同一句错每分钟记十遍。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGateway, maskId, sendC2C } from '../qq/gateway.mjs'

const TOKEN = 'https://bots.qq.com/app/getAppAccessToken'
const GATEWAY = 'https://api.sgroup.qq.com/gateway/bot'

const reply = (body, ok = true, status = 200) => ({
  ok,
  status,
  text: async () => JSON.stringify(body),
})

const rateLimited = reply({ message: '接口调用超过频率限制', code: 100017 }, false, 400)

/** 一条假连接：记下收到什么，由测试决定什么时候吐 hello/READY */
class FakeSocket {
  static all = []
  constructor(url) {
    this.url = url
    this.sent = []
    this.listeners = new Map()
    this.closed = false
    FakeSocket.all.push(this)
  }
  addEventListener(name, handler) {
    const list = this.listeners.get(name) ?? []
    list.push(handler)
    this.listeners.set(name, list)
  }
  emit(name, event = {}) {
    for (const handler of this.listeners.get(name) ?? []) handler(event)
  }
  send(text) {
    this.sent.push(JSON.parse(text))
  }
  close() {
    this.closed = true
    this.emit('close')
  }
  /** 网关那侧的正常开场：op10 hello → 客户端 identify */
  hello(interval = 41250) {
    this.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: interval } }) })
  }
  ready(username = '蓝色大肥鱼') {
    this.emit('message', {
      data: JSON.stringify({
        op: 0,
        s: 1,
        t: 'READY',
        d: { session_id: 's1', user: { username } },
      }),
    })
  }
}

/** 等一个条件成立：假 socket 是异步造出来的，直接断言会扑空 */
async function until(check, times = 200) {
  for (let i = 0; i < times; i += 1) {
    if (check()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('等不到要的状态')
}

function harness({ gatewayReply = () => rateLimited, maxAttempts } = {}) {
  FakeSocket.all = []
  const waits = []
  const logs = []
  const ready = []
  let tokenCalls = 0
  let gatewayCalls = 0
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TOKEN)) {
      tokenCalls += 1
      return reply({ access_token: `t${tokenCalls}`, expires_in: 7200 })
    }
    assert.ok(String(url).startsWith(GATEWAY), `不该请求 ${url}`)
    gatewayCalls += 1
    return gatewayReply(gatewayCalls)
  }
  const gateway = createGateway({
    // 长跑的桥就是这么用的：每次重连现换一张票
    getToken: async () => 'fresh',
    WebSocketImpl: FakeSocket,
    onLog: (line) => logs.push(line),
    onReady: (data) => ready.push(data),
    sleep: async (ms) => {
      waits.push(ms)
    },
    ...(maxAttempts ? { maxAttempts } : {}),
  })
  return {
    gateway,
    waits,
    logs,
    ready,
    calls: () => ({ token: tokenCalls, gateway: gatewayCalls }),
  }
}

test('取网关地址被限流：一直按一分钟退避重试，连上为止', async () => {
  const seat = harness({
    gatewayReply: (n) =>
      n <= 7 ? rateLimited : reply({ url: 'wss://gw.test/websocket/', shards: 1 }),
  })
  await seat.gateway.start()
  await until(() => FakeSocket.all.length === 1)

  assert.equal(seat.calls().gateway, 8, '第 8 次才拿到地址')
  assert.equal(seat.waits.length, 7)
  assert.deepEqual(new Set(seat.waits), new Set([60_000]), '限流就等一分钟，不是 1、2、4 秒')
  assert.equal(FakeSocket.all[0].url, 'wss://gw.test/websocket/')
  assert.ok(
    seat.logs.some((line) => line.includes('接口调用超过频率限制') && line.includes('60 秒后再试')),
    seat.logs.join('\n')
  )

  FakeSocket.all[0].hello()
  await until(() => FakeSocket.all[0].sent.length >= 1)
  assert.deepEqual(FakeSocket.all[0].sent[0], {
    op: 2,
    d: { token: 'QQBot fresh', intents: 1 << 25, shard: [0, 1] },
  })

  FakeSocket.all[0].ready()
  assert.equal(seat.ready.length, 1)
  assert.ok(seat.logs.some((line) => line.includes('就绪：蓝色大肥鱼')))
  seat.gateway.stop()
})

test('同一句错不再刷屏：第一次记一句，之后每十次记一句', async () => {
  let done
  const enough = new Promise((resolve) => {
    done = resolve
  })
  const seat = harness({
    gatewayReply: (n) => {
      if (n >= 21) done()
      return rateLimited
    },
  })
  await seat.gateway.start()
  await enough
  seat.gateway.stop()
  const failures = seat.logs.filter((line) => line.includes('连网关失败'))
  assert.equal(failures.length, 3, failures.join('\n'))
  assert.ok(failures[0].includes('第 1 次'))
  assert.ok(failures[1].includes('第 10 次'))
  assert.ok(failures[2].includes('第 20 次'))
  assert.ok(seat.waits.length >= 20, '每次失败都要退避，不能跳过')
  assert.deepEqual(new Set(seat.waits), new Set([60_000]))
})

test('调用方自己限了次数（maxAttempts）就照它停：给测试与脚本留一条短路', async () => {
  const seat = harness({ gatewayReply: () => rateLimited, maxAttempts: 3 })
  await seat.gateway.start()
  await until(() => seat.logs.some((line) => line.includes('放弃')))
  assert.equal(seat.calls().gateway, 3)
  assert.equal(seat.waits.length, 2, '最后一次不再等：直接说放弃')
})

test('发私聊：被动回复带 msg_id 与 msg_seq，不带就是主动消息', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(String(init.body)) })
    return reply({ id: 'm1', timestamp: '2026-11-13T00:00:00Z' })
  }
  await sendC2C({ token: 't', openid: 'ABCD/1234', content: '海边见', msgId: 'msg-9', msgSeq: 2 })
  await sendC2C({ token: 't', openid: 'ABCD1234', content: '在吗' })
  assert.equal(calls[0].url, 'https://api.sgroup.qq.com/v2/users/ABCD%2F1234/messages')
  assert.deepEqual(calls[0].body, {
    content: '海边见',
    msg_type: 0,
    msg_id: 'msg-9',
    msg_seq: 2,
  })
  assert.deepEqual(calls[1].body, { content: '在吗', msg_type: 0 }, '主动消息不带 msg_id')
})

test('日志里只留 openid 尾号：短号整串打掉，别把整串写进文件', async () => {
  assert.equal(maskId('ABCD1234EFGH'), '***34EFGH')
  assert.equal(maskId('OTHER'), '***')
  assert.equal(maskId(''), '***')
})
