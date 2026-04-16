/**
 * EagleBox Desktop — Electron Main Process
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { randomUUID } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.argv.includes('--dev')

// ── Lazy-loaded core (bundled inside desktop/core/) ───────────────────────────
let FileSender, FileReceiver, IndexNode, SwarmManager, ChatRoom, generateIdentityKeypair

async function loadCore () {
  const core = await import(path.join(__dirname, '../core/index.js'))
  FileSender            = core.FileSender
  FileReceiver          = core.FileReceiver
  IndexNode             = core.IndexNode
  SwarmManager          = core.SwarmManager
  ChatRoom              = core.ChatRoom
  generateIdentityKeypair = core.generateIdentityKeypair
}

// ── Active state ──────────────────────────────────────────────────────────────
const activeSenders   = new Map()
const activeReceivers = new Map()
const activeChats     = new Map()
let indexNode  = null
let mainWindow = null
let tray       = null

// ── Tray icon (inline 16×16 PNG as base64 so no asset file needed) ────────────
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAA' +
  'AAAASUVORK5CYII='   // fallback transparent — Electron replaces with default if empty

function getTrayIcon () {
  // Use a simple coloured square as the tray icon
  const img = nativeImage.createFromDataURL(
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAA8AAAAPBAMAAAALB+XWAAAAD1BMVEX///8Aof8Aof8Aof' +
    '8Aof+G3TNiAAAABHRSTlMAESIzRCsqfQAAABpJREFUCNdjYGBg' +
    'YGBg+A8FDAxQwMAAAA//wMABAAEAAFwYXkAAAAASUVORK5CYII='
  )
  return img.isEmpty() ? nativeImage.createEmpty() : img
}

// ── Notifications ─────────────────────────────────────────────────────────────
function notify (title, body, onClick) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: getTrayIcon(), silent: false })
  if (onClick) n.on('click', onClick)
  n.show()
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 780,
    minWidth: 850,
    minHeight: 620,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f172a',
    show: false,    // show after ready-to-show to avoid flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow.once('ready-to-show', () => mainWindow.show())

  if (isDev) mainWindow.webContents.openDevTools()

  // Minimise to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      notify('EagleBox', 'Running in the background. Click the tray icon to reopen.')
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray () {
  tray = new Tray(getTrayIcon())
  tray.setToolTip('EagleBox — P2P Encrypted File Sharing')

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open EagleBox',
      click: () => { mainWindow?.show(); mainWindow?.focus() }
    },
    { type: 'separator' },
    {
      label: 'Browse Network',
      click: () => {
        mainWindow?.show()
        mainWindow?.webContents.send('navigate', 'browse')
      }
    },
    {
      label: 'Share a File…',
      click: async () => {
        mainWindow?.show()
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ['openFile', 'multiSelections']
        })
        if (!result.canceled) {
          mainWindow?.webContents.send('tray:share-files', result.filePaths)
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit EagleBox',
      click: () => {
        app.isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(menu)

  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await loadCore()
  createWindow()
  createTray()

  indexNode = new IndexNode()
  await indexNode.join()

  indexNode.on('record', (record) => {
    mainWindow?.webContents.send('index:record', record)
    // Notify if window is hidden
    if (!mainWindow?.isVisible()) {
      notify(
        'New file on EagleBox network',
        `${record.filename} (${fmtBytes(record.size)})`,
        () => { mainWindow?.show(); mainWindow?.webContents.send('navigate', 'browse') }
      )
    }
  })
})

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    // Don't quit — keep running in tray
  }
})

app.on('before-quit', async () => {
  app.isQuitting = true
  await indexNode?.destroy()
  for (const { swarm } of activeSenders.values())   await swarm?.destroy()
  for (const { swarm } of activeReceivers.values()) await swarm?.destroy()
  for (const room of activeChats.values())          await room?.destroy()
})

app.on('activate', () => {
  if (!mainWindow) createWindow()
  else mainWindow.show()
})

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

ipcMain.handle('send:start', async (_e, { filePath, isPublic }) => {
  const sender = new FileSender(filePath, { public: isPublic === true })
  await sender.prepare()
  const swarm = new SwarmManager()
  await swarm.joinAsSender(sender.shareCode)
  activeSenders.set(sender.shareCode, { sender, swarm })

  indexNode?.announce({
    shareCode: sender.shareCode,
    filename:  sender.meta.filename,
    size:      sender.meta.size,
    sha256:    sender.meta.sha256,
    mimeType:  guessMime(sender.meta.filename),
    public:    sender.isPublic
  })

  notify('Sharing started', `${sender.meta.filename} is now available on the network`)

  swarm.on('peer', async (conn) => {
    mainWindow?.webContents.send('send:peer-connected', { shareCode: sender.shareCode })
    notify('Peer connected', `Someone is downloading ${sender.meta.filename}`)
    try {
      await sender.handlePeer(conn, (done, total) => {
        mainWindow?.webContents.send('send:progress', { shareCode: sender.shareCode, done, total })
      })
      mainWindow?.webContents.send('send:peer-done', { shareCode: sender.shareCode })
      notify('Transfer complete', `${sender.meta.filename} delivered successfully`, () => mainWindow?.show())
    } catch (err) {
      mainWindow?.webContents.send('send:error', { shareCode: sender.shareCode, message: err.message })
      notify('Transfer failed', err.message)
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
      notify(
        'Download complete',
        `${receiver.meta?.filename} saved successfully`,
        () => { mainWindow?.show(); shell.showItemInFolder(outPath) }
      )
      await swarm.destroy()
      activeReceivers.delete(transferId)
    } catch (err) {
      mainWindow?.webContents.send('receive:error', { transferId, message: err.message })
      notify('Download failed', err.message)
    }
  })

  setTimeout(async () => {
    if (activeReceivers.has(transferId)) {
      mainWindow?.webContents.send('receive:error', { transferId, message: 'Timed out — sender not found' })
      notify('Download timed out', 'Could not find the sender on the network')
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
    if (!mainWindow?.isVisible() || !mainWindow?.isFocused()) {
      notify(`${msg.nickname} in #${roomId}`, msg.text, () => {
        mainWindow?.show()
        mainWindow?.webContents.send('navigate', 'chat')
      })
    }
  })
  room.on('peer-joined', (info) => mainWindow?.webContents.send('chat:peer-joined', { roomId, ...info }))
  room.on('peer-left',   (info) => mainWindow?.webContents.send('chat:peer-left',   { roomId, ...info }))
  return { ok: true }
})

ipcMain.handle('chat:send',  async (_e, { roomId, text }) => {
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

ipcMain.handle('chat:listRooms', () => indexNode?.chatRooms ?? [])

// ── IPC: Keygen ───────────────────────────────────────────────────────────────

ipcMain.handle('keygen', () => {
  const { publicKey, privateKey } = generateIdentityKeypair()
  return { publicKey: publicKey.toString('hex'), privateKey: privateKey.toString('hex') }
})

ipcMain.handle('shell:showInFolder', (_e, { filePath }) => shell.showItemInFolder(filePath))

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

function fmtBytes (b) {
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KiB'
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MiB'
  return (b / 1073741824).toFixed(2) + ' GiB'
}
