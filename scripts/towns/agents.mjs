// 账号自己养的 agent：名字、用哪个村民模板、住在哪，存在这个账号自己的目录下
// （users/<账号>/agents/<编号>.json）。定义为账号所有，所以换一个小镇也能照着再投一个；
// 但投放是手动的一次动作：村民住进哪个小镇、记忆留在哪个小镇，都只在那一个小镇的存档里。
// 「投放」把定义交给正在运行的世界（join_resident），这里只记「谁投到了哪个镇」的账。
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from './http.mjs'
import { atomicJson, readJson, safeId } from './storage.mjs'

const MAX_NAME = 16

const hex = (bytes) => randomBytes(bytes).toString('hex')

function agentsDir(root, userId) {
  return path.join(root, 'users', safeId(userId), 'agents')
}

function agentFile(root, userId, id) {
  return path.join(agentsDir(root, userId), `${safeId(id)}.json`)
}

function checkName(name) {
  const clean = String(name ?? '').trim()
  if (!clean || clean.length > MAX_NAME) throw new HttpError(400, `名字须为 1–${MAX_NAME} 个字符`)
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new HttpError(400, '名字里有不能用的字符')
  return clean
}

/** 页面看到的 agent：投放记录按小镇列表给出，页面上好显示「在上镇」「在下镇」 */
export function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    template_id: agent.template_id,
    template_version: agent.template_version,
    ...(agent.home ? { home: agent.home } : {}),
    created_at: agent.created_at,
    deployed: Object.entries(agent.deployed ?? {}).map(([town, record]) => ({
      town,
      resident: record.resident,
      name: record.name,
      at: record.at,
    })),
  }
}

export async function listAgents(root, userId) {
  let names = []
  try {
    names = await fs.readdir(agentsDir(root, userId))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    return []
  }
  const agents = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      agents.push(await readJson(path.join(agentsDir(root, userId), name)))
    } catch {
      // 坏文件跳过：不影响别的 agent 用
    }
  }
  return agents.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
}

export async function readAgent(root, userId, id) {
  try {
    return await readJson(agentFile(root, userId, id))
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(404, '没有这个 agent')
    throw e
  }
}

/**
 * 建一个 agent 定义：名字 + 用哪个村民模板（编号与版本都记下来——模板改版之后，
 * 原来的 agent 还是按当初那一版投）。普通账号有人数上限，管理员不限。
 */
export async function createAgent(root, userId, body, limit) {
  const name = checkName(body?.name)
  const templateId = String(body?.template_id ?? '').trim()
  if (!templateId || templateId.length > 200) throw new HttpError(400, '要指定一个村民模板')
  const version = Number(body?.template_version)
  if (!Number.isInteger(version) || version < 0) throw new HttpError(400, '模板版本不对')
  const home = body?.home === undefined || body?.home === null ? null : String(body.home).trim()
  if (home !== null && (!home || home.length > 64)) throw new HttpError(400, '住处不对')
  const agents = await listAgents(root, userId)
  if (limit !== null && limit !== undefined && agents.length >= limit)
    throw new HttpError(403, `这个账号最多 ${limit} 个 agent`, 'limit')
  if (agents.some((a) => a.name === name)) throw new HttpError(400, '已经有同名的 agent 了')
  const agent = {
    id: 'a' + hex(8),
    name,
    template_id: templateId,
    template_version: version,
    ...(home ? { home } : {}),
    created_at: Math.floor(Date.now() / 1000),
    deployed: {},
  }
  await atomicJson(agentFile(root, userId, agent.id), agent)
  return agent
}

/** 记下这次投放（哪个镇、世界给的居民编号）；同一个小镇只留一条 */
export async function recordDeploy(root, userId, agent, townId, record) {
  agent.deployed = {
    ...(agent.deployed ?? {}),
    [safeId(townId)]: { ...record, at: Math.floor(Date.now() / 1000) },
  }
  await atomicJson(agentFile(root, userId, agent.id), agent)
  return agent
}

/** 删一个 agent 定义：还在某个小镇里活着的不让删，免得记录和镇上的人对不上 */
export async function removeAgent(root, userId, id) {
  const agent = await readAgent(root, userId, id)
  const towns = Object.keys(agent.deployed ?? {})
  if (towns.length) throw new HttpError(409, `这个 agent 还在「${towns.join('」「')}」里，删不掉`)
  await fs.rm(agentFile(root, userId, id), { force: true })
  return agent
}
