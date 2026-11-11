import crypto from 'node:crypto'
import net from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * 一个够用的 WebSocket 客户端（只做文本）。
 *
 * 为什么不用 Node 自带的 `WebSocket`：在 Alibaba Cloud Linux 3 + Node 24.14 / 24.22 上，
 * 连本项目 Rust 世界的握手会随机以 `error TypeError`（close 1006）失败——同一个地址、同一张
 * 入场票，`ws` 包每次都连得上，说明是内置客户端在那种环境下的实现问题。管理服务靠这条连接
 * 拉起常驻小镇、查状态、送密钥，不能赌。这里只实现我们实际用到的那部分：文本帧、掩码、
 * ping/pong、close，以及分片重组。浏览器那侧仍然用浏览器自己的 WebSocket。
 */
export class WebSocket extends EventTarget {
  constructor(url) {
    super()
    this.url = url
    this.readyState = 0 // CONNECTING
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.opened = false
    this.closed = false
    const target = new URL(url)
    const key = crypto.randomBytes(16).toString('base64')
    const expect = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64')
    const port = target.port ? Number(target.port) : 80
    this.socket = net.connect(port, target.hostname)
    this.socket.on('connect', () => {
      this.socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      )
    })
    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      if (!this.opened && !this.handshake(expect)) return
      this.drain()
    })
    this.socket.on('error', (e) => this.fail(e.message))
    this.socket.on('close', () => this.finish())
  }

  /** 和浏览器一样：addEventListener 与 onxxx 两条路都要能收到 */
  emit(name, event) {
    this.dispatchEvent(event)
    const handler = this[`on${name}`]
    if (typeof handler === 'function') handler(event)
  }

  /** 读完 101 响应头；成功返回 true，失败时已经报错收尾 */
  handshake(expect) {
    const end = this.buffer.indexOf('\r\n\r\n')
    if (end < 0) return false
    const head = this.buffer.subarray(0, end).toString('latin1')
    this.buffer = this.buffer.subarray(end + 4)
    const status = Number(head.split('\r\n')[0].split(' ')[1] ?? 0)
    const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1]
    if (status !== 101 || accept !== expect) {
      this.fail(head.split('\r\n').slice(0, 3).join(' · '))
      return false
    }
    this.opened = true
    this.readyState = 1 // OPEN
    this.emit('open', new Event('open'))
    return true
  }

  send(text) {
    if (!this.opened || this.closed) return
    this.socket.write(frame(1, Buffer.from(String(text), 'utf8')))
  }

  close() {
    if (this.closed) return
    this.readyState = 2 // CLOSING
    try {
      if (this.opened) this.socket.write(frame(8, Buffer.alloc(0)))
    } catch {
      /* 对端已经不在了 */
    }
    this.socket.end()
  }

  fail(reason) {
    const message = String(reason ?? '')
    const event = new Event('error')
    event.message = message
    event.error = new Error(message)
    this.emit('error', event)
    this.finish()
  }

  finish(code = 1006, reason = '') {
    if (this.closed) return
    this.closed = true
    this.readyState = 3 // CLOSED
    this.socket?.destroy()
    const event = new Event('close')
    event.code = code
    event.reason = reason
    event.wasClean = code !== 1006
    this.emit('close', event)
  }

  /** 从缓冲区里尽量多地取出完整的帧 */
  drain() {
    for (;;) {
      if (this.closed || this.buffer.length < 2) return
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let at = 2
      if (length === 126) {
        if (this.buffer.length < at + 2) return
        length = this.buffer.readUInt16BE(at)
        at += 2
      } else if (length === 127) {
        if (this.buffer.length < at + 8) return
        length = Number(this.buffer.readBigUInt64BE(at))
        at += 8
      }
      let mask = null
      if (masked) {
        if (this.buffer.length < at + 4) return
        mask = this.buffer.subarray(at, at + 4)
        at += 4
      }
      if (this.buffer.length < at + length) return
      let payload = this.buffer.subarray(at, at + length)
      this.buffer = this.buffer.subarray(at + length)
      if (mask) payload = unmask(payload, mask)
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        this.finish(code, payload.subarray(2).toString('utf8'))
        return
      }
      if (opcode === 9) {
        if (this.opened && !this.closed) {
          try {
            this.socket.write(frame(10, payload))
          } catch {
            /* 写不动就算了，下一次读会失败 */
          }
        }
        continue
      }
      if (opcode === 10) continue
      if (opcode === 0 || opcode === 1 || opcode === 2) {
        this.fragments.push(payload)
        if (fin) {
          const whole = Buffer.concat(this.fragments)
          this.fragments = []
          this.emit('message', new MessageEvent('message', { data: whole.toString('utf8') }))
        }
      }
    }
  }
}

function frame(opcode, payload) {
  const mask = crypto.randomBytes(4)
  const body = Buffer.from(payload)
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
  let head
  if (body.length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | body.length])
  } else if (body.length < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 0x80 | 126
    head.writeUInt16BE(body.length, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([head, mask, body])
}

function unmask(payload, mask) {
  const out = Buffer.from(payload)
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4]
  return out
}

export default WebSocket
