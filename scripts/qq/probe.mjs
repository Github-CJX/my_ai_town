//! 探针：只证明「票能换、网关能连、能收到主人私聊」，不碰世界、不回话。
//!
//! 用法（服务器上）：
//!   QQ_CONFIG=/root/.local/share/my-ai-town/config/qq.json \
//!   QQ_PROBE_MINUTES=120 node scripts/qq/probe.mjs
//!
//! 收到私聊时打印 `C2C_MESSAGE_CREATE`，只留 openid 尾 6 位；完整 openid 写进日志是泄露。

import { readCredentials, fetchToken, createGateway, maskId } from './gateway.mjs'

const configPath = process.env.QQ_CONFIG ?? '/root/.local/share/my-ai-town/config/qq.json'
const minutes = Number(process.env.QQ_PROBE_MINUTES ?? 60)

const stamp = () => new Date().toISOString()
const log = (text) => console.log(`${stamp()} ${text}`)

async function main() {
  const credentials = await readCredentials(configPath)
  log(`读到凭证 app_id=${credentials.appId}`)
  const { token } = await fetchToken(credentials)
  log('换票成功')

  const gateway = createGateway({
    token,
    onLog: log,
    onReady: (data) => log(`机器人：${data?.user?.username ?? '(无名)'}`),
    onEvent: (event) => {
      if (event.name !== 'C2C_MESSAGE_CREATE') {
        log(`事件 ${event.name}`)
        return
      }
      const data = event.data ?? {}
      const author = data.author ?? {}
      log(
        `C2C_MESSAGE_CREATE openid=${maskId(author.user_openid)} msg_id=${data.id ?? '?'} ` +
          `at=${data.timestamp ?? '?'} 内容=${JSON.stringify(String(data.content ?? '').slice(0, 200))}`
      )
    },
  })

  const stop = () => {
    log('收到结束信号，退出')
    gateway.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await gateway.start()
  log(`探针挂起 ${minutes} 分钟，期间请主人给机器人发一条私聊`)
  setTimeout(stop, minutes * 60_000).unref?.()
}

main().catch((error) => {
  console.error(`${stamp()} 探针失败：${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
