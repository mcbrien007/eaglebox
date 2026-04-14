/**
 * EagleBox SaaS Backend
 *
 * Provides:
 *  1. HTTP REST API for upload/download (for web clients that can't use raw P2P)
 *  2. Public file index (Kazaa-style) via HTTP + SSE live feed
 *  3. P2P relay node — joins the Hyperswarm index swarm and mirrors records to HTTP
 *
 * File storage model:
 *  - Encrypted chunks are stored on-disk in uploads/<shareCode>/chunk-<N>
 *  - Metadata is stored as uploads/<shareCode>/meta.json (public filename, size, etc.)
 *  - The plaintext is NEVER stored — only the encrypted bytes arrive from the client
 *  - Share codes (decryption keys) are never stored on the server
 *
 * API:
 *  POST   /api/upload/init          { filename, size, totalChunks, sha256, mimeType }
 *                                   → { shareCode, uploadToken }
 *  PUT    /api/upload/:shareCode/chunk/:index
 *                                   body: raw encrypted chunk bytes
 *  GET    /api/files                → [{ shareCode, filename, size, mimeType, addedAt }]
 *  GET    /api/files/search?q=      → filtered list
 *  GET    /api/download/:shareCode/meta
 *                                   → encrypted metadata buffer (hex)
 *  GET    /api/download/:shareCode/chunk/:index
 *                                   → raw encrypted chunk bytes
 *  GET    /api/events               SSE stream of new file announcements
 */

import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { IndexNode } from '../../../src/core/index-node.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.join(__dirname, '../uploads')
const PORT = process.env.PORT || 3001
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024  // 5 GiB per file
const SHARE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

fs.mkdirSync(UPLOADS_DIR, { recursive: true })

const app = express()
app.use(cors())
app.use(express.json())

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set()

function broadcastSSE (event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try { res.write(payload) } catch (_) { sseClients.delete(res) }
  }
}

// ── In-memory file index ──────────────────────────────────────────────────────
// shareCode → { filename, size, mimeType, sha256, addedAt, totalChunks, uploadToken, chunksReceived }
const fileIndex = new Map()

function loadPersistedIndex () {
  try {
    const dirs = fs.readdirSync(UPLOADS_DIR)
    for (const sc of dirs) {
      const metaPath = path.join(UPLOADS_DIR, sc, 'meta.json')
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        if (Date.now() - meta.addedAt < SHARE_EXPIRY_MS) {
          fileIndex.set(sc, meta)
        } else {
          // Expired — clean up
          fs.rmSync(path.join(UPLOADS_DIR, sc), { recursive: true, force: true })
        }
      }
    }
    console.log(`Loaded ${fileIndex.size} file(s) from disk`)
  } catch (err) {
    console.warn('Could not load persisted index:', err.message)
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', files: fileIndex.size, ts: Date.now() })
})

// ── Upload: init ──────────────────────────────────────────────────────────────
app.post('/api/upload/init', (req, res) => {
  const { filename, size, totalChunks, sha256, mimeType } = req.body
  if (!filename || !size || !totalChunks || !sha256) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  if (size > MAX_FILE_SIZE) {
    return res.status(413).json({ error: 'File too large (max 5 GiB)' })
  }

  // Server generates a random shareCode placeholder (the actual key is held client-side)
  // The shareCode here is just used as a directory name — it is NOT the decryption key
  const shareCode = uuidv4().replace(/-/g, '')
  const uploadToken = uuidv4()
  const addedAt = Date.now()

  const record = {
    filename, size, totalChunks, sha256, mimeType: mimeType || null,
    addedAt, uploadToken, chunksReceived: 0, complete: false,
    // The real shareCode (decryption key) is set by the client after upload
    clientShareCode: null
  }
  fileIndex.set(shareCode, record)
  fs.mkdirSync(path.join(UPLOADS_DIR, shareCode), { recursive: true })

  res.json({ shareCode, uploadToken })
})

// ── Upload: announce real share code after upload ─────────────────────────────
app.post('/api/upload/:shareCode/announce', (req, res) => {
  const record = fileIndex.get(req.params.shareCode)
  if (!record) return res.status(404).json({ error: 'Not found' })
  if (record.uploadToken !== req.headers['x-upload-token']) {
    return res.status(403).json({ error: 'Invalid upload token' })
  }
  const { clientShareCode, encMeta } = req.body
  if (!clientShareCode || !encMeta) return res.status(400).json({ error: 'Missing fields' })

  record.clientShareCode = clientShareCode
  record.encMeta = encMeta  // hex-encoded encrypted metadata blob
  record.complete = record.chunksReceived >= record.totalChunks

  // Persist
  const metaPath = path.join(UPLOADS_DIR, req.params.shareCode, 'meta.json')
  fs.writeFileSync(metaPath, JSON.stringify(record))

  // Broadcast to SSE subscribers
  broadcastSSE('file', {
    shareCode: record.clientShareCode,
    filename: record.filename,
    size: record.size,
    mimeType: record.mimeType,
    addedAt: record.addedAt
  })

  // Also announce on P2P swarm if node is running
  p2pIndexNode?.announce({
    shareCode: record.clientShareCode,
    filename: record.filename,
    size: record.size,
    sha256: record.sha256,
    mimeType: record.mimeType
  })

  res.json({ ok: true })
})

// ── Upload: chunk ─────────────────────────────────────────────────────────────
app.put('/api/upload/:shareCode/chunk/:index', (req, res) => {
  const record = fileIndex.get(req.params.shareCode)
  if (!record) return res.status(404).json({ error: 'Not found' })
  if (record.uploadToken !== req.headers['x-upload-token']) {
    return res.status(403).json({ error: 'Invalid upload token' })
  }

  const index = parseInt(req.params.index, 10)
  if (isNaN(index) || index < 0 || index >= record.totalChunks) {
    return res.status(400).json({ error: 'Invalid chunk index' })
  }

  const chunkPath = path.join(UPLOADS_DIR, req.params.shareCode, `chunk-${index}`)
  const chunks = []
  req.on('data', d => chunks.push(d))
  req.on('end', () => {
    fs.writeFileSync(chunkPath, Buffer.concat(chunks))
    record.chunksReceived++
    res.json({ ok: true, received: record.chunksReceived, total: record.totalChunks })
  })
  req.on('error', (err) => res.status(500).json({ error: err.message }))
})

// ── Download: encrypted metadata ─────────────────────────────────────────────
app.get('/api/download/:shareCode/meta', (req, res) => {
  // Look up by client share code
  const record = findByClientCode(req.params.shareCode)
  if (!record) return res.status(404).json({ error: 'Not found' })
  if (!record.encMeta) return res.status(404).json({ error: 'Metadata not yet available' })

  res.json({ encMeta: record.encMeta })
})

// ── Download: chunk ───────────────────────────────────────────────────────────
app.get('/api/download/:shareCode/chunk/:index', (req, res) => {
  const record = findByClientCode(req.params.shareCode)
  if (!record) return res.status(404).json({ error: 'Not found' })

  const index = parseInt(req.params.index, 10)
  const chunkPath = path.join(UPLOADS_DIR, record._serverCode, `chunk-${index}`)
  if (!fs.existsSync(chunkPath)) return res.status(404).json({ error: 'Chunk not found' })

  res.setHeader('Content-Type', 'application/octet-stream')
  fs.createReadStream(chunkPath).pipe(res)
})

// ── Public index ──────────────────────────────────────────────────────────────
app.get('/api/files', (_req, res) => {
  const files = publicRecords()
  res.json(files)
})

app.get('/api/files/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase()
  const results = publicRecords().filter(f => f.filename.toLowerCase().includes(q))
  res.json(results)
})

// ── SSE live feed ─────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  sseClients.add(res)
  res.write(': connected\n\n')

  // Send current index snapshot
  for (const f of publicRecords()) {
    res.write(`event: file\ndata: ${JSON.stringify(f)}\n\n`)
  }

  req.on('close', () => sseClients.delete(res))
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function findByClientCode (clientShareCode) {
  for (const [serverCode, record] of fileIndex.entries()) {
    if (record.clientShareCode === clientShareCode) {
      record._serverCode = serverCode
      return record
    }
  }
  return null
}

function publicRecords () {
  return Array.from(fileIndex.values())
    .filter(r => r.complete && r.clientShareCode)
    .map(r => ({
      shareCode: r.clientShareCode,
      filename: r.filename,
      size: r.size,
      mimeType: r.mimeType,
      addedAt: r.addedAt
    }))
    .sort((a, b) => b.addedAt - a.addedAt)
}

// ── P2P index node ────────────────────────────────────────────────────────────
let p2pIndexNode = null

async function startP2PNode () {
  try {
    p2pIndexNode = new IndexNode()
    await p2pIndexNode.join()
    console.log('P2P index node joined swarm')

    // Mirror P2P records into our HTTP index
    p2pIndexNode.on('record', (record) => {
      broadcastSSE('file', record)
    })
  } catch (err) {
    console.warn('P2P node failed to start (running HTTP-only):', err.message)
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
loadPersistedIndex()
startP2PNode()

app.listen(PORT, () => {
  console.log(`EagleBox SaaS backend listening on http://localhost:${PORT}`)
})
