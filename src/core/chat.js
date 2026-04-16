/**
 * EagleBox Chat Module
 *
 * Peer-to-peer encrypted group chat over Hyperswarm.
 *
 * Design:
 *  - Each chat room is identified by a human-readable name hashed to a Hyperswarm topic
 *  - Messages are encrypted with AES-256-GCM using a room key derived from the room name
 *    (so only people who know the room name can read messages)
 *  - Wire format: length-prefixed JSON (same as transfer.js)
 *
 * Message types:
 *  CHAT_HELLO   { type, nickname, peerId }
 *  CHAT_MSG     { type, id, text, nickname, peerId, ts }     (encrypted payload)
 *  CHAT_BYE     { type, peerId, nickname }
 *
 * Encryption:
 *  Room key = HKDF-SHA256(SHA256(roomName), "eaglebox-chat-v1", 32 bytes)
 *  Each message is individually encrypted with encryptChunk().
 *  The wire frame carries: { type: 'CHAT_ENC', iv+tag+ciphertext: hex }
 */

import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { encryptChunk, decryptChunk } from './crypto.js'
import { MessageParser } from './network.js'

// ── Room key derivation ────────────────────────────────────────────────────────

function deriveRoomKey (roomName) {
  // Deterministic 32-byte key from room name — anyone with the name can join
  return crypto.createHash('sha256').update('eaglebox-chat-v1:' + roomName).digest()
}

function deriveRoomTopic (roomName) {
  return crypto.createHash('sha256').update('eaglebox-chat-topic-v1:' + roomName).digest()
}

// ── Framing helpers ───────────────────────────────────────────────────────────

function encodeFrame (obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const hdr = Buffer.allocUnsafe(4)
  hdr.writeUInt32BE(body.length, 0)
  return Buffer.concat([hdr, body])
}

// ── ChatRoom ──────────────────────────────────────────────────────────────────

export class ChatRoom extends EventEmitter {
  /**
   * @param {string} roomName   Human-readable room name (becomes the Hyperswarm topic)
   * @param {string} nickname   Display name for this peer
   */
  constructor (roomName, nickname) {
    super()
    this.roomName = roomName
    this.nickname = nickname
    this._peerId = crypto.randomBytes(8).toString('hex')
    this._key = deriveRoomKey(roomName)
    this._topic = deriveRoomTopic(roomName)
    this._swarm = new Hyperswarm()
    this._peers = new Map()   // peerId → { socket, nickname }
    this._history = []        // local message log
    this._setupSwarm()
  }

  get peerId () { return this._peerId }
  get history () { return [...this._history] }

  // ── Setup ──────────────────────────────────────────────────────────────────

  _setupSwarm () {
    this._swarm.on('connection', (socket) => {
      const parser = new MessageParser()
      socket.on('data', chunk => parser.push(chunk))
      parser.on('message', msg => this._handleRaw(msg, socket))
      socket.on('error', () => {})
      socket.on('close', () => this._handleDisconnect(socket))

      // Greet the new peer
      this._sendTo(socket, { type: 'CHAT_HELLO', nickname: this.nickname, peerId: this._peerId })
    })
  }

  async join () {
    const discovery = this._swarm.join(this._topic, { server: true, client: true })
    await discovery.flushed()
  }

  // ── Message handling ───────────────────────────────────────────────────────

  _handleRaw (msg, socket) {
    if (msg.type === 'CHAT_ENC') {
      try {
        const buf = Buffer.from(msg.payload, 'hex')
        const plain = decryptChunk(buf, this._key)
        const inner = JSON.parse(plain.toString('utf8'))
        this._handleDecrypted(inner, socket)
      } catch (_) {
        // Bad key or tampered — silently drop
      }
      return
    }

    if (msg.type === 'CHAT_HELLO') {
      // Register peer
      this._peers.set(msg.peerId, { socket, nickname: msg.nickname })
      this.emit('peer-joined', { peerId: msg.peerId, nickname: msg.nickname })
      // Send back our hello
      this._sendTo(socket, { type: 'CHAT_HELLO', nickname: this.nickname, peerId: this._peerId })
      // Replay recent history so late joiners catch up (last 50 messages)
      for (const m of this._history.slice(-50)) {
        this._sendEncrypted(socket, m)
      }
    }
  }

  _handleDecrypted (inner, _socket) {
    if (inner.type === 'CHAT_MSG') {
      // Deduplicate by message id
      if (this._history.find(m => m.id === inner.id)) return
      this._history.push(inner)
      this.emit('message', inner)
    } else if (inner.type === 'CHAT_BYE') {
      const info = this._peers.get(inner.peerId)
      this._peers.delete(inner.peerId)
      this.emit('peer-left', { peerId: inner.peerId, nickname: inner.nickname || info?.nickname })
    }
  }

  _handleDisconnect (socket) {
    for (const [peerId, info] of this._peers.entries()) {
      if (info.socket === socket) {
        this._peers.delete(peerId)
        this.emit('peer-left', { peerId, nickname: info.nickname })
        break
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send a chat message to all connected peers.
   */
  sendMessage (text) {
    if (!text || !text.trim()) return
    const msg = {
      type: 'CHAT_MSG',
      id: crypto.randomBytes(8).toString('hex'),
      text: text.trim(),
      nickname: this.nickname,
      peerId: this._peerId,
      ts: Date.now()
    }
    this._history.push(msg)
    this.emit('message', msg)   // emit locally too (own messages)
    this._broadcastEncrypted(msg)
  }

  async destroy () {
    // Announce departure
    this._broadcastEncrypted({ type: 'CHAT_BYE', peerId: this._peerId, nickname: this.nickname })
    await this._swarm.destroy()
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _sendTo (socket, obj) {
    try { socket.write(encodeFrame(obj)) } catch (_) {}
  }

  _sendEncrypted (socket, inner) {
    try {
      const plain = Buffer.from(JSON.stringify(inner), 'utf8')
      const enc = encryptChunk(plain, this._key)
      socket.write(encodeFrame({ type: 'CHAT_ENC', payload: enc.toString('hex') }))
    } catch (_) {}
  }

  _broadcastEncrypted (inner) {
    const plain = Buffer.from(JSON.stringify(inner), 'utf8')
    const enc = encryptChunk(plain, this._key)
    const frame = encodeFrame({ type: 'CHAT_ENC', payload: enc.toString('hex') })
    for (const { socket } of this._peers.values()) {
      try { socket.write(frame) } catch (_) {}
    }
  }
}
