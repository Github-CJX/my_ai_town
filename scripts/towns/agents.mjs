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

/**
 * 这个账号自己选定的模型与密钥（application.json → providers.json + credentials.json）。
 * 管理员那份就是小镇的密钥；普通账号从空开始，得他自己填。没选模型或没填密钥回 null，
 * 那时照样能投，只是那名村民会先在镇上等着。
 */
export async function apiOf(application) {
  const doc = await readJson(application)
  return apiFromPaths(doc.providers_path, doc.credentials_path)
}

/** 已经知道两份文件在哪时直接读（世界重启后重发密钥也走这里） */
export async function apiFromPaths(providersPath, credentialsPath) {
  let providers = {}
  try {
    providers = await readJson(providersPath)
  } catch {}
  const provider = String(providers.active?.provider ?? '')
  const model = String(providers.active?.model ?? '')
  if (!provider || !model) return null
  let credentials = {}
  try {
    credentials = await readJson(credentialsPath)
  } catch {}
  const api_key = String(credentials[provider] ?? '')
  if (!api_key.trim()) return null
  const base_url = String(
    (providers.providers ?? []).find((entry) => entry.id === provider)?.base_url ?? ''
  )
  return { provider, model, base_url, api_key }
}

/** 页面看到的 agent：投放记录按小镇列表给出，页面上好显示「在上镇」「在下镇」 */

export function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    template_id: agent.template_id ?? '',
    template_version: agent.template_version ?? 0,
    ...(agent.fields ? { fields: agent.fields } : {}),
    revision: agent.revision ?? 0,
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
 * 建一个 agent 定义：整份人设（`fields`：姓名、介绍、性格、背景、长相）跟着账号走，
 * 投进哪个镇时才由管理服务写进那个镇的村民库。也认老形状（name + template_id + template_version）。
 * 普通账号有人数上限，管理员不限。
 */
export async function createAgent(root, userId, body, limit) {
  const fields =
    body?.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
      ? body.fields
      : null
  const name = checkName(fields ? fields.name : body?.name)
  let templateId = ''
  let version = 0
  if (!fields) {
    templateId = String(body?.template_id ?? '').trim()
    if (!templateId || templateId.length > 200) throw new HttpError(400, '要指定一个村民模板')
    version = Number(body?.template_version)
    if (!Number.isInteger(version) || version < 0) throw new HttpError(400, '模板版本不对')
  }
  const home = body?.home === undefined || body?.home === null ? null : String(body.home).trim()
  if (home !== null && (!home || home.length > 64)) throw new HttpError(400, '住处不对')
  const agents = await listAgents(root, userId)
  if (limit !== null && limit !== undefined && agents.length >= limit)
    throw new HttpError(403, `这个账号最多 ${limit} 个 agent`, 'limit')
  if (agents.some((a) => a.name === name)) throw new HttpError(400, '已经有同名的 agent 了')
  const agent = {
    id: 'a' + hex(8),
    name,
    ...(fields ? { fields } : { template_id: templateId, template_version: version }),
    revision: 0,
    ...(home ? { home } : {}),
    created_at: Math.floor(Date.now() / 1000),
    deployed: {},
  }
  await atomicJson(agentFile(root, userId, agent.id), agent)
  return agent
}

/**
 * 改一份定义：人设、长相、落脚点，`revision` +1，下次投放时才重写镇上的模板。
 * 已经投出去的那一位不会跟着变——他镇上的档案是投放那一刻定下的，收回再投才更新。
 */
export async function updateAgent(root, userId, body) {
  const agent = await readAgent(root, userId, body?.id)
  const fields =
    body?.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
      ? body.fields
      : null
  if (!fields) throw new HttpError(400, '没带上要改的人设')
  const name = checkName(fields.name)
  const others = await listAgents(root, userId)
  if (others.some((other) => other.id !== agent.id && other.name === name))
    throw new HttpError(400, '已经有同名的 agent 了')
  let home = agent.home
  if (body.home !== undefined) {
    home = body.home === null ? null : String(body.home).trim()
    if (home !== null && (!home || home.length > 64)) throw new HttpError(400, '住处不对')
  }
  const next = {
    ...agent,
    name,
    fields,
    revision: (agent.revision ?? 0) + 1,
    ...(home ? { home } : {}),
  }
  if (!home) delete next.home
  await atomicJson(agentFile(root, userId, agent.id), next)
  return next
}

/** 投放时在镇上写了一份模板：记下编号、版本、以及当时账号里的定义是第几版 */
export async function recordTemplate(root, userId, agent, townId, templateId, version) {
  agent.templates = {
    ...(agent.templates ?? {}),
    [safeId(townId)]: {
      template_id: templateId,
      version,
      revision: agent.revision ?? 0,
    },
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

/** 收回来之后抹掉这个镇的记录：人不在镇上了，定义里也不该再写着他在 */
export async function recordWithdraw(root, userId, agent, townId) {
  const town = safeId(townId)
  if (!agent.deployed?.[town]) throw new HttpError(409, '这个 agent 不在这个镇里')
  const deployed = { ...agent.deployed }
  delete deployed[town]
  agent.deployed = deployed
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
