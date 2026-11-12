import test from 'node:test'
import assert from 'node:assert/strict'
import { walkingHarness } from './avatar-input-support.mjs'

test('WebSocket 不可用时：WASD 与点击移动都不得先行本地预测', () => {
  const rendered = []
  const sounds = []
  const sent = []
  const map = {
    avatarSupported: true,
    setAvatarMotion: (...args) => rendered.push(args),
    walkRoute: (_from, to) => [{ point: to }],
    walkSees: () => true,
    walkDirection: (d) => d,
    onAvatarWalkTo: null,
  }
  const start = {
    epoch: 'owned',
    speed: 1,
    walk: { metres_per_minute: 12, sprint_factor: 2 },
    navigation_revision: 1,
    actor: {
      id: 'town',
      busy: false,
      locus: { at: { kind: 'free', space: 'outdoor', position: [0, 0] } },
    },
  }
  const h = walkingHarness(
    () => {},
    () => true,
    {
      map,
      getState: () => start,
      getWorld: () => 'world',
      getHolds: () => [],
      owned: () => true,
      mapVisible: () => true,
      send: (msg) => {
        sent.push(msg)
        return false
      },
      execute: async () => false,
      targets: () => [],
      toggleBag() {},
      showToast() {},
      onDirection: (d) => sounds.push([...d]),
    }
  )
  try {
    h.event(h.window, 'keydown', { code: 'KeyW' })
    assert.equal(sent.at(-1).direction[1], -1, '输入仍应尝试发送')
    assert.deepEqual(Array.from(rendered.at(-1)[0]), [0, 0], '发送失败时预测必须停止')
    assert.deepEqual(sounds.at(-1), [0, 0], '音效不能冒充正在行走')
    h.event(h.window, 'keyup', { code: 'KeyW' })
    map.onAvatarWalkTo({ space: 'outdoor', position: [10, 0] })
    assert.deepEqual(Array.from(rendered.at(-1)[0]), [0, 0], '点击走路同样不能本地前进')
  } finally {
    h.abort.abort()
  }
})
