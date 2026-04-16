/**
 * EagleBox Transfer Module
 *
 * Encryption modes (per file):
 *  - encrypted (default) — AES-256-GCM, receiver needs the share key
 *  - public              — no encryption, anyone can download freely
 *
 * Metadata object:
 *   {
 *     filename: string,
 *     size: number,
 *     chunkSize: number,
 *     totalChunks: number,
 *     sha256: string,
 *     public: boolean,   // true = no key required
 *   }
 *
 * Wire protocol additions:
 *   META_RES now includes `public: true` flag when unencrypted.
 *   CHUNK_RES `data` field is raw hex plaintext when public mode.
 *   FileReceiver detects public mode from META_RES and skips decryption.
 *
 * Share code for public files:
 *   "PUBLIC" — a well-known sentinel; no real key needed.
 *   The Hyperswarm topic is still derived from a random ID so the sender
 *   can be found, but no decryption step happens on the receiver side.
 */

import fs from 'fs'
import path from 'path'
import {
  generateFileKey,
  keyToShareCode,
  shareCodeToKey,
  encryptChunk,
  decryptChunk,
  encryptMetadata,
  decryptMetadata,
  sha256,
  shareCodeToTopic
} from './crypto.js'
import crypto from 'crypto'

const DEFAULT_CHUNK_SIZE = 256 * 1024  // 256 KiB
export const PUBLIC_SHARE_SENTINEL = 'PUBLIC'

// ── Sender ────────────────────────────────────────────────────────────────────

export class FileSender {
  /**
   * @param {string} filePath
   * @param {object} opts
   * @param {number}  [opts.chunkSize]
   * @param {boolean} [opts.public=false]  Set true to share without encryption
   */
  constructor (filePath, opts = {}) {
    this.filePath  = path.resolve(filePath)
    this.chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE
    this.isPublic  = opts.public === true

    if (this.isPublic) {
      // Public files use a random topic ID (not a real key) so peers can find them
      this._topicId  = crypto.randomBytes(32)
      this.key       = null
      this.shareCode = PUBLIC_SHARE_SENTINEL + ':' + this._topicId.toString('base64url')
    } else {
      this.key       = generateFileKey()
      this.shareCode = keyToShareCode(this.key)
      this._topicId  = null
    }

    this._meta        = null
    this._metaPayload = null   // encrypted or plain JSON buffer
    this._fileSize    = 0
    this._totalChunks = 0
  }

  /** Prepare metadata. Must be called before serving. */
  async prepare () {
    const stat = fs.statSync(this.filePath)
    this._fileSize    = stat.size
    this._totalChunks = Math.ceil(this._fileSize / this.chunkSize) || 1

    const fileBuffer = fs.readFileSync(this.filePath)
    const hash = sha256(fileBuffer).toString('hex')

    this._meta = {
      filename:    path.basename(this.filePath),
      size:        this._fileSize,
      chunkSize:   this.chunkSize,
      totalChunks: this._totalChunks,
      sha256:      hash,
      public:      this.isPublic
    }

    if (this.isPublic) {
      // Metadata sent as plain JSON (no encryption)
      this._metaPayload = Buffer.from(JSON.stringify(this._meta), 'utf8')
    } else {
      this._metaPayload = encryptMetadata(this._meta, this.key)
    }
  }

  get meta () { return this._meta }

  /** Return the raw topic buffer for Hyperswarm. */
  get topic () {
    if (this.isPublic) return this._topicId
    // Derive topic from share code (same as crypto.shareCodeToTopic)
    return shareCodeToTopic(this.shareCode)
  }

  /** Read chunk at index, encrypt if needed, return Buffer. */
  getChunk (index) {
    if (!this._meta) throw new Error('Call prepare() first')
    const start = index * this.chunkSize
    const end   = Math.min(start + this.chunkSize, this._fileSize)
    const buf   = Buffer.allocUnsafe(end - start)
    const fd    = fs.openSync(this.filePath, 'r')
    fs.readSync(fd, buf, 0, end - start, start)
    fs.closeSync(fd)
    return this.isPublic ? buf : encryptChunk(buf, this.key)
  }

  /** Handle a peer connection (sender role). */
  async handlePeer (conn, onProgress) {
    await this.prepare()
    await conn.send({ type: 'HELLO', version: 1 })

    return new Promise((resolve, reject) => {
      conn.on('message', async (msg) => {
        try {
          switch (msg.type) {
            case 'HELLO': break

            case 'META_REQ':
              await conn.send({
                type:    'META_RES',
                payload: this._metaPayload.toString('hex'),
                public:  this.isPublic
              })
              break

            case 'CHUNK_REQ': {
              const chunk = this.getChunk(msg.index)
              await conn.send({ type: 'CHUNK_RES', index: msg.index, data: chunk.toString('hex') })
              if (onProgress) onProgress(msg.index + 1, this._totalChunks)
              break
            }

            case 'DONE':   resolve(); conn.destroy(); break
            case 'ERROR':  reject(new Error('Peer error: ' + msg.message)); conn.destroy(); break
          }
        } catch (err) {
          await conn.send({ type: 'ERROR', message: err.message }).catch(() => {})
          reject(err)
          conn.destroy()
        }
      })

      conn.on('error', reject)
      conn.on('close', resolve)
    })
  }
}

// ── Receiver ──────────────────────────────────────────────────────────────────

export class FileReceiver {
  /**
   * @param {string} shareCode  key (base64url) OR "PUBLIC:<topicId>"
   * @param {string} destDir
   */
  constructor (shareCode, destDir = '.') {
    this.shareCode = shareCode
    this.destDir   = path.resolve(destDir)
    this.meta      = null
    this.outputPath = null

    this.isPublic = shareCode.startsWith(PUBLIC_SHARE_SENTINEL + ':')
    this.key      = this.isPublic ? null : shareCodeToKey(shareCode)
  }

  async receiveFrom (conn, onProgress) {
    const chunks = []
    let meta = null

    await conn.send({ type: 'HELLO', version: 1 })

    return new Promise((resolve, reject) => {
      conn.on('message', async (msg) => {
        try {
          switch (msg.type) {
            case 'HELLO':
              await conn.send({ type: 'META_REQ' })
              break

            case 'META_RES': {
              const payloadBuf = Buffer.from(msg.payload, 'hex')

              if (msg.public) {
                // Plain JSON metadata
                meta = JSON.parse(payloadBuf.toString('utf8'))
              } else {
                if (!this.key) throw new Error('Share key required for encrypted file')
                meta = decryptMetadata(payloadBuf, this.key)
              }

              this.meta = meta
              this.outputPath = path.join(this.destDir, meta.filename)

              if (meta.totalChunks === 0) {
                fs.mkdirSync(this.destDir, { recursive: true })
                fs.writeFileSync(this.outputPath, Buffer.alloc(0))
                await conn.send({ type: 'DONE' })
                resolve(this.outputPath)
              } else {
                await conn.send({ type: 'CHUNK_REQ', index: 0 })
              }
              break
            }

            case 'CHUNK_RES': {
              const rawBuf = Buffer.from(msg.data, 'hex')
              const plain  = (meta.public || this.isPublic)
                ? rawBuf
                : decryptChunk(rawBuf, this.key)

              chunks[msg.index] = plain
              if (onProgress) onProgress(msg.index + 1, meta.totalChunks)

              const next = msg.index + 1
              if (next < meta.totalChunks) {
                await conn.send({ type: 'CHUNK_REQ', index: next })
              } else {
                const full = Buffer.concat(chunks)
                const actualHash = sha256(full).toString('hex')
                if (actualHash !== meta.sha256) {
                  throw new Error(`Integrity check failed!\n  expected: ${meta.sha256}\n  got: ${actualHash}`)
                }
                fs.mkdirSync(this.destDir, { recursive: true })
                fs.writeFileSync(this.outputPath, full)
                await conn.send({ type: 'DONE' })
                resolve(this.outputPath)
              }
              break
            }

            case 'ERROR':
              reject(new Error('Sender error: ' + msg.message))
              conn.destroy()
              break
          }
        } catch (err) {
          await conn.send({ type: 'ERROR', message: err.message }).catch(() => {})
          reject(err)
          conn.destroy()
        }
      })

      conn.on('error', reject)
      conn.on('close', () => {
        if (!meta) reject(new Error('Connection closed before transfer completed'))
      })
    })
  }
}
