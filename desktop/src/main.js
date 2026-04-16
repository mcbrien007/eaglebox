/**
 * EagleBox Desktop — Electron Main Process
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { randomUUID } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.argv.includes('--dev')

// ── Lazy-loaded core ──────────────────────────────────────────────────────────
let FileSender, FileReceiver, IndexNode, SwarmManager, ChatRoom, generateIdentityKeypair

async function loadCore () {
  const corePath = path.join(__dirname, '../../src/core/index.js')
  const core = await import(corePath)
  FileSender = core.FileSender
  FileReceiver = core.FileReceiver
  IndexNode = core.IndexNode
  SwarmManager = core.SwarmManager
  ChatRoom = core.ChatRoom
  generateIdentityKeypair = core.generateIdentityKeypair
}

// ── Active state ──────────────────────────────────────────────────────────────
const activeSenders   = new Map()   // shareCode  → { sender, swarm }
const activeReceivers = new Map()   // transferId → { receiver, swarm }
const activeChats     = new Map()   // roomId     → ChatRoom instance
let indexNode = null
let mainWindow = null

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 780,
    minWidth: 850,
    minHeight: 620,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),   // CJS preload
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  if (isDev) mainWindow.webContents.openDevTools()
  mainWindow.on('closed', () => { mainWindow = null })
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await loadCore()
  createWindow()

  indexNode = new IndexNode()
  await indexNode.join()
  indexNode.on('record', (record) => {
    mainWindow?.webContents.send('index:record', record)
  })
})

app.on('window-all-closed', async () => {
  await indexNode?.destroy()
  for (const { swarm } of activeSenders.values())   await swarm?.destroy()
  for (const { swarm } of activeReceivers.values()) await swarm?.destroy()
  for (const room of activeChats.values())          await room?.destroy()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => { if (!mainWindow) createWindow() })

// ── IPC: Dialogs ──────────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] })
  return r.canceled ? [] : r.filePaths
})

ipcMain.handle('dialog:saveDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

// ── IPC: Send ─────────────────────────────────────────────────────────────────

ipcMain.handle('send:start', async (_e, { filePath }) => {
  const sender = new FileSender(filePath)
  await sender.prepare()
  const swarm = new SwarmManager()
  await swarm.joinAsSender(sender.shareCode)
  activeSenders.set(sender.shareCode, { sender, swarm })

  indexNode?.announce({
    shareCode: sender.shareCode,
    filename: sender.meta.filename,
    size: sender.meta.size,
    sha256: sender.meta.sha256,
    mimeType: guessMime(sender.meta.filename)
  })

  swarm.on('peer', async (conn) => {
    mainWindow?.webContents.send('send:peer-connected', { shareCode: sender.shareCode })
    try {
      await sender.handlePeer(conn, (done, total) => {
        mainWindow?.webContents.send('send:progress', { shareCode: sender.shareCode, done, total })
      })
      mainWindow?.webContents.send('send:peer-done', { shareCode: sender.shareCode })
    } catch (err) {
      mainWindow?.webContents.send('send:error', { shareCode: sender.shareCode, message: err.message })
    }
  })

  return { shareCode: sender.shareCode, filename: sender.meta.filename,
           size: sender.meta.size, totalChunks: sender.meta.totalChunks }
})

ipcMain.handle('send:stop', async (_e, { shareCode }) => {
  const entry = activeSenders.get(shareCode)
  if (entry) { await entry.swarm?.destroy(); activeSenders.delete(shareCode) }
})

// ── IPC: Receive ──────────────────────────────────────────────────────────────

ipcMain.handle('receive:start', async (_e, { shareCode, destDir }) => {
  const transferId = randomUUID()
  const receiver = new FileReceiver(shareCode, destDir)
  const swarm = new SwarmManager()
  activeReceivers.set(transferId, { receiver, swarm })
  await swarm.joinAsReceiver(shareCode)

  swarm.on('peer', async (conn) => {
    try {
      const outPath = await receiver.receiveFrom(conn, (done, total) => {
        mainWindow?.webContents.send('receive:progress', { transferId, done, total })
      })
      mainWindow?.webContents.send('receive:done', { transferId, outPath, meta: receiver.meta })
      await swarm.destroy()
      activeReceivers.delete(transferId)
    } catch (err) {
      mainWindow?.webContents.send('receive:error', { transferId, message: err.message })
    }
  })

  setTimeout(async () => {
    if (activeReceivers.has(transferId)) {
      mainWindow?.webContents.send('receive:error', { transferId, message: 'Timed out — sender not found' })
      await swarm.destroy()
      activeReceivers.delete(transferId)
    }
  }, 60_000)

  return { transferId }
})

// ── IPC: Index ────────────────────────────────────────────────────────────────

ipcMain.handle('index:getAll', () => indexNode?.records ?? [])
ipcMain.handle('index:search', (_e, { query }) => {
  indexNode?.searchRemote(query)
  return indexNode?.searchLocal(query) ?? []
})

// ── IPC: Chat ─────────────────────────────────────────────────────────────────

ipcMain.handle('chat:join', async (_e, { roomId, nickname }) => {
  if (activeChats.has(roomId)) return { ok: true }
  const room = new ChatRoom(roomId, nickname)
  await room.join()
  activeChats.set(roomId, room)

  room.on('message', (msg) => {
    mainWindow?.webContents.send('chat:message', { roomId, ...msg })
  })
  room.on('peer-joined', (info) => {
    mainWindow?.webContents.send('chat:peer-joined', { roomId, ...info })
  })
  room.on('peer-left', (info) => {
    mainWindow?.webContents.send('chat:peer-left', { roomId, ...info })
  })
  return { ok: true }
})

ipcMain.handle('chat:send', async (_e, { roomId, text }) => {
  const room = activeChats.get(roomId)
  if (!room) return { error: 'Not in room' }
  room.sendMessage(text)
  return { ok: true }
})

ipcMain.handle('chat:leave', async (_e, { roomId }) => {
  const room = activeChats.get(roomId)
  if (room) { await room.destroy(); activeChats.delete(roomId) }
  return { ok: true }
})

ipcMain.handle('chat:listRooms', () => {
  return indexNode?.chatRooms ?? []
})

// ── IPC: Keygen ───────────────────────────────────────────────────────────────

ipcMain.handle('keygen', () => {
  const { publicKey, privateKey } = generateIdentityKeypair()
  return { publicKey: publicKey.toString('hex'), privateKey: privateKey.toString('hex') }
})

ipcMain.handle('shell:showInFolder', (_e, { filePath }) => {
  shell.showItemInFolder(filePath)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function guessMime (filename) {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map = {
    pdf:'application/pdf', zip:'application/zip', tar:'application/x-tar',
    gz:'application/gzip', mp4:'video/mp4', mkv:'video/x-matroska',
    mp3:'audio/mpeg', flac:'audio/flac', jpg:'image/jpeg', jpeg:'image/jpeg',
    png:'image/png', gif:'image/gif', txt:'text/plain', js:'text/javascript',
    ts:'text/typescript', json:'application/json', md:'text/markdown'
  }
  return map[ext] || null
}
