/**
 * EagleBox Transfer Module
 *
 * Sender side  – reads a file, splits it into chunks, encrypts each chunk,
 *                serves them on demand to connected peers.
 *
 * Receiver side – requests metadata then requests chunks sequentially,
 *                 decrypts them, and reassembles the file.
 *
 * Chunk layout (encrypted wire bytes):
 *   encryptChunk([IV][tag][ciphertext])  (see crypto.js)
 *
 * Metadata object:
 *   {
 *     filename: string,
 *     size: number,          // original file size in bytes
 *     chunkSize: number,     // plaintext chunk size
 *     totalChunks: number,
 *     sha256: string,        // hex hash of full plaintext
 *   }
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
  sha256
} from './crypto.js'

const DEFAULT_CHUNK_SIZE = 256 * 1024  // 256 KiB

// ── Sender ────────────────────────────────────────────────────────────────────

export class FileSender {
  /**
   * @param {string} filePath  absolute or relative path to the file
   * @param {object} opts
   * @param {number} [opts.chunkSize]
   */
  constructor (filePath, opts = {}) {
    this.filePath = path.resolve(filePath)
    this.chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE
    this.key = generateFileKey()
    this.shareCode = keyToShareCode(this.key)
    this._meta = null
    this._encMeta = null
    this._fileSize = 0
    this._totalChunks = 0
  }

  /** Prepare metadata (must be called before serving). */
  async prepare () {
    const stat = fs.statSync(this.filePath)
    this._fileSize = stat.size
    this._totalChunks = Math.ceil(this._fileSize / this.chunkSize)

    // Compute full-file hash for integrity verification
    const fileBuffer = fs.readFileSync(this.filePath)
    const hash = sha256(fileBuffer).toString('hex')

    this._meta = {
      filename: path.basename(this.filePath),
      size: this._fileSize,
      chunkSize: this.chunkSize,
      totalChunks: this._totalChunks,
      sha256: hash
    }
    this._encMeta = encryptMetadata(this._meta, this.key)
  }

  get encryptedMetadata () {
    if (!this._encMeta) throw new Error('Call prepare() first')
    return this._encMeta
  }

  get meta () { return this._meta }

  /**
   * Read, encrypt, and return chunk at index.
   * @param {number} index
   * @returns {Buffer}
   */
  getEncryptedChunk (index) {
    if (!this._meta) throw new Error('Call prepare() first')
    if (index < 0 || index >= this._totalChunks) {
      throw new RangeError(`Chunk index ${index} out of range (0–${this._totalChunks - 1})`)
    }
    const start = index * this.chunkSize
    const end = Math.min(start + this.chunkSize, this._fileSize)
    const buf = Buffer.allocUnsafe(end - start)
    const fd = fs.openSync(this.filePath, 'r')
    fs.readSync(fd, buf, 0, end - start, start)
    fs.closeSync(fd)
    return encryptChunk(buf, this.key)
  }

  /**
   * Handle an incoming PeerConnection in sender role.
   * Drives the conversation until done or error.
   *
   * @param {import('./network.js').PeerConnection} conn
   * @param {function(number, number): void} [onProgress]  called with (received, total)
   */
  async handlePeer (conn, onProgress) {
    await this.prepare()

    const send = (obj) => conn.send(obj)

    // Send HELLO
    await send({ type: 'HELLO', version: 1 })

    return new Promise((resolve, reject) => {
      conn.on('message', async (msg) => {
        try {
          switch (msg.type) {
            case 'HELLO':
              // peer identified; wait for META_REQ
              break

            case 'META_REQ': {
              await send({
                type: 'META_RES',
                encMeta: this._encMeta.toString('hex')
              })
              break
            }

            case 'CHUNK_REQ': {
              const { index } = msg
              const encChunk = this.getEncryptedChunk(index)
              await send({
                type: 'CHUNK_RES',
                index,
                data: encChunk.toString('hex')
              })
              if (onProgress) onProgress(index + 1, this._totalChunks)
              break
            }

            case 'DONE':
              resolve()
              conn.destroy()
              break

            case 'ERROR':
              reject(new Error('Peer error: ' + msg.message))
              conn.destroy()
              break

            default:
              // ignore unknown message types
          }
        } catch (err) {
          await send({ type: 'ERROR', message: err.message }).catch(() => {})
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
   * @param {string} shareCode  base64url-encoded file key
   * @param {string} destDir    directory to save the file into
   */
  constructor (shareCode, destDir = '.') {
    this.shareCode = shareCode
    this.key = shareCodeToKey(shareCode)
    this.destDir = path.resolve(destDir)
    this.meta = null
    this.outputPath = null
  }

  /**
   * Drive the conversation with a sender peer and save the file to destDir.
   *
   * @param {import('./network.js').PeerConnection} conn
   * @param {function(number, number): void} [onProgress]
   */
  async receiveFrom (conn, onProgress) {
    const chunks = []
    let meta = null

    // Send HELLO
    await conn.send({ type: 'HELLO', version: 1 })

    return new Promise((resolve, reject) => {
      conn.on('message', async (msg) => {
        try {
          switch (msg.type) {
            case 'HELLO':
              // sender ready; request metadata
              await conn.send({ type: 'META_REQ' })
              break

            case 'META_RES': {
              const encMeta = Buffer.from(msg.encMeta, 'hex')
              meta = decryptMetadata(encMeta, this.key)
              this.meta = meta
              this.outputPath = path.join(this.destDir, meta.filename)
              // Start requesting chunks
              if (meta.totalChunks === 0) {
                // Empty file
                fs.writeFileSync(this.outputPath, Buffer.alloc(0))
                await conn.send({ type: 'DONE' })
                resolve(this.outputPath)
              } else {
                await conn.send({ type: 'CHUNK_REQ', index: 0 })
              }
              break
            }

            case 'CHUNK_RES': {
              const { index, data } = msg
              const encChunk = Buffer.from(data, 'hex')
              const plainChunk = decryptChunk(encChunk, this.key)
              chunks[index] = plainChunk
              if (onProgress) onProgress(index + 1, meta.totalChunks)

              const nextIndex = index + 1
              if (nextIndex < meta.totalChunks) {
                await conn.send({ type: 'CHUNK_REQ', index: nextIndex })
              } else {
                // All chunks received — assemble and verify
                const full = Buffer.concat(chunks)
                const actualHash = sha256(full).toString('hex')
                if (actualHash !== meta.sha256) {
                  throw new Error(
                    `Integrity check failed!\n  expected: ${meta.sha256}\n  got:      ${actualHash}`
                  )
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

            default:
              // ignore
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
