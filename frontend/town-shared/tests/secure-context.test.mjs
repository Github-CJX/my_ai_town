// 服务器上是 http://ip:port（非安全上下文），`crypto.randomUUID` 在那里不存在。
// 直接调它会让「进入化身」「控制天气」这类按钮悄悄失灵，所以只能走 ids.ts 的 newId。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const frontend = path.join(root, 'frontend')
const ids = path.join(frontend, 'town-shared/src/ids.ts')

function sources(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
}

test('客户端只用 newId 生成编号：非安全上下文没有 crypto.randomUUID', () => {
  const files = [
    path.join(frontend, 'town-2d/src'),
    path.join(frontend, 'town-shared/src'),
  ].flatMap(sources)
  assert.ok(files.length > 50, `源码文件应有几十个，实际 ${files.length}`)
  for (const file of files) {
    if (file === ids) continue
    const text = fs.readFileSync(file, 'utf8')
    const hits = text
      .split('\n')
      .map((line, index) => ({ line, index: index + 1 }))
      // 注释里提到它的不算：说明「这里不能直接调」。
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes('crypto.randomUUID'))
    assert.deepEqual(
      hits.map(({ index, line }) => `${path.relative(root, file)}:${index} ${line.trim()}`),
      [],
      '这些地方要改用 ids.ts 的 newId'
    )
  }
})

test('newId 在缺少 randomUUID 时退回时间戳加随机数', () => {
  const text = fs.readFileSync(ids, 'utf8')
  assert.match(text, /export function newId\(\): string/)
  assert.match(text, /crypto\.randomUUID\?\.\(\)/, '必须用可选调用，否则非安全上下文直接抛错')
})
