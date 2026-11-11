import { createAssetRoutes } from './towns/asset-routes.mjs'
import {
  Accounts,
  accountNeeded,
  cookieId,
  createAccountRoutes,
  publicUser,
} from './towns/accounts.mjs'
import { createCreation } from './towns/creation.mjs'
import { createModelRoutes } from './towns/models.mjs'
import { createBuiltinModelRoutes } from './towns/builtin-model.mjs'
import { createTownRoutes, applySpeed, observe, sendOwnerKeys } from './towns/town-routes.mjs'
import { createResident, readResident } from './towns/resident.mjs'
import { foldTowns } from './towns/usage.mjs'
import { Raw, HttpError, readBody, describe } from './towns/http.mjs'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Storage, readJson, atomicJson, dataRoot, setupConfig } from './towns/storage.mjs'
import { Hosts } from './towns/hosts.mjs'
const source = fileURLToPath(new URL('../', import.meta.url))
/** 只给本机的地址：不对外监听，页面与接口只认它们 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** 请求的 Host 里那台主机：去掉端口，IPv6 去掉方括号 */
function hostName(host = '') {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end) : host
  }
  return host.split(':')[0]
}

/**
 * 这个请求的 Host 能不能用：缺省只认本机；对外监听时再认 IP、监听地址和允许的域名。
 * 只认 IP 与显式允许的名字，是为了不让别人的域名解析到这台机器上就能用接口（DNS 重绑定）；
 * 反向代理转进来的请求另外认：`x-forwarded-*` 这些头页面上的脚本改不了，所以凭它们认反代。
 */
function hostAllowed(host, bind, allowHost, headers = {}) {
  const name = hostName(host)
  if (LOOPBACK.has(name)) return true
  if (headers['x-forwarded-proto'] || headers['x-forwarded-host'] || headers['x-forwarded-for'])
    return true
  if (LOOPBACK.has(bind)) return false
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
    name.includes(':') ||
    name === bind ||
    name === allowHost
  )
}

// 一个数据目录只允许一个管理服务；上一个进程已退出时接管它留下的锁。
async function acquireLock(root) {
  const lock = path.join(root, 'manager.lock')
  try {
    await fs.mkdir(lock)
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    let stale = false
    try {
      const old = await readJson(path.join(lock, 'owner.json'))
      try {
        process.kill(old.pid, 0)
      } catch (e2) {
        if (e2.code === 'ESRCH') stale = true
      }
    } catch {}
    if (!stale) throw Error('此数据目录已有小镇管理服务，请先关闭该服务')
    await fs.rm(lock, { recursive: true })
    await fs.mkdir(lock)
  }
  await atomicJson(path.join(lock, 'owner.json'), { pid: process.pid, source })
  return () => fs.rm(lock, { recursive: true, force: true })
}

// mockLlm：所有 host 用固定回复模型启动，供测试使用。
export async function createManager({
  root = dataRoot(),
  configPath,
  port = Number(process.env.TOWN_MANAGER_PORT ?? 8788),
  mockLlm = false,
  maxRunning,
  // 管理服务启动后自己拉起上次在玩的小镇；页面关掉、重启管理服务都不等于停世界。
  alwaysOn = false,
  // 监听地址：缺省只听本机；放到服务器上时传 0.0.0.0（或 TOWN_BIND）；域名访问再加 allowHost。
  bind = process.env.TOWN_BIND?.trim() || '127.0.0.1',
  allowHost = process.env.TOWN_ALLOW_HOST?.trim() || null,
  // 世界自己的端口：0 是每次随机。页面的世界连接现在统一从本服务这个端口转进去（`/ws/<镇>`），
  // 对外只要开管理服务这一个端口；想直连世界进程（老办法）再固定它。
  hostPort = Number(process.env.TOWN_HOST_PORT ?? 0) || 0,
} = {}) {
  const storage = new Storage(root, source)
  await storage.init()
  const releaseLock = await acquireLock(root)
  const config = configPath ?? (await setupConfig(root, source)),
    hosts = new Hosts(source, storage, config, { mockLlm, maxRunning, bind, hostPort })
  // 这台电脑上的账号：第一次打开由玩家自己建的管理员 + 管理员给朋友建的普通账号，各自一份密钥
  const accounts = await new Accounts(root).load()
  // 常驻小镇：管理员在首页挑一个一直跑，别人只能进它；页面关掉、重启管理服务都不等于停世界
  const resident = createResident(root, await readResident(root))
  hosts.setResident(resident.town())
  /** 这次请求是谁；还没建号/没选号时为 undefined */
  const who = (headers) => accounts.current(cookieId(headers))
  const current = (headers) => {
    const me = who(headers)
    return me ? publicUser(me) : null
  }
  /** 这次请求该用哪份应用配置：管理员用小镇公共那份，普通账号用自己目录下那份 */
  const configOf = async (headers) => {
    const me = who(headers)
    if (!me) throw accountNeeded()
    return accounts.config(config, me)
  }
  const [library, contours, definitions] = await Promise.all(
    [
      'data/mapgen/templates.json',
      'data/mapgen/contours.json',
      'data/props/core/definitions.json',
    ].map((p) => readJson(path.join(source, p)))
  )
  const queues = new Map()
  let stopping = false
  const active = new Set()
  // 同一把钥匙下的操作串行执行。
  const serial = (key, fn) => {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    queues.set(key, next)
    return next.finally(() => {
      if (queues.get(key) === next) queues.delete(key)
    })
  }
  const assets = createAssetRoutes({ source, storage }),
    creation = createCreation({
      source,
      root,
      configOf,
      storage,
      library,
      contours,
      definitions,
      serial,
    })
  const builtinModel = createBuiltinModelRoutes({ source, configOf })
  const routes = [
    ...createAccountRoutes({ accounts, storage }),
    ...createModelRoutes({ source, configOf, serial }),
    ...builtinModel.routes,
    ...creation.routes,
    ...assets.routes,
    ...createTownRoutes({
      source,
      root,
      storage,
      hosts,
      serial,
      configOf,
      current,
      resident,
      accounts,
      accountConfig: (user) => accounts.config(config, user),
    }),
  ]
  async function dispatch(req, signal) {
    if (stopping) throw new HttpError(503, '应用正在退出')
    if (!hostAllowed(req.headers.host ?? '', bind, allowHost, req.headers))
      throw new HttpError(403, '仅提供本机服务')
    const url = new URL(req.url, 'http://127.0.0.1'),
      route = url.pathname.replace(/\/$/, '')
    const found = routes.find(([method, pattern]) => method === req.method && pattern.test(route))
    if (!found) throw new HttpError(404, '操作不存在')
    const [, pattern, handler] = found
    const params = route.match(pattern).slice(1)
    const body = req.method === 'POST' ? await readBody(req) : {}
    return handler({ url, params, body, signal, headers: req.headers })
  }
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController()
    active.add(controller)
    res.on('close', () => {
      active.delete(controller)
      if (!res.writableEnded) controller.abort()
    })
    const send = (code, headers, body) => {
      if (res.destroyed) return
      res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', ...headers })
      res.end(body)
    }
    const json = (code, value) =>
      send(
        code,
        { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        JSON.stringify(value)
      )
    try {
      const value = await dispatch(req, controller.signal)
      if (value instanceof Raw) send(value.status, value.headers, value.body)
      else json(200, value)
    } catch (e) {
      const [code, payload] = describe(e)
      if (code >= 500) console.error('[town-manager]', e)
      json(code, payload)
    }
  })
  server.requestTimeout = 120000
  // 页面连世界也走这一个端口：`/ws/<镇>` 原样转给世界进程，反代只要转发本服务这一个端口。
  // 端口只按「正在运行的镇」查，不让请求自己指定去哪。
  server.on('upgrade', (req, socket) => {
    const refuse = (code, phrase, message) => {
      const body = Buffer.from(message, 'utf8')
      socket.write(
        `HTTP/1.1 ${code} ${phrase}\r\ncontent-type: text/plain; charset=utf-8\r\n` +
          `content-length: ${body.length}\r\nconnection: close\r\n\r\n` +
          body.toString('utf8')
      )
      socket.destroy()
    }
    if (!hostAllowed(req.headers.host ?? '', bind, allowHost, req.headers))
      return refuse(403, 'Forbidden', '仅提供本机服务')
    const url = req.url ?? '/'
    const cut = url.indexOf('?')
    const id = /^\/ws\/([a-z0-9-]+)\/?$/.exec(cut < 0 ? url : url.slice(0, cut))?.[1]
    const port = id ? hosts.worldPort(id) : null
    if (!port) return refuse(404, 'Not Found', '这个小镇没在运行')
    const query = cut < 0 ? '' : url.slice(cut + 1)
    const upstream = net.connect(port, '127.0.0.1', () => {
      // 世界只认查询串里的 session/ticket，路径换回 `/`；其余头（含 Upgrade）照原样带过去
      const lines = [`${req.method} /?${query} HTTP/1.1`]
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined)
          lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, bind, resolve)
    })
  } catch (e) {
    await releaseLock()
    throw e
  }
  console.log(`[town-manager] http://${bind}:${server.address().port} · ${root}`)
  if (!LOOPBACK.has(bind))
    console.log(
      `[town-manager] 已对外开放：别的机器用这台机器的 IP:${server.address().port} 访问（HTTP 明文；` +
        '公网建议套 TLS 反向代理，只转这一个端口就够，WebSocket 也走它）'
    )
  /** 常驻小镇用管理员那份密钥跑；别人进镇时用自己那份，世界一旦跑起来沿用先打开的那份 */
  const residentConfig = async () => {
    const admin = accounts.admin()
    return admin ? accounts.config(config, admin) : null
  }
  /** 常驻小镇没在跑就拉起来：页面都关了、host 崩了都拉回来；连续失败就先慢慢重试 */
  let residentFailures = 0
  const ensureResident = async () => {
    const id = resident.town()
    if (!id || stopping || hosts.isRunning(id)) return
    try {
      const config = await residentConfig()
      if (!config) return
      await serial('town-' + id, () => hosts.open(id, config))
      residentFailures = 0
      // 世界是新的，内存里没有密钥：把这个镇里已投放的 agent 再送一遍
      await sendOwnerKeys(
        { root, hosts, accounts, accountConfig: (user) => accounts.config(config, user) },
        id
      ).catch(() => {})
      // 世界观没设好的小镇先停着：这时候发速度会被世界推回来（「请先设置世界观」）
      const state = await observe(hosts, id)
      if (state?.ready) await applySpeed(hosts, id, resident.speed()).catch(() => {})
      console.log(`[town-manager] 常驻小镇已启动：${id}`)
    } catch (e) {
      residentFailures += 1
      if (residentFailures === 1 || residentFailures % 10 === 0)
        console.error(`[town-manager] 常驻小镇没能拉起来：${e.message}`)
    }
  }
  if (alwaysOn) {
    // 第一次打开：替管理员挑一个（上次在玩的、或者第一个），之后由他在首页自己换
    if (!resident.town()) {
      try {
        const towns = (await storage.list()).filter((town) => town.available),
          wanted = process.env.TOWN_ALWAYS_ON_TOWN,
          chosen =
            towns.find((town) => town.id === wanted) ??
            towns
              .filter((town) => town.progress)
              .sort(
                (a, b) =>
                  b.progress.day - a.progress.day || b.progress.residents - a.progress.residents
              )[0] ??
            towns[0]
        if (chosen) {
          await resident.set(chosen.id)
          hosts.setResident(chosen.id)
        }
      } catch (e) {
        console.error('[town-manager] 挑常驻小镇失败：', e.message)
      }
    }
    await ensureResident()
  }
  // 每 15 秒看一眼：常驻小镇死了就拉回来（管理员取消常驻之后它自然什么都不做）；
  // 顺手把各账号的跨天账本折一次，人不在首页也不会把昨天丢掉
  const foldLedgers = async () => {
    for (const user of accounts.list()) {
      await foldTowns({ root, userId: user.id, hosts }).catch(() => {})
    }
  }
  const heartbeat = setInterval(() => {
    void ensureResident()
    void foldLedgers()
  }, 15000)
  heartbeat.unref()
  async function stop() {
    if (stopping) return
    stopping = true
    clearInterval(heartbeat)
    for (const c of active) c.abort()
    builtinModel.stop()
    try {
      await hosts.stop()
    } finally {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
      await releaseLock()
    }
  }
  return {
    server,
    storage,
    hosts,
    accounts,
    accountConfig: (user) => accounts.config(config, user),
    stop,
  }
}

// 未捕获的错误：记录后退出；process 'exit' 处理器会结束所有 host。
export function exitOnCrash() {
  for (const event of ['uncaughtException', 'unhandledRejection'])
    process.on(event, (e) => {
      console.error(`[town-manager] ${event}:`, e)
      process.exit(1)
    })
}
// 第一次 Ctrl+C 正常关闭并等待各世界保存；第二次直接退出。
export function stopOnSignal(stop) {
  let asked = false
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (asked) process.exit(130)
      asked = true
      stop().catch((e) => {
        console.error(e.message)
        process.exitCode = 1
      })
    })
}
if (process.argv[1] && (await fs.realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  exitOnCrash()
  const manager = await createManager({
    mockLlm: process.env.TOWN_MOCK_LLM === '1',
    alwaysOn: process.env.TOWN_ALWAYS_ON !== '0',
  })
  stopOnSignal(() => manager.stop())
}
