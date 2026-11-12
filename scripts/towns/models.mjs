// 首页「设定」的模型服务：读、存、连通测试。逻辑在 host::models，经 town-map 子进程调用；
// 纯浏览器版仅通过 Node Manager 暴露该接口。
// 每个账号各用自己那份配置（密钥文件不同）：configOf(headers) 按请求里的 Cookie 算。
import { worker } from './workers.mjs'

export function createModelRoutes({ source, configOf, serial }) {
  const run = async (mode, input, options, headers) =>
    worker(source, await configOf(headers), mode, input, options)
  return [
    [
      'GET',
      /^\/api\/towns\/models$/,
      ({ headers }) => run('models', {}, { timeout: 10000 }, headers),
    ],
    // 两次保存同时读改写密钥文件会丢掉一个，排队执行
    [
      'POST',
      /^\/api\/towns\/models$/,
      ({ body, headers }) =>
        serial('models', () => run('save-models', body, { timeout: 10000 }, headers)),
    ],
    [
      'POST',
      /^\/api\/towns\/models\/test$/,
      ({ body, signal, headers }) => run('test-model', body, { signal, timeout: 60000 }, headers),
    ],
  ]
}
