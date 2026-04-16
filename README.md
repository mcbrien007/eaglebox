# EagleBox

**Peer-to-peer encrypted file sharing — Kazaa-style public index, key-gated downloads.**

EagleBox lets you share files directly between peers with end-to-end AES-256-GCM encryption. Filenames are visible to everyone on the network; only holders of the share key can decrypt the content. Files can also be shared publicly (no key required) on a per-file basis.

---

## Features

- **P2P networking** — Hyperswarm DHT for peer discovery and NAT hole-punching. No central server required.
- **AES-256-GCM encryption** — Each chunk gets a unique random IV. Auth tag per chunk + SHA-256 full-file integrity check.
- **Kazaa-style public index** — Filenames broadcast to all peers. Browse what's shared without a key; decrypt only with one.
- **Optional public sharing** — Toggle encryption off per file. Default is always encrypted.
- **Encrypted P2P chat** — Room-based chat encrypted with a key derived from the room name.
- **Three interfaces** — CLI, Electron desktop app, and SaaS web app.
- **Zero-knowledge server** — The SaaS backend stores only encrypted bytes. Decryption keys never leave your device.
- **System tray** — Runs in the background, shows notifications for transfers and chat messages.

---

## Project Structure

```
EagleBox/
├── src/
│   ├── core/               Shared modules (used by all three apps)
│   │   ├── crypto.js       AES-256-GCM, Ed25519, key utilities
│   │   ├── network.js      Hyperswarm P2P, length-prefixed message framing
│   │   ├── transfer.js     FileSender / FileReceiver (encrypted + public modes)
│   │   ├── index-node.js   Kazaa-style public file index over Hyperswarm
│   │   └── chat.js         Encrypted P2P chat rooms
│   ├── cli.js              CLI command definitions
│   └── index.js            CLI entry point
│
├── desktop/
│   ├── core/               Copy of src/core/ bundled into the Electron app
│   ├── src/
│   │   ├── main.js         Electron main process + IPC + tray + notifications
│   │   └── preload.cjs     contextBridge API exposed to renderer
│   ├── renderer/
│   │   └── index.html      Full desktop UI
│   └── dist/
│       └── EagleBox-win32-x64/
│           └── EagleBox.exe   Windows executable
│
└── saas/
    ├── backend/
    │   └── src/server.js   Express API + SSE live feed + P2P relay + chat
    └── frontend/
        └── src/
            ├── index.html  Web UI
            └── app.js      In-browser Web Crypto API (zero-knowledge)
```

---

## Quick Start

### CLI

```bash
npm install

# Share a file (encrypted by default)
node src/index.js send path/to/file.zip

# Share a file publicly (no key needed)
node src/index.js send path/to/file.zip --public

# Download an encrypted file
node src/index.js receive <shareCode> ./downloads

# Download a public file
node src/index.js receive PUBLIC:<topicId> ./downloads

# Generate an Ed25519 identity keypair
node src/index.js keygen
```

### Desktop App

```bash
cd desktop
npm install
npm start                   # Run in dev mode
```

Or run the pre-built executable:
```
desktop/dist/EagleBox-win32-x64/EagleBox.exe
```

### SaaS Web App

```bash
# Start the backend
cd saas/backend
npm install
npm start                   # Runs on http://localhost:3001

# Open the frontend
# Open saas/frontend/src/index.html in a browser
```

---

## Security Model

| Property | How |
|---|---|
| **Confidentiality** | AES-256-GCM per chunk, unique 96-bit random IV per chunk |
| **Integrity** | 128-bit GCM auth tag per chunk + SHA-256 whole-file verification |
| **Key distribution** | Share code = base64url(key). Share it over a trusted side-channel (Signal, etc.) |
| **Public files** | Chunks sent as plaintext. SHA-256 integrity check still applies. |
| **Chat encryption** | AES-256-GCM, key derived from room name via SHA-256 |
| **Server zero-knowledge** | SaaS backend stores only encrypted bytes. Decryption key never sent to server. |
| **Identity** | Ed25519 keypairs for future signed announcements (generated via `keygen`) |
| **P2P transport** | Hyperswarm DHT — no central relay, direct peer connections |

> **Warning:** The share code IS the decryption key. Anyone who obtains it can decrypt the file. Treat it like a password and share it only over secure channels.

---

## Encryption Toggle

By default, all files require a share key to decrypt. You can disable encryption per file:

- **Desktop:** Use the 🔐/🔓 toggle in the Send panel before sharing.
- **CLI:** Pass the `--public` flag to `send`.
- **SaaS:** Toggle in the upload form.

Public files are still listed in the public index with a 🔓 badge. Their SHA-256 hash is verified after download to ensure integrity.

---

## Chat

Chat rooms use the room name as the encryption key. Anyone who knows the room name can join and read messages — keep room names secret if you want a private channel.

- **Desktop:** Chat panel in the sidebar.
- **Web:** Chat section at the bottom of the page.
- Messages are end-to-end encrypted (desktop/CLI). The SaaS relay stores messages in memory only — no disk persistence, no plaintext logging.

---

## Building the Desktop App

```bash
cd desktop
npm install
npx electron-packager . EagleBox --platform=win32 --arch=x64 --out=dist --overwrite
```

The output is in `desktop/dist/EagleBox-win32-x64/`. The entire folder must be kept together.

---

## Deploying the SaaS Backend

The backend is a standard Express app. Deploy to any Node.js host (Railway, Render, Fly.io, etc.).

Before deploying, update the API URL in [saas/frontend/src/app.js](saas/frontend/src/app.js):

```js
const API = 'https://your-backend.example.com/api'
```

Environment variables:
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port |

---

## License

MIT
