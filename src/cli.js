/**
 * EagleBox CLI
 *
 * Commands:
 *   eaglebox send <file>              Share a file and print its share code
 *   eaglebox receive <code> [outdir]  Download a file using a share code
 *   eaglebox keygen                   Generate and display a new identity keypair
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import path from 'path'
import fs from 'fs'
import { SwarmManager } from './core/network.js'
import { FileSender, FileReceiver } from './core/transfer.js'
import { generateIdentityKeypair, keyToShareCode } from './core/crypto.js'

const EAGLEBOX_BANNER = `
${chalk.bold.cyan('███████╗ █████╗  ██████╗ ██╗     ███████╗██████╗  ██████╗ ██╗  ██╗')}
${chalk.bold.cyan('██╔════╝██╔══██╗██╔════╝ ██║     ██╔════╝██╔══██╗██╔═══██╗╚██╗██╔╝')}
${chalk.bold.cyan('█████╗  ███████║██║  ███╗██║     █████╗  ██████╔╝██║   ██║ ╚███╔╝ ')}
${chalk.bold.cyan('██╔══╝  ██╔══██║██║   ██║██║     ██╔══╝  ██╔══██╗██║   ██║ ██╔██╗ ')}
${chalk.bold.cyan('███████╗██║  ██║╚██████╔╝███████╗███████╗██████╔╝╚██████╔╝██╔╝ ██╗')}
${chalk.bold.cyan('╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝')}
${chalk.dim('  Peer-to-peer encrypted file sharing')}
`

// ── Helpers ───────────────────────────────────────────────────────────────────

function printBanner () {
  console.log(EAGLEBOX_BANNER)
}

function formatBytes (bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

function drawProgressBar (current, total, width = 30) {
  const pct = total > 0 ? current / total : 0
  const filled = Math.round(pct * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  return `[${bar}] ${current}/${total} (${(pct * 100).toFixed(1)}%)`
}

// ── Send command ──────────────────────────────────────────────────────────────

async function cmdSend (filePath, opts) {
  printBanner()

  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    console.error(chalk.red(`File not found: ${resolved}`))
    process.exit(1)
  }

  const spinner = ora('Preparing file…').start()

  const sender = new FileSender(resolved)
  await sender.prepare()

  const { meta } = sender
  spinner.succeed(`File ready: ${chalk.bold(meta.filename)} (${formatBytes(meta.size)}, ${meta.totalChunks} chunks)`)

  console.log()
  console.log(chalk.bold('Share code:'))
  console.log(chalk.green.bold(`  ${sender.shareCode}`))
  console.log()
  console.log(chalk.dim('Give this code to the receiver. They can download the file with:'))
  console.log(chalk.cyan(`  eaglebox receive ${sender.shareCode}`))
  console.log()

  const swarm = new SwarmManager()
  spinner.text = 'Joining P2P swarm…'
  spinner.start()

  await swarm.joinAsSender(sender.shareCode)
  spinner.succeed('Announced on swarm. Waiting for peers…')
  console.log(chalk.dim('(Press Ctrl+C to stop sharing)\n'))

  let peerCount = 0

  swarm.on('peer', async (conn) => {
    peerCount++
    const peerId = peerCount
    const peerSpinner = ora(`[Peer ${peerId}] Connected — transferring…`).start()

    try {
      await sender.handlePeer(conn, (done, total) => {
        peerSpinner.text = `[Peer ${peerId}] ${drawProgressBar(done, total)}`
      })
      peerSpinner.succeed(`[Peer ${peerId}] Transfer complete`)
    } catch (err) {
      peerSpinner.fail(`[Peer ${peerId}] Transfer failed: ${err.message}`)
    }
  })

  // Keep alive until Ctrl+C
  await new Promise(() => {})
}

// ── Receive command ───────────────────────────────────────────────────────────

async function cmdReceive (shareCode, outDir, opts) {
  printBanner()

  const destDir = path.resolve(outDir || '.')
  const spinner = ora('Joining P2P swarm…').start()

  const receiver = new FileReceiver(shareCode, destDir)
  const swarm = new SwarmManager()

  let resolved = false

  await swarm.joinAsReceiver(shareCode)
  spinner.succeed('Joined swarm. Looking for sender…')

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!resolved) {
        reject(new Error('Timed out waiting for sender (60 s). Is the sender online?'))
      }
    }, 60_000)

    swarm.on('peer', async (conn) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)

      const transferSpinner = ora('Receiving file…').start()

      try {
        const outPath = await receiver.receiveFrom(conn, (done, total) => {
          transferSpinner.text = `Downloading… ${drawProgressBar(done, total)}`
        })
        transferSpinner.succeed(`File saved: ${chalk.bold(outPath)}`)
        console.log()
        if (receiver.meta) {
          console.log(chalk.dim(`  Filename : ${receiver.meta.filename}`))
          console.log(chalk.dim(`  Size     : ${formatBytes(receiver.meta.size)}`))
          console.log(chalk.dim(`  SHA-256  : ${receiver.meta.sha256}`))
        }
        console.log()
        console.log(chalk.green('Integrity check passed.'))
        resolve()
      } catch (err) {
        transferSpinner.fail(`Transfer failed: ${err.message}`)
        reject(err)
      } finally {
        await swarm.destroy()
      }
    })
  })
}

// ── Keygen command ────────────────────────────────────────────────────────────

function cmdKeygen () {
  printBanner()
  const spinner = ora('Generating Ed25519 identity keypair…').start()
  const { publicKey, privateKey } = generateIdentityKeypair()
  spinner.succeed('Keypair generated')
  console.log()
  console.log(chalk.bold('Public key  (share freely):'))
  console.log(chalk.green('  ' + publicKey.toString('hex')))
  console.log()
  console.log(chalk.bold('Private key (keep secret!):'))
  console.log(chalk.red('  ' + privateKey.toString('hex')))
  console.log()
  console.log(chalk.yellow.bold('WARNING: Store your private key securely. It cannot be recovered.'))
}

// ── Program ───────────────────────────────────────────────────────────────────

export function createCLI () {
  const program = new Command()

  program
    .name('eaglebox')
    .description('Peer-to-peer encrypted file sharing')
    .version('1.0.0')

  program
    .command('send <file>')
    .description('Share a file securely over the P2P network')
    .action(cmdSend)

  program
    .command('receive <shareCode> [outDir]')
    .description('Download a shared file using its share code')
    .action(cmdReceive)

  program
    .command('keygen')
    .description('Generate a new Ed25519 identity keypair')
    .action(cmdKeygen)

  return program
}
