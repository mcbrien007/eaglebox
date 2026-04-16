/**
 * EagleBox Desktop — Preload Script
 * Exposes a safe, typed API to the renderer via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('eaglebox', {
  // ── File dialogs ────────────────────────────────────────────────────────────
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  saveDirDialog: () => ipcRenderer.invoke('dialog:saveDir'),

  // ── Send ───────────────────────────────────────────────────────────────────
  sendStart: (filePath) => ipcRenderer.invoke('send:start', { filePath }),
  sendStop: (shareCode) => ipcRenderer.invoke('send:stop', { shareCode }),

  // ── Receive ────────────────────────────────────────────────────────────────
  receiveStart: (shareCode, destDir) =>
    ipcRenderer.invoke('receive:start', { shareCode, destDir }),

  // ── Index / Search ─────────────────────────────────────────────────────────
  indexGetAll: () => ipcRenderer.invoke('index:getAll'),
  indexSearch: (query) => ipcRenderer.invoke('index:search', { query }),

  // ── Chat ───────────────────────────────────────────────────────────────────
  chatJoin:      (roomId, nickname) => ipcRenderer.invoke('chat:join',  { roomId, nickname }),
  chatSend:      (roomId, text)     => ipcRenderer.invoke('chat:send',  { roomId, text }),
  chatLeave:     (roomId)           => ipcRenderer.invoke('chat:leave', { roomId }),
  chatListRooms: ()                 => ipcRenderer.invoke('chat:listRooms'),

  // ── Keygen ─────────────────────────────────────────────────────────────────
  keygen: () => ipcRenderer.invoke('keygen'),

  // ── Shell ──────────────────────────────────────────────────────────────────
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', { filePath }),

  // ── Event listeners ────────────────────────────────────────────────────────
  on: (channel, cb) => {
    const allowed = [
      'send:progress', 'send:peer-connected', 'send:peer-done', 'send:error',
      'receive:progress', 'receive:done', 'receive:error',
      'index:record',
      'chat:message', 'chat:peer-joined', 'chat:peer-left'
    ]
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, data) => cb(data))
    }
  },
  off: (channel, cb) => ipcRenderer.removeListener(channel, cb)
})
