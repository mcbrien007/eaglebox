#!/usr/bin/env node
/**
 * EagleBox – Peer-to-peer encrypted file sharing
 * Entry point
 */

import { createCLI } from './cli.js'

const program = createCLI()

program.parseAsync(process.argv).catch((err) => {
  console.error('\nFatal error:', err.message)
  process.exit(1)
})
