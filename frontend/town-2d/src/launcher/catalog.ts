import type { MapEntry } from 'town-shared/mapDocument'
import type { ResidentStatus } from 'town-shared/townApi'
import { api } from './api'
export type { MapEntry }
/** 小镇列表，外加「谁在后台一直跑着」：管理员在首页安排它、控制它 */
export type TownList = {
  towns: MapEntry[]
  /** 后台运行的小镇编号；没有就是 null */
  resident?: string | null
  /** 那个小镇此刻的速度与天气 */
  status?: ResidentStatus | null
  /** 只有管理员能安排后台运行、能改速度和天气 */
  admin?: boolean
  /** 这台服务器只开放常驻的那一个小镇：别的小镇在首页看得见，但进不去 */
  locked?: boolean
}
export async function readTowns(): Promise<TownList> {
  return await api<TownList>('')
}
export async function listMaps(): Promise<MapEntry[]> {
  return (await readTowns()).towns
}
/** 打开（或启动）小镇运行服务，返回带连接地址的条目；调用方自己保管它。 */
export async function openMap(id: string): Promise<MapEntry> {
  const entry = await api<MapEntry>(`/${encodeURIComponent(id)}/open`, {})
  if (entry.id !== id || !entry.mapHash || !entry.endpoint) throw new Error('小镇身份不一致')
  return entry
}
export function gameUrl(map: MapEntry) {
  return `./game.html?map=${encodeURIComponent(map.id)}`
}
