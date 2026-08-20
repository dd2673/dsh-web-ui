import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_MAX_PAYLOAD = 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length])
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([header, body])
}

export class WebSocketPeer extends EventEmitter {
  #socket
  #buffer = Buffer.alloc(0)
  #closed = false
  #maxPayload

  constructor(socket, head = Buffer.alloc(0), maxPayload = DEFAULT_MAX_PAYLOAD) {
    super()
    this.#socket = socket
    this.#maxPayload = maxPayload
    socket.setNoDelay(true)
    socket.on('data', chunk => this.#consume(chunk))
    socket.on('error', error => this.emit('error', error))
    socket.on('close', () => {
      if (this.#closed) return
      this.#closed = true
      this.emit('close', 1006, 'socket closed')
    })
    if (head.length > 0) this.#consume(head)
  }

  get closed() {
    return this.#closed
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value))
  }

  sendText(value) {
    if (this.#closed) return false
    const payload = Buffer.from(value, 'utf8')
    if (payload.length > this.#maxPayload) throw new Error('outbound websocket payload too large')
    this.#socket.write(frame(0x1, payload))
    return true
  }

  ping(payload = Buffer.alloc(0)) {
    if (!this.#closed) this.#socket.write(frame(0x9, payload))
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return
    this.#closed = true
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123)
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length)
    payload.writeUInt16BE(code, 0)
    reasonBytes.copy(payload, 2)
    this.#socket.end(frame(0x8, payload))
    this.emit('close', code, reason)
  }

  #fail(code, reason) {
    this.close(code, reason)
  }

  #consume(chunk) {
    if (this.#closed) return
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    while (!this.#closed && this.#buffer.length >= 2) {
      const first = this.#buffer[0]
      const second = this.#buffer[1]
      const final = (first & 0x80) !== 0
      const reserved = first & 0x70
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      if (!final || reserved !== 0 || !masked) {
        this.#fail(1002, 'unsupported websocket frame')
        return
      }
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.#buffer.length < 4) return
        length = this.#buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.#buffer.length < 10) return
        const wide = this.#buffer.readBigUInt64BE(2)
        if (wide > BigInt(this.#maxPayload)) {
          this.#fail(1009, 'websocket payload too large')
          return
        }
        length = Number(wide)
        offset = 10
      }
      if (length > this.#maxPayload) {
        this.#fail(1009, 'websocket payload too large')
        return
      }
      if (this.#buffer.length < offset + 4 + length) return
      const mask = this.#buffer.subarray(offset, offset + 4)
      const payload = Buffer.from(this.#buffer.subarray(offset + 4, offset + 4 + length))
      this.#buffer = this.#buffer.subarray(offset + 4 + length)
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]

      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        this.close(code, reason)
        return
      }
      if (opcode === 0x9) {
        this.#socket.write(frame(0xA, payload.subarray(0, 125)))
        continue
      }
      if (opcode === 0xA) {
        this.emit('pong')
        continue
      }
      if (opcode !== 0x1) {
        this.#fail(1003, 'text frames only')
        return
      }
      try {
        this.emit('text', decoder.decode(payload))
      } catch {
        this.#fail(1007, 'invalid utf8')
        return
      }
    }
  }
}

export function upgradeWebSocket(request, socket, head, options = {}) {
  const key = request.headers['sec-websocket-key']
  const version = request.headers['sec-websocket-version']
  const upgrade = request.headers.upgrade
  if (typeof key !== 'string' || version !== '13' || upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return undefined
  }
  const accept = createHash('sha1').update(key + MAGIC).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'))
  return new WebSocketPeer(socket, head, options.maxPayloadBytes)
}
