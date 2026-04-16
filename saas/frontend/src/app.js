/**
 * EagleBox SaaS Web App
 *
 * All crypto happens in the browser (Web Crypto API).
 * The server stores only encrypted bytes and public metadata.
 * The share code (decryption key) never touches the server.
 */

const API = 'http://localhost:3001/api'

// ── Web Crypto helpers ────────────────────────────────────────────────────────

async function generateFileKey () {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  )
}

async function exportKey (key) {
  const raw = await crypto.subtle.exportKey('raw', key)
  return new Uint8Array(raw)
}

async function importKey (raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function toBase64url (buf) {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url (s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}

async function encryptChunk (plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  const result = new Uint8Array(12 + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), 12)
  return result
}

async function decryptChunk (encrypted, key) {
  const iv = encrypted.slice(0, 12)
  const ciphertext = encrypted.slice(12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new Uint8Array(plain)
}

async function encryptMeta (meta, key) {
  const plain = new TextEncoder().encode(JSON.stringify(meta))
  return encryptChunk(plain, key)
}

async function decryptMeta (encrypted, key) {
  const plain = await decryptChunk(encrypted, key)
  return JSON.parse(new TextDecoder().decode(plain))
}

async function sha256hex (buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtBytes (b) {
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KiB'
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MiB'
  return (b / 1073741824).toFixed(2) + ' GiB'
}

function fileIcon (name) {
  const ext = (name || '').split('.').pop()?.toLowerCase()
  const m = { pdf:'📄', zip:'🗜️', tar:'🗜️', gz:'🗜️', mp4:'🎬', mkv:'🎬',
              mp3:'🎵', flac:'🎵', jpg:'🖼️', jpeg:'🖼️', png:'🖼️',
              gif:'🖼️', txt:'📝', js:'💻', ts:'💻', json:'💻', md:'📝' }
  return m[ext] || '📁'
}

// ── State ─────────────────────────────────────────────────────────────────────
const CHUNK_SIZE = 256 * 1024
let indexFiles = {}

// ── Upload ────────────────────────────────────────────────────────────────────

async function uploadFile (file, onProgress) {
  const key = await generateFileKey()
  const rawKey = await exportKey(key)
  const shareCode = toBase64url(rawKey)

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  // Read full file for hash
  const fullBuf = await file.arrayBuffer()
  const hash = await sha256hex(fullBuf)

  // Init upload on server
  const initRes = await fetch(`${API}/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name, size: file.size,
      totalChunks, sha256: hash,
      mimeType: file.type || null
    })
  }).then(r => r.json())

  if (initRes.error) throw new Error(initRes.error)
  const { shareCode: serverCode, uploadToken } = initRes

  // Encrypt + upload chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE
    const chunk = new Uint8Array(fullBuf, start, Math.min(CHUNK_SIZE, file.size - start))
    const encrypted = await encryptChunk(chunk, key)

    await fetch(`${API}/upload/${serverCode}/chunk/${i}`, {
      method: 'PUT',
      headers: { 'x-upload-token': uploadToken, 'Content-Type': 'application/octet-stream' },
      body: encrypted
    })

    onProgress(i + 1, totalChunks)
  }

  // Encrypt metadata and announce real share code to server
  const encMeta = await encryptMeta({
    filename: file.name, size: file.size, totalChunks,
    chunkSize: CHUNK_SIZE, sha256: hash
  }, key)
  const encMetaHex = Array.from(encMeta).map(b => b.toString(16).padStart(2, '0')).join('')

  await fetch(`${API}/upload/${serverCode}/announce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-upload-token': uploadToken },
    body: JSON.stringify({ clientShareCode: shareCode, encMeta: encMetaHex })
  })

  return { shareCode, filename: file.name, size: file.size }
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadFile (shareCode, onProgress) {
  const rawKey = fromBase64url(shareCode)
  const key = await importKey(rawKey)

  // Fetch encrypted metadata
  const metaRes = await fetch(`${API}/download/${shareCode}/meta`).then(r => r.json())
  if (metaRes.error) throw new Error(metaRes.error)

  const encMetaBuf = Uint8Array.from(
    metaRes.encMeta.match(/.{2}/g).map(b => parseInt(b, 16))
  )
  const meta = await decryptMeta(encMetaBuf, key)

  // Fetch + decrypt all chunks
  const chunks = []
  for (let i = 0; i < meta.totalChunks; i++) {
    const resp = await fetch(`${API}/download/${shareCode}/chunk/${i}`)
    if (!resp.ok) throw new Error(`Failed to fetch chunk ${i}`)
    const encBuf = new Uint8Array(await resp.arrayBuffer())
    const plain = await decryptChunk(encBuf, key)
    chunks.push(plain)
    onProgress(i + 1, meta.totalChunks)
  }

  // Reassemble and verify
  const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0)
  const full = new Uint8Array(totalLen)
  let offset = 0
  for (const c of chunks) { full.set(c, offset); offset += c.byteLength }

  const actualHash = await sha256hex(full.buffer)
  if (actualHash !== meta.sha256) throw new Error('Integrity check failed — file may be corrupted')

  return { blob: new Blob([full]), filename: meta.filename, size: meta.size }
}

// ── UI rendering ──────────────────────────────────────────────────────────────

function renderIndex () {
  const query = document.getElementById('search-input')?.value.toLowerCase() || ''
  const files = Object.values(indexFiles)
    .filter(f => !query || f.filename.toLowerCase().includes(query))
    .sort((a, b) => b.addedAt - a.addedAt)

  const tbody = document.getElementById('file-tbody')
  if (!tbody) return

  if (!files.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:40px">
      ${query ? 'No matches.' : 'No files shared yet. Be the first!'}</td></tr>`
    return
  }

  tbody.innerHTML = files.map(f => `
    <tr>
      <td>${fileIcon(f.filename)}</td>
      <td class="filename" title="${f.filename}">${f.filename}</td>
      <td>${fmtBytes(f.size)}</td>
      <td>${f.mimeType ? `<span class="badge">${f.mimeType.split('/')[1]}</span>` : '—'}</td>
      <td>
        <button class="btn btn-sm" onclick="triggerDownload('${f.shareCode}', '${f.filename}')">
          ⬇ Download
        </button>
      </td>
    </tr>`).join('')
}

async function triggerDownload (shareCode, filename) {
  const statusEl = document.getElementById('download-status')
  statusEl.textContent = `Downloading ${filename}…`
  statusEl.className = 'status-msg'
  try {
    const { blob, filename: fn } = await downloadFile(shareCode, (done, total) => {
      statusEl.textContent = `Decrypting… ${done}/${total} chunks`
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = fn; a.click()
    URL.revokeObjectURL(url)
    statusEl.textContent = `✅ Downloaded ${fn}`
    statusEl.className = 'status-msg success'
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`
    statusEl.className = 'status-msg error'
  }
}

// Expose for inline HTML handlers
window.triggerDownload = triggerDownload

// ── Init ──────────────────────────────────────────────────────────────────────

async function init () {
  // Load existing index
  try {
    const files = await fetch(`${API}/files`).then(r => r.json())
    for (const f of files) indexFiles[f.shareCode] = f
    renderIndex()
  } catch (err) {
    console.warn('Could not reach backend:', err.message)
    document.getElementById('file-tbody').innerHTML =
      `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">
        ⚠ Cannot connect to server (${err.message})</td></tr>`
  }

  // Live SSE feed
  const evtSource = new EventSource(`${API}/events`)
  evtSource.addEventListener('file', (e) => {
    const record = JSON.parse(e.data)
    indexFiles[record.shareCode] = record
    renderIndex()
  })

  // Upload form
  const uploadForm = document.getElementById('upload-form')
  if (uploadForm) {
    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const fileInput = document.getElementById('file-input')
      if (!fileInput.files.length) return

      const statusEl = document.getElementById('upload-status')
      const shareCodeEl = document.getElementById('upload-share-code')
      const btn = uploadForm.querySelector('button[type=submit]')
      btn.disabled = true

      for (const file of fileInput.files) {
        statusEl.textContent = `Encrypting ${file.name}…`
        statusEl.className = 'status-msg'
        try {
          const result = await uploadFile(file, (done, total) => {
            statusEl.textContent = `Uploading ${file.name}… ${done}/${total} chunks`
          })
          statusEl.textContent = `✅ Shared! Your decryption key:`
          statusEl.className = 'status-msg success'
          shareCodeEl.textContent = result.shareCode
          shareCodeEl.style.display = 'block'

          // Refresh index
          const files2 = await fetch(`${API}/files`).then(r => r.json())
          for (const f of files2) indexFiles[f.shareCode] = f
          renderIndex()
        } catch (err) {
          statusEl.textContent = `❌ Upload failed: ${err.message}`
          statusEl.className = 'status-msg error'
        }
      }
      btn.disabled = false
      fileInput.value = ''
    })
  }

  // Search
  document.getElementById('search-input')?.addEventListener('input', renderIndex)

  // Receive-by-key form
  const receiveForm = document.getElementById('receive-form')
  if (receiveForm) {
    receiveForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const code = document.getElementById('receive-code').value.trim()
      if (!code) return
      await triggerDownload(code, 'file')
    })
  }
}

// ── Web Chat ──────────────────────────────────────────────────────────────────

let webChatRoom = null
let webChatEvt  = null

async function webChatJoin () {
  const nickname = document.getElementById('web-chat-nickname').value.trim() || 'Anonymous'
  const roomId   = document.getElementById('web-chat-room').value.trim()
  const status   = document.getElementById('web-chat-join-status')

  if (!roomId) { status.textContent = 'Enter a room name'; status.className = 'status-msg error'; return }

  // Leave previous room if any
  if (webChatRoom) webChatLeave()

  webChatRoom = roomId
  window._webChatNickname = nickname

  // Subscribe to SSE
  webChatEvt = new EventSource(`${API}/chat/${encodeURIComponent(roomId)}/events`)
  webChatEvt.addEventListener('msg', (e) => {
    const msg = JSON.parse(e.data)
    webAppendMsg(msg, msg.nickname === nickname)
    updatePeerCount()
  })
  webChatEvt.onerror = () => {
    status.textContent = '⚠ Connection lost. Refresh to reconnect.'
    status.className = 'status-msg error'
  }

  // Show chat window
  document.getElementById('web-chat-window').style.display = 'block'
  document.getElementById('web-chat-room-label').textContent = '# ' + roomId
  document.getElementById('web-chat-messages').innerHTML =
    '<div id="web-chat-placeholder" style="text-align:center;color:var(--muted);font-size:12px;margin:auto">Joined! Waiting for messages…</div>'

  status.textContent = '✅ Joined #' + roomId
  status.className = 'status-msg success'

  loadRooms()
}

async function webChatLeave () {
  if (webChatEvt) { webChatEvt.close(); webChatEvt = null }
  webChatRoom = null
  document.getElementById('web-chat-window').style.display = 'none'
  document.getElementById('web-chat-join-status').textContent = ''
  loadRooms()
}

async function webChatSend () {
  const input    = document.getElementById('web-chat-input')
  const text     = input.value.trim()
  const nickname = window._webChatNickname || 'Anonymous'
  if (!text || !webChatRoom) return
  input.value = ''
  await fetch(`${API}/chat/${encodeURIComponent(webChatRoom)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, text })
  })
}

function webAppendMsg (msg, isOwn) {
  const box = document.getElementById('web-chat-messages')
  const ph  = document.getElementById('web-chat-placeholder')
  if (ph) ph.remove()

  const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const el   = document.createElement('div')
  el.style.cssText = `display:flex;flex-direction:column;align-items:${isOwn ? 'flex-end' : 'flex-start'}`
  el.innerHTML = `
    <div style="font-size:11px;color:var(--muted);margin-bottom:2px">
      ${isOwn ? '' : `<strong style="color:#38bdf8">${msg.nickname}</strong> · `}${time}
    </div>
    <div style="
      background:${isOwn ? '#38bdf8' : '#1e293b'};
      color:${isOwn ? '#0f172a' : '#e2e8f0'};
      border:1px solid ${isOwn ? 'transparent' : '#334155'};
      border-radius:${isOwn ? '12px 12px 2px 12px' : '12px 12px 12px 2px'};
      padding:8px 12px;max-width:320px;word-break:break-word;font-size:13px">
      ${msg.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
    </div>`
  box.appendChild(el)
  box.scrollTop = box.scrollHeight
}

async function loadRooms () {
  try {
    const rooms = await fetch(`${API}/chat/rooms`).then(r => r.json())
    const el    = document.getElementById('web-rooms-list')
    const countEl = document.getElementById('chat-room-count')
    if (countEl) countEl.textContent = rooms.length + ' room' + (rooms.length !== 1 ? 's' : '')
    if (!el) return
    if (!rooms.length) { el.textContent = 'No active rooms yet.'; return }
    el.innerHTML = rooms.map(r => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;
                  border-bottom:1px solid #334155">
        <span style="width:7px;height:7px;border-radius:50%;background:#34d399;display:inline-block"></span>
        <strong># ${r.roomId}</strong>
        <span style="color:#64748b;font-size:12px;margin-left:auto">${r.peers} peer${r.peers !== 1 ? 's' : ''}</span>
        <button class="btn-sm" onclick="quickJoin('${r.roomId}')"
                style="font-size:11px;padding:3px 8px;background:transparent;
                       border:1px solid #334155;color:#e2e8f0;border-radius:4px;cursor:pointer">
          Join
        </button>
      </div>`).join('')
  } catch (_) {}
}

async function quickJoin (roomId) {
  document.getElementById('web-chat-room').value = roomId
  webChatJoin()
}

function updatePeerCount () {
  // approximate: count distinct nicknames in current history
}

// Expose for inline HTML onclick handlers
window.webChatJoin  = webChatJoin
window.webChatLeave = webChatLeave
window.webChatSend  = webChatSend
window.loadRooms    = loadRooms
window.quickJoin    = quickJoin

document.addEventListener('DOMContentLoaded', init)
