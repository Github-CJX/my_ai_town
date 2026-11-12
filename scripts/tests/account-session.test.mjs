import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Accounts, publicUser } from '../towns/accounts.mjs'
import { createManager } from '../town-manager.mjs'

// Does not need Rust binary, third-party packages or a running model.
test('account ID is not an authentication token; sessions survive reload and revoke on PIN reset', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'town-session-test-'))
  try {
    const a = await new Accounts(home).load()
    const admin = await a.setup('管理员', '1234')
    const token = await a.issue(admin.id)
    const secondToken = await a.issue(admin.id)
    assert.notEqual(token, secondToken)
    assert.equal(a.current(admin.id), undefined)
    assert.equal(a.current('fake'), undefined)
    assert.equal(a.current(token)?.id, admin.id)
    assert.equal(
      a.current(secondToken)?.id,
      admin.id,
      'multiple browser sessions should remain valid'
    )
    const file = await fs.readFile(path.join(home, 'accounts.json'), 'utf8')
    assert(
      !file.includes(token) && !file.includes(secondToken),
      'raw session cannot be stored on disk'
    )
    const reloaded = await new Accounts(home).load()
    assert.equal(reloaded.current(token)?.id, admin.id)
    await reloaded.setPin(admin.id, '1234', '5678')
    assert.equal(reloaded.current(token), undefined)
    assert.equal(reloaded.current(secondToken), undefined)
    assert.equal(publicUser(reloaded.admin()).pin, undefined)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('health never returns a PIN hash; unauthenticated destructive requests are refused', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'town-auth-http-'))
  let manager
  try {
    manager = await createManager({ root: home, port: 0, mockLlm: true })
    const base = `http://127.0.0.1:${manager.server.address().port}/api/towns`
    const r = await fetch(base + '/users/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-town-client': '1' },
      body: JSON.stringify({ name: '管理员', pin: '1234' }),
    })
    assert.equal(r.status, 200)
    const created = await r.json()
    const cookie = r.headers.get('set-cookie').split(';')[0]
    const id = created.current.id
    const claimed = await fetch(base + '/health', { headers: { cookie: `town_user=${id}` } })
    assert.equal((await claimed.json()).user, null)
    const health = await fetch(base + '/health', { headers: { cookie } })
    const data = await health.json()
    assert.equal(data.user.role, 'admin')
    assert.equal(data.user.pin, undefined)
    for (const action of ['delete', 'reset', 'close']) {
      const rr = await fetch(`${base}/default-town/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-town-client': '1' },
        body: '{}',
      })
      assert([401, 403].includes(rr.status), `${action} returned ${rr.status}`)
    }
  } finally {
    await manager?.stop()
    await fs.rm(home, { recursive: true, force: true })
  }
})
