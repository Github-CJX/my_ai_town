// 内置模型的状态、看有没有新版本、下载暂停删除。逻辑在 host::builtin_store，经 town-map 子进程调用；
// 浏览器私人服的管理服务调用内置模型。
// 下载是一个长时间运行的 town-map 子进程：下完、暂停或停在出错上自己退出，同一时间只起一个。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { worker } from './workers.mjs'

export function createBuiltinModelRoutes({ source, configOf }) {
  const run = async (mode, input, options, headers) =>
    worker(source, await configOf(headers), mode, input, options)
  let download = null
  function ensureDownload(config) {
    if (download) return
    const child = spawn(
      process.env.TOWN_MAP_BINARY ?? path.join(source, 'target/debug/town-map'),
      ['builtin-model-download'],
      {
        cwd: source,
        windowsHide: true,
        env: { ...process.env, AI_TOWN_CONFIG: config },
        stdio: ['pipe', 'ignore', 'inherit'],
      }
    )
    download = child
    const done = () => {
      if (download === child) download = null
    }
    child.on('exit', done)
    child.on('error', (e) => {
      console.error('[town-manager] 内置模型下载没能开始：', e.message)
      done()
    })
    child.stdin.on('error', () => {})
    child.stdin.end('{}')
  }
  // 管理服务无论怎样退出都不留下下载进程；下到一半的文件留着，下次接着下
  const stop = () => download?.kill('SIGTERM')
  process.on('exit', stop)
  const routes = [
    [
      'GET',
      /^\/api\/towns\/builtin-model$/,
      ({ headers }) => run('builtin-model', {}, { timeout: 10000 }, headers),
    ],
    [
      'POST',
      /^\/api\/towns\/builtin-model$/,
      async ({ body, headers }) => {
        // 认不出版本的本机模型要先算一遍校验值，几百 MB 在手机上要几秒
        if (body?.action === 'check')
          return run('builtin-model-check', {}, { timeout: 60000 }, headers)
        const status = await run('builtin-model-act', body, { timeout: 60000 }, headers)
        if (body?.action === 'download') ensureDownload(await configOf(headers))
        return status
      },
    ],
  ]
  return { routes, stop }
}
