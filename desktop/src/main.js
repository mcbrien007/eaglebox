/**
 * EagleBox Desktop — Electron Main Process
 *
 * Responsibilities:
 *  - Create/manage BrowserWindow
 *  - Bridge IPC calls from renderer to core (FileSender, FileReceiver, IndexNode)
 *  - Handle native file dialogs
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.argv.includes('--dev')

// ── Lazy-loaded core (Node.js modules, not safe in renderer) ──────────────────
let FileSender, FileReceiver, IndexNode, SwarmManager, generateIdentityKeypair

async function loadCore () {
  const corePath = path.join(__dirname, '../../src/core/index.js')
  const core = await import(corePath)
  FileSender = core.FileSender
  FileReceiver = core.FileReceiver
  IndexNode = core.IndexNode
  SwarmManager = core.SwarmManager
  generateIdentityKeypair = core.generateIdentityKeypair
}

// ── Active transfers registry ─────────────────────────────────────────────────
const activeSenders = new Map()    // shareCode → { sender, swarm }
const activeReceivers = new Map()  // transferId → { receiver, swarm }
let indexNode = null

// ── Window ────────────────────────────────────────────────────────────────────

let mainWindow = null

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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

  // Join public index swarm on startup
  indexNode = new IndexNode()
  await indexNode.join()

  indexNode.on('record', (record) => {
    mainWindow?.webContents.send('index:record', record)
  })
})

app.on('window-all-closed', async () => {
  await indexNode?.destroy()
  for (const { swarm } of activeSenders.values()) await swarm?.destroy()
  for (const { swarm } of activeReceivers.values()) await swarm?.destroy()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

// ── IPC: File dialogs ─────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections']
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('dialog:saveDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

// ── IPC: Send ─────────────────────────────────────────────────────────────────

ipcMain.handle('send:start', async (_event, { filePath }) => {
  const sender = new FileSender(filePath)
  await sender.prepare()

  const swarm = new SwarmManager()
  await swarm.joinAsSender(sender.shareCode)
  activeSenders.set(sender.shareCode, { sender, swarm })

  // Announce to public index (filename visible, key required for decrypt)
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

  return {
    shareCode: sender.shareCode,
    filename: sender.meta.filename,
    size: sender.meta.size,
    totalChunks: sender.meta.totalChunks
  }
})

ipcMain.handle('send:stop', async (_event, { shareCode }) => {
  const entry = activeSenders.get(shareCode)
  if (entry) {
    await entry.swarm?.destroy()
    activeSenders.delete(shareCode)
  }
})

// ── IPC: Receive ──────────────────────────────────────────────────────────────

ipcMain.handle('receive:start', async (_event, { shareCode, destDir }) => {
  const transferId = crypto.randomUUID()
  const receiver = new FileReceiver(shareCode, destDir)
  const swarm = new SwarmManager()
  activeReceivers.set(transferId, { receiver, swarm })

  await swarm.joinAsReceiver(shareCode)

  swarm.on('peer', async (conn) => {
    try {
      const outPath = await receiver.receiveFrom(conn, (done, total) => {
        mainWindow?.webContents.send('receive:progress', { transferId, done, total })
      })
      mainWindow?.webContents.send('receive:done', {
        transferId,
        outPath,
        meta: receiver.meta
      })
      await swarm.destroy()
      activeReceivers.delete(transferId)
    } catch (err) {
      mainWindow?.webContents.send('receive:error', { transferId, message: err.message })
    }
  })

  // Timeout
  setTimeout(async () => {
    if (activeReceivers.has(transferId)) {
      mainWindow?.webContents.send('receive:error', {
        transferId,
        message: 'Timed out — sender not found'
      })
      await swarm.destroy()
      activeReceivers.delete(transferId)
    }
  }, 60_000)

  return { transferId }
})

// ── IPC: Index / Search ───────────────────────────────────────────────────────

ipcMain.handle('index:getAll', () => indexNode?.records ?? [])

ipcMain.handle('index:search', (_event, { query }) => {
  indexNode?.searchRemote(query)
  return indexNode?.searchLocal(query) ?? []
})

// ── IPC: Keygen ───────────────────────────────────────────────────────────────

ipcMain.handle('keygen', () => {
  const { publicKey, privateKey } = generateIdentityKeypair()
  return {
    publicKey: publicKey.toString('hex'),
    privateKey: privateKey.toString('hex')
  }
})

// ── IPC: Open in explorer ──────────────────────────────────────────────────────

ipcMain.handle('shell:showInFolder', (_event, { filePath }) => {
  shell.showItemInFolder(filePath)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function guessMime (filename) {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map = {
    pdf: 'application/pdf', zip: 'application/zip', tar: 'application/x-tar',
    gz: 'application/gzip', mp4: 'video/mp4', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', flac: 'audio/flac', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', txt: 'text/plain', js: 'text/javascript',
    ts: 'text/typescript', json: 'application/json', md: 'text/markdown'
  }
  return map[ext] || null
}
