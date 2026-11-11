import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson } from './storage.mjs'
/** 同时只运行一个小镇：退出就保存关闭，进另一个小镇时先关掉还开着的那个 */
const MAX_RUNNING = 1
/** 只给本机的地址：不对外监听，页面与接口只认它们 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const START_TIMEOUT_MS = 20000
const CLOSE_TIMEOUT_MS = 15000
export function worldQuery(endpoint, command, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint)
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ws.close()
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => finish(Error('世界服务没有及时回应')), timeout)
    ws.onopen = () => {
      if (command) ws.send(JSON.stringify(command))
    }
    ws.onerror = () => finish(Error('无法连接世界服务'))
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data)
        if (predicate(m)) finish(null, m)
      } catch {
        finish(Error('世界返回无效数据'))
      }
    }
    ws.onclose = () => {
      if (!done) finish(Error('世界连接已断开'))
    }
  })
}
const alive = (child) => child.exitCode === null && child.signalCode === null
// Windows 的 kill('SIGTERM') 会强制结束；关闭 stdin 才会让 host 保存后退出。
function terminate(child) {
  if (process.platform === 'win32') child.stdin.end()
  else child.kill('SIGTERM')
}
export class Hosts {
  // mockLlm：host 用固定回复模型启动，供测试使用；maxRunning：同时运行的小镇上限；
  // bind：管理服务的监听地址——只在本机用时世界听 127.0.0.1，放到服务器上时听 0.0.0.0；
  // hostPort：世界自己的端口，0 是每次随机（放到服务器上时固定一个，防火墙只开这一个）。
  constructor(
    source,
    storage,
    config,
    { mockLlm = false, maxRunning = MAX_RUNNING, bind = '127.0.0.1', hostPort = 0 } = {}
  ) {
    this.source = source
    this.storage = storage
    this.config = config
    this.mockLlm = mockLlm
    this.maxRunning = maxRunning
    this.hostBind = LOOPBACK.has(bind) ? '127.0.0.1' : '0.0.0.0'
    this.hostPort = hostPort
    this.running = new Map()
    this.opening = new Map()
    this.closing = new Map()
    this.stopping = false
    // 常驻小镇：占自己一个位置，不算进同时运行的上限，也不会被别的小镇挤掉
    this.resident = null
    // 管理进程无论怎样退出，都不留下孤儿 host。
    this.onExit = () => {
      for (const r of this.running.values()) if (alive(r.child)) terminate(r.child)
    }
    process.on('exit', this.onExit)
  }
  /** 管理员设的常驻小镇（null 表示没有）；它不被挤掉、也不占上限 */
  setResident(id) {
    this.resident = id ?? null
  }
  isRunning(id) {
    const record = this.running.get(id)
    return Boolean(record && alive(record.child))
  }
  /** 同时运行的小镇已经跑满（正在启动的也算；常驻的那一个不算） */
  full() {
    const live = [...this.running]
      .filter(([id, r]) => id !== this.resident && alive(r.child) && !r.closing)
      .map(([id]) => id)
    return (
      new Set([...live, ...this.opening.keys()].filter((id) => id !== this.resident)).size >=
      this.maxRunning
    )
  }
  /** 除了 except 之外最久没人进过的运行中小镇（常驻小镇不参与挤占） */
  leastRecent(except) {
    let oldest
    for (const [id, r] of this.running)
      if (
        id !== except &&
        id !== this.resident &&
        alive(r.child) &&
        !r.closing &&
        (!oldest || r.used < oldest.used)
      )
        oldest = { id, used: r.used }
    return oldest?.id
  }
  /** 打开小镇：config 是开它的那个账号的应用配置（在跑的世界沿用先打开时那份） */
  async open(id, config = this.config) {
    if (this.stopping) throw Error('应用正在退出')
    if (this.closing.has(id)) await this.closing.get(id).catch(() => {})
    if (this.opening.has(id)) return this.opening.get(id)
    const pending = this.start(id, config).finally(() => this.opening.delete(id))
    this.opening.set(id, pending)
    return pending
  }
  async start(id, config = this.config) {
    const doc = await this.storage.map(id)
    let record = this.running.get(id)
    if (record && !record.closing && alive(record.child)) {
      record.used = Date.now()
      record.lease = randomUUID()
      await this.verify(record, id, doc)
      return this.info(record, id, doc)
    }
    if (
      new Set([...this.running.keys(), ...this.opening.keys()].filter((id) => id !== this.resident))
        .size > this.maxRunning
    )
      throw Error(`同时运行的小镇已达 ${this.maxRunning} 个，请关闭其他小镇`)
    const dir = this.storage.town(id),
      ready = path.join(dir, 'host-ready.json'),
      token = randomUUID()
    await fs.rm(ready, { force: true })
    const log = await fs.open(path.join(dir, 'host.log'), 'a')
    const child = spawn(
      process.env.TOWN_HOST_BINARY ?? path.join(this.source, 'target/debug/host'),
      [
        '--map-document',
        path.join(dir, 'map.json'),
        '--town-id',
        id,
        '--port',
        String(this.hostPort),
        '--speed',
        '0',
        '--save-file',
        path.join(dir, 'world.json'),
        '--ready-file',
        ready,
        '--connection-token',
        token,
        '--stop-on-stdin-close',
        // 只有本机用时世界听 127.0.0.1；放到服务器上要跟着听 0.0.0.0，别的机器才连得上
        '--bind',
        this.hostBind,
        ...(this.mockLlm ? ['--mock-llm', '--mock-delay', '0.01'] : []),
      ],
      {
        cwd: this.source,
        windowsHide: true,
        env: {
          ...process.env,
          AI_TOWN_CONFIG: config,
          AI_TOWN_LOG_DIR: path.join(dir, 'logs'),
        },
        // stdin 只握着不写：本进程无论怎样退出（含 SIGKILL），管道关闭，host 读到 EOF 后保存并退出。
        stdio: ['pipe', log.fd, log.fd],
      }
    )
    child.stdin.on('error', () => {})
    await log.close()
    record = { child, token, closing: false, used: Date.now(), lease: randomUUID() }
    this.running.set(id, record)
    let spawnError
    child.once('error', (e) => {
      spawnError = e
      if (this.running.get(id) === record) this.running.delete(id)
    })
    child.once('exit', () => {
      if (this.running.get(id) === record) this.running.delete(id)
    })
    const deadline = Date.now() + START_TIMEOUT_MS
    try {
      while (Date.now() < deadline) {
        if (spawnError || !alive(child)) throw Error('世界启动失败，请查看该小镇的 host.log')
        try {
          const result = await readJson(ready)
          if (
            result.pid === child.pid &&
            result.identity.town_id === id &&
            result.identity.map_hash === doc.content_hash
          ) {
            record.port = result.port
            record.endpoint = `ws://127.0.0.1:${record.port}/?session=${token}`
            await this.verify(record, id, doc)
            return await this.info(record, id, doc)
          }
        } catch (e) {
          if (e.code !== 'ENOENT') throw e
        }
        await new Promise((r) => setTimeout(r, 80))
      }
      throw Error('世界启动超时')
    } catch (e) {
      terminate(child)
      throw e
    }
  }
  async verify(r, id, doc) {
    const identity = await worldQuery(r.endpoint, null, (m) => m.type === 'world_identity')
    if (identity.town_id !== id || identity.map_hash !== doc.content_hash)
      throw Error('世界与地图身份不一致')
  }
  async info(r, id, doc) {
    const msg = await worldQuery(
      r.endpoint,
      { type: 'get_world_settings' },
      (m) => m.type === 'world_settings'
    )
    const { name, description, creation } = await this.storage.labels(id, doc)
    return {
      id,
      name,
      description,
      creation,
      version: '1',
      clientKind: 'town-2d',
      views: ['2d'],
      available: true,
      mapHash: doc.content_hash,
      worldId: msg.state.world_id,
      endpoint: r.endpoint,
      lease: r.lease,
    }
  }
  /** 向正在运行的世界发一条命令、等它回执：首页的「开始／暂停／天气」走这里 */
  query(id, command, predicate, timeout = 5000) {
    const record = this.running.get(id)
    if (!record || !alive(record.child) || !record.endpoint) throw Error('这个小镇没在运行')
    record.used = Date.now()
    return worldQuery(record.endpoint, command, predicate, timeout)
  }
  /** 这次打开的凭证还是不是最新的：每次打开都换一个，关闭时拿它核对 */
  holds(id, lease) {
    const record = this.running.get(id)
    return Boolean(record && record.lease === lease)
  }
  close(id) {
    if (this.closing.has(id)) return this.closing.get(id)
    const pending = this.finishClose(id).finally(() => this.closing.delete(id))
    this.closing.set(id, pending)
    return pending
  }
  // 先让 host 保存后退出；超时则 SIGKILL 并抛错，让调用方知道保存可能不完整。
  async finishClose(id) {
    if (this.opening.has(id)) await this.opening.get(id).catch(() => {})
    const r = this.running.get(id)
    if (!r) return
    r.closing = true
    const exited = new Promise((resolve) => {
      if (!alive(r.child)) resolve(true)
      else r.child.once('exit', () => resolve(true))
    })
    terminate(r.child)
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS)
    })
    const saved = await Promise.race([exited, timeout])
    clearTimeout(timer)
    if (saved) return
    r.child.kill('SIGKILL')
    await exited
    if (this.running.get(id) === r) this.running.delete(id)
    throw Error(`世界在 ${CLOSE_TIMEOUT_MS / 1000} 秒内没有完成保存，已强制结束`)
  }
  async stop() {
    this.stopping = true
    await Promise.allSettled([...this.opening.values()])
    const results = await Promise.allSettled([...this.running.keys()].map((id) => this.close(id)))
    process.off('exit', this.onExit)
    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length) throw Error(failed.map((r) => r.reason.message).join('；'))
  }
}
