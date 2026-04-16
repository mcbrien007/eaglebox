/**
 * EagleBox Public File Index Node
 *
 * Kazaa-style design:
 *  - Filenames + metadata are PUBLIC (visible to anyone on the swarm)
 *  - File content is ENCRYPTED (you need the share key to decrypt)
 *  - Anyone can SEARCH/BROWSE the index
 *  - Only holders of the share key can DECRYPT the download
 *
 * Each sharing peer announces an "index record" on a well-known topic:
 *   topic = SHA-256("eaglebox-public-index-v1")
 *
 * Index record (broadcast as JSON over Hyperswarm):
 *   {
 *     shareCode: string,        // key — needed to decrypt
 *     filename:  string,        // PUBLIC
 *     size:      number,        // PUBLIC
 *     sha256:    string,        // PUBLIC integrity hash
 *     mimeType:  string|null,   // PUBLIC
 *     addedAt:   number,        // unix ms
 *     peerId:    string,        // hex node id
 *   }
 *
 * Protocol messages (extend network.js wire protocol):
 *   INDEX_ANNOUNCE  { type, record }          peer → all  (broadcaster pushes)
 *   INDEX_REQ       { type }                  → peer      (pull full catalogue)
 *   INDEX_RES       { type, records: [...] }  peer →      (full catalogue)
 *   SEARCH_REQ      { type, query: string }   → peer
 *   SEARCH_RES      { type, results: [...] }  peer →
 */

import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { MessageParser } from './network.js'

// Well-known topic every EagleBox node joins for public index gossip
const INDEX_TOPIC = crypto.createHash('sha256').update('eaglebox-public-index-v1').digest()

// ── IndexNode ─────────────────────────────────────────────────────────────────

export class IndexNode extends EventEmitter {
  constructor () {
    super()
    this._swarm = new Hyperswarm()
    this._records = new Map()  // shareCode → record
    this._peers = new Set()
    this._peerId = crypto.randomBytes(8).toString('hex')
    this._setupSwarm()
  }

  get peerId () { return this._peerId }

  /** All records currently known to this node. */
  get records () { return Array.from(this._records.values()) }

  // ── Setup ──────────────────────────────────────────────────────────────────

  _setupSwarm () {
    this._swarm.on('connection', (socket) => {
      const parser = new MessageParser()
      socket.on('data', (chunk) => parser.push(chunk))
      parser.on('message', (msg) => this._handleMessage(msg, socket))
      socket.on('error', () => {})
      socket.on('close', () => this._peers.delete(socket))
      this._peers.add(socket)

      // Send our full index to new peers
      this._sendTo(socket, { type: 'INDEX_RES', records: this.records })
    })
  }

  /** Join the public index swarm. */
  async join () {
    const discovery = this._swarm.join(INDEX_TOPIC, { server: true, client: true })
    await discovery.flushed()
  }

  // ── Message handling ───────────────────────────────────────────────────────

  _handleMessage (msg, fromSocket) {
    switch (msg.type) {
      case 'INDEX_ANNOUNCE':
        this._ingestRecord(msg.record)
        break

      case 'INDEX_REQ':
        this._sendTo(fromSocket, { type: 'INDEX_RES', records: this.records })
        break

      case 'INDEX_RES':
        for (const r of (msg.records || [])) this._ingestRecord(r)
        break

      case 'SEARCH_REQ': {
        const q = (msg.query || '').toLowerCase()
        const results = this.records.filter(r =>
          r.filename.toLowerCase().includes(q)
        )
        this._sendTo(fromSocket, { type: 'SEARCH_RES', results })
        break
      }

      case 'SEARCH_RES':
        this.emit('search-results', msg.results)
        break
    }
  }

  _ingestRecord (record) {
    if (!record || !record.shareCode || !record.filename) return
    const existing = this._records.get(record.shareCode)
    if (!existing || record.addedAt > existing.addedAt) {
      this._records.set(record.shareCode, record)
      this.emit('record', record)
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Announce a file to the public index.
   * Filename and size are visible to all; the shareCode is the decryption key.
   */
  announce (record) {
    const full = { ...record, peerId: this._peerId, addedAt: Date.now() }
    this._records.set(full.shareCode, full)
    this._broadcast({ type: 'INDEX_ANNOUNCE', record: full })
    this.emit('record', full)
  }

  /**
   * Search the local index by filename substring.
   */
  searchLocal (query) {
    const q = query.toLowerCase()
    return this.records.filter(r => r.filename.toLowerCase().includes(q))
  }

  /**
   * Ask connected peers to search for a query.
   */
  searchRemote (query) {
    this._broadcast({ type: 'SEARCH_REQ', query })
  }

  async destroy () {
    await this._swarm.destroy()
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _encode (obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    const hdr = Buffer.allocUnsafe(4)
    hdr.writeUInt32BE(body.length, 0)
    return Buffer.concat([hdr, body])
  }

  _sendTo (socket, obj) {
    try { socket.write(this._encode(obj)) } catch (_) {}
  }

  _broadcast (obj) {
    const frame = this._encode(obj)
    for (const s of this._peers) {
      try { s.write(frame) } catch (_) { this._peers.delete(s) }
    }
  }
}
