/**
 * EagleBox Network Module
 *
 * Uses Hyperswarm for peer discovery and NAT hole-punching.
 * Each file share is identified by a 32-byte topic derived from its share code.
 *
 * Roles:
 *  - Sender   joins the swarm as a server (announces the topic)
 *  - Receiver joins the swarm as a client (looks up the topic)
 *
 * Wire protocol (framed messages over a raw Hyperswarm connection):
 *  All messages are length-prefixed:
 *    [4 bytes uint32 BE: payload length][payload bytes]
 *
 * Message format (JSON envelope wrapping binary data):
 *  { type, ...fields }
 *
 *  Types:
 *    HELLO        { type, version, peerId }
 *    META_REQ     { type }                          (receiver → sender)
 *    META_RES     { type, encMeta: <hex> }          (sender → receiver)
 *    CHUNK_REQ    { type, index }                   (receiver → sender)
 *    CHUNK_RES    { type, index, data: <hex> }      (sender → receiver)
 *    DONE         { type }
 *    ERROR        { type, message }
 */

import Hyperswarm from 'hyperswarm'
import { shareCodeToTopic } from './crypto.js'
import { EventEmitter } from 'events'

const PROTOCOL_VERSION = 1
const FRAME_HEADER_SIZE = 4

// ── Low-level framing helpers ─────────────────────────────────────────────────

/**
 * Encode a JS object as a length-prefixed JSON frame.
 */
function encodeMessage (obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const header = Buffer.allocUnsafe(FRAME_HEADER_SIZE)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/**
 * Stateful stream parser that accumulates bytes and emits complete messages.
 */
export class MessageParser extends EventEmitter {
  constructor () {
    super()
    this._buf = Buffer.alloc(0)
  }

  push (chunk) {
    this._buf = Buffer.concat([this._buf, chunk])
    this._drain()
  }

  _drain () {
    while (this._buf.length >= FRAME_HEADER_SIZE) {
      const len = this._buf.readUInt32BE(0)
      if (this._buf.length < FRAME_HEADER_SIZE + len) break
      const body = this._buf.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + len)
      this._buf = this._buf.subarray(FRAME_HEADER_SIZE + len)
      try {
        this.emit('message', JSON.parse(body.toString('utf8')))
      } catch (err) {
        this.emit('error', new Error('Failed to parse message: ' + err.message))
      }
    }
  }
}

// ── Peer connection wrapper ───────────────────────────────────────────────────

export class PeerConnection extends EventEmitter {
  constructor (socket, isInitiator) {
    super()
    this.socket = socket
    this.isInitiator = isInitiator
    this._parser = new MessageParser()

    socket.on('data', (chunk) => this._parser.push(chunk))
    this._parser.on('message', (msg) => this.emit('message', msg))
    this._parser.on('error', (err) => this.emit('error', err))
    socket.on('error', (err) => this.emit('error', err))
    socket.on('close', () => this.emit('close'))
    socket.on('end', () => this.emit('end'))
  }

  send (obj) {
    return new Promise((resolve, reject) => {
      const frame = encodeMessage(obj)
      this.socket.write(frame, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  destroy (err) {
    this.socket.destroy(err)
  }
}

// ── Swarm manager ─────────────────────────────────────────────────────────────

export class SwarmManager extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._swarm = new Hyperswarm(opts)
    this._peerId = Buffer.from(
      Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
    ).toString('hex')

    this._swarm.on('connection', (socket, peerInfo) => {
      const conn = new PeerConnection(socket, peerInfo.client)
      this.emit('peer', conn, peerInfo)
    })
  }

  get peerId () { return this._peerId }

  /**
   * Announce + look up a topic (sender mode: server=true).
   */
  async joinAsSender (shareCode) {
    const topic = shareCodeToTopic(shareCode)
    const discovery = this._swarm.join(topic, { server: true, client: false })
    await discovery.flushed()
    return discovery
  }

  /**
   * Look up a topic only (receiver mode: client=true).
   */
  async joinAsReceiver (shareCode) {
    const topic = shareCodeToTopic(shareCode)
    const discovery = this._swarm.join(topic, { server: false, client: true })
    await this._swarm.flush()
    return discovery
  }

  async destroy () {
    await this._swarm.destroy()
  }
}
