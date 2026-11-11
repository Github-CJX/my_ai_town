// 小镇列表、地图、开关世界、删除与道具摆放。同一个小镇的写操作按小镇串行。
import { HttpError } from './http.mjs'
import { safeId } from './storage.mjs'
import { positions } from './positions.mjs'

/** 天气可以选的那几种（与 protocol 的 WeatherKind 一致） */
const WEATHER = ['clear', 'overcast', 'light_rain', 'rain', 'heavy_rain', 'thunderstorm', 'snow']

/** 让正在运行的世界按这个速度走（0 是暂停）：刚拉起来、管理员在首页改过速度之后都走这一下 */
export async function applySpeed(hosts, id, speed) {
  if (!hosts.isRunning(id)) return
  await hosts.query(
    id,
    { type: 'set_speed', request_id: `resident-${id}`, speed },
    (m) => m.type === 'roster' && Math.abs(m.speed - speed) < 1e-9
  )
}

/** 看一眼正在运行的世界：选定的速度、此刻的天气、世界观设好没有（首页的控制按钮据此显示） */
export async function observe(hosts, id) {
  if (!hosts.isRunning(id)) return null
  try {
    const [roster, settings] = await Promise.all([
      hosts.query(id, null, (m) => m.type === 'roster'),
      hosts.query(id, { type: 'get_world_settings' }, (m) => m.type === 'world_settings'),
    ])
    return {
      speed: typeof roster.speed === 'number' ? roster.speed : null,
      weather: roster.environment
        ? { mode: roster.environment.mode, kind: roster.environment.kind }
        : null,
      ready: Boolean(settings.state?.ready),
      climate: Boolean(settings.state?.physiology?.weather),
    }
  } catch {
    return null
  }
}

export function createTownRoutes({ source, storage, hosts, serial, configOf, current, resident }) {
  const inTown = (id, fn) => serial('town-' + safeId(id), fn)
  /** 只有管理员能决定哪个小镇在后台运行、能改它的速度与天气 */
  const admin = (headers) => {
    const me = current(headers)
    if (me?.role !== 'admin') throw new HttpError(403, '只有管理员能管理后台运行的小镇')
    return me
  }
  /** 首页要看到的：常驻小镇此刻的速度与天气（没见过就 null） */
  const look = (id) => observe(hosts, id)
  /** 被挤掉的小镇 → 挤掉它的小镇：另一个页面进了别的小镇时，这个页面断线后不自动抢回来 */
  const displaced = new Map()
  /** 正在被页面打开的小镇（关掉旧的、启动新的这段时间里它既不在运行也不在启动，也算占着） */
  const claiming = new Set()
  /** 把一个小镇拉起来：跑满了就先保存并关掉最久没人进过的那个，常驻的不参与挤占 */
  const bringUp = async (id, headers) => {
    claiming.add(id)
    try {
      while (!hosts.isRunning(id) && hosts.full()) {
        const oldest = hosts.leastRecent(id)
        if (!oldest) break
        displaced.set(oldest, id)
        await inTown(oldest, () => hosts.close(oldest))
      }
      displaced.delete(id)
      // 世界用开它的那个账号的配置（密钥）跑
      return await inTown(id, async () => hosts.open(id, await configOf(headers)))
    } finally {
      claiming.delete(id)
    }
  }
  return [
    [
      'GET',
      /^\/api\/towns\/health$/,
      ({ headers }) => ({
        kind: 'town-manager',
        version: 1,
        pid: process.pid,
        source,
        user: current(headers),
      }),
    ],
    [
      'GET',
      /^\/api\/towns$/,
      async ({ headers }) => {
        const residentId = resident.town()
        return {
          towns: (await storage.list()).map((town) => ({
            ...town,
            running: hosts.isRunning(town.id),
            resident: town.id === residentId,
          })),
          resident: residentId,
          // 只有管理员能安排后台运行、能改常驻小镇的速度和天气：首页据此显示那几个按钮
          admin: current(headers)?.role === 'admin',
          // 常驻小镇此刻的速度与天气：首页的控制按钮要显示当前值
          status: residentId ? await look(residentId) : null,
        }
      },
    ],
    [
      'GET',
      /^\/api\/towns\/([a-z0-9-]+)\/map$/,
      async ({ params: [id], url }) => {
        const document = await storage.map(safeId(id))
        if (url.searchParams.has('hash') && url.searchParams.get('hash') !== document.content_hash)
          throw Error('地图已变化，请返回小镇列表重新打开')
        return document
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/open$/,
      async ({ params: [id], body, headers }) => {
        // 页面断线后自动重开（automatic）：这个小镇是被另一个页面进的小镇挤掉的、那个还开着，
        // 就不抢回来，告诉页面原因，由玩家自己决定回不回来；不然两个页面会来回互相挤
        const by = displaced.get(id)
        if (body?.automatic && by && (hosts.isRunning(by) || claiming.has(by))) {
          const { name } = await storage.labels(by, await storage.map(by))
          throw new HttpError(409, `另一个页面打开了「${name}」，同一时间只能运行一个小镇`)
        }
        // 有后台运行的小镇时，别人只能进那一个：管理员想换，先在首页把常驻换过来
        const residentId = resident.town()
        if (residentId && residentId !== id && current(headers)?.role !== 'admin') {
          const { name } = await storage.labels(residentId, await storage.map(residentId))
          throw new HttpError(
            403,
            `现在后台运行的是「${name}」，同一时间只有一个小镇在跑`,
            'resident'
          )
        }
        return bringUp(id, headers)
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/close$/,
      async ({ params: [id], body }) => {
        // 常驻小镇不因为有人离开就停：它在后台跑，要它停得管理员先在首页取消常驻
        if (resident.town() === id) return { ok: true, closed: false, resident: true }
        // 带着打开凭证来关：之后又有页面打开过这个小镇（比如刷新），旧页面晚到的关闭不算数
        const closed = await inTown(id, async () => {
          if (body?.lease && hosts.isRunning(id) && !hosts.holds(id, body.lease)) return false
          await hosts.close(id)
          return true
        })
        return { ok: true, closed }
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/resident$/,
      async ({ params: [id], body, headers }) => {
        admin(headers)
        // 取消常驻只是不再后台看着它：正开着的世界不动，谁想进还能进
        if (body?.on === false) {
          if (resident.town() !== id) return { ok: true, resident: resident.town() }
          await resident.set(null)
          hosts.setResident(null)
          return { ok: true, resident: null }
        }
        await storage.map(safeId(id))
        await resident.set(id)
        hosts.setResident(id)
        const info = await bringUp(id, headers)
        // 世界观设好的小镇才谈得上「在后台跑」：没设好的先停着，等管理员进镇设一次
        const state = await look(id)
        if (state?.ready) {
          try {
            await applySpeed(hosts, id, resident.speed())
          } catch (e) {
            // 速度没设上不影响常驻：留在后台，一会儿心跳再试
            console.error('[town-manager] 常驻小镇的速度没设上：', e.message)
          }
        }
        return { ...info, resident: id, ready: Boolean(state?.ready) }
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/control$/,
      async ({ params: [id], body, headers }) => {
        admin(headers)
        if (resident.town() !== id) throw new HttpError(403, '只能控制后台运行的那个小镇')
        const state = await look(id)
        if (!state) throw new HttpError(409, '这个小镇正在拉起来，稍等一会儿再试')
        if (body?.kind === 'speed') {
          const speed = Number(body.speed)
          if (!Number.isFinite(speed) || speed < 0 || speed > 64)
            throw new HttpError(400, '速度不对')
          if (!state.ready) throw new HttpError(409, '这个小镇还没设定世界观，先进镇里设定一次')
          await resident.setSpeed(speed)
          await applySpeed(hosts, id, speed)
          return { ok: true, speed }
        }
        if (body?.kind === 'weather') {
          if (!state.weather) throw new HttpError(409, '这个小镇没开天气，先进镇里的设定打开')
          const environment = await hosts
            .query(id, null, (m) => m.type === 'roster')
            .then((roster) => roster.environment)
          if (!environment) throw new HttpError(409, '这个世界还没有天气')
          const mode = body.mode === 'fixed' ? 'fixed' : 'natural'
          if (mode === 'fixed' && !WEATHER.includes(body.weather))
            throw new HttpError(400, '没有这种天气')
          const command = {
            type: 'set_weather',
            request_id: `resident-weather-${Date.now()}`,
            world_id: environment.world_id,
            expected_revision: environment.revision,
            mode,
            ...(mode === 'fixed' ? { kind: body.weather } : {}),
          }
          const saved = await hosts.query(
            id,
            command,
            (m) => m.type === 'weather_saved' && m.request_id === command.request_id
          )
          if (!saved.ok) throw new HttpError(409, saved.message || '天气没能改')
          return {
            ok: true,
            weather: saved.environment
              ? { mode: saved.environment.mode, kind: saved.environment.kind }
              : { mode },
          }
        }
        throw new HttpError(400, '不认识的控制')
      },
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/delete$/,
      ({ params: [id] }) =>
        inTown(id, async () => {
          if (!storage.canDelete(id)) throw new HttpError(403, '内置地图不能删除')
          if (resident.town() === id) {
            await resident.set(null)
            hosts.setResident(null)
          }
          await hosts.close(id)
          await storage.remove(id)
          return { ok: true }
        }),
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/reset$/,
      ({ params: [id] }) =>
        inTown(id, async () => {
          if (!id.startsWith('prefab-')) throw new HttpError(403, '只有预制小镇能重新开始')
          await hosts.close(id)
          await storage.remove(id, true)
          return { ok: true }
        }),
    ],
    [
      'POST',
      /^\/api\/towns\/([a-z0-9-]+)\/positions$/,
      ({ params: [id], body }) =>
        inTown(id, async () => {
          const document = await storage.map(id)
          if (document.content_hash !== body.map_hash) throw Error('地图版本不匹配')
          return { positions: await positions(storage, id, document, body.instances) }
        }),
    ],
  ]
}
