import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PRESETS } from '../../frontend/town-shared/src/providers.ts'

test('模型目录移除 Zen 和 302.AI，并提供独立的 OpenCode Go 端点', () => {
  assert(!PRESETS.some((p) => ['opencode', '302-ai'].includes(p.id)))
  const go = PRESETS.find((p) => p.id === 'opencode-go')
  assert(go)
  assert.equal(go.name, 'OpenCode Go')
  assert.equal(go.needsKey, true)
  assert.equal(go.baseUrl, 'https://opencode.ai/inference/go/openai/v1')
  assert(go.models.includes(go.defaultModel))
})

test('世界请求为 OpenCode Go 添加会话 header', async () => {
  const host = await readFile(new URL('../../crates/host/src/llm.rs', import.meta.url), 'utf8')
  const worker = await readFile(
    new URL('../../crates/host/src/agent_worker.rs', import.meta.url),
    'utf8'
  )
  assert.match(host, /req = req\.set\("x-opencode-session", session\)/)
  assert.match(worker, /opencode_agent_session\(&request\.actor_id, request\.session_id\)/)
})
