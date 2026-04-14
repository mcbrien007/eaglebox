/**
 * EagleBox Crypto Module
 * Handles all encryption/decryption operations using Node.js built-in crypto.
 *
 * Key scheme:
 *  - Each node has an Ed25519 identity keypair (signing)
 *  - Each file share uses a random 256-bit AES-GCM key
 *  - The file key is shared out-of-band via a "share code" (base64url)
 *  - File data is encrypted with AES-256-GCM; each chunk gets a unique IV
 */

import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32      // 256-bit
const IV_BYTES = 12       // 96-bit IV recommended for GCM
const TAG_BYTES = 16      // 128-bit auth tag

// ── Identity keypair ──────────────────────────────────────────────────────────

/**
 * Generate a new Ed25519 identity keypair.
 * Returns { publicKey: Buffer, privateKey: Buffer }
 */
export function generateIdentityKeypair () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  })
  return { publicKey: Buffer.from(publicKey), privateKey: Buffer.from(privateKey) }
}

/**
 * Sign data with an Ed25519 private key (DER/pkcs8).
 */
export function sign (data, privateKeyDer) {
  const key = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' })
  return crypto.sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data), key)
}

/**
 * Verify an Ed25519 signature.
 */
export function verify (data, signature, publicKeyDer) {
  const key = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
  return crypto.verify(null, Buffer.isBuffer(data) ? data : Buffer.from(data), key, signature)
}

// ── File encryption key ───────────────────────────────────────────────────────

/**
 * Generate a random file encryption key (32 bytes).
 */
export function generateFileKey () {
  return crypto.randomBytes(KEY_BYTES)
}

/**
 * Encode a file key to a URL-safe base64 string (the "share code").
 */
export function keyToShareCode (keyBuffer) {
  return keyBuffer.toString('base64url')
}

/**
 * Decode a share code back to a key Buffer.
 */
export function shareCodeToKey (shareCode) {
  return Buffer.from(shareCode, 'base64url')
}

// ── Chunk encryption ─────────────────────────────────────────────────────────

/**
 * Encrypt a single chunk.
 *
 * Layout of returned Buffer:
 *   [12 bytes IV][16 bytes auth tag][N bytes ciphertext]
 *
 * @param {Buffer} plaintext
 * @param {Buffer} key  32-byte AES key
 * @returns {Buffer}
 */
export function encryptChunk (plaintext, key) {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

/**
 * Decrypt a single chunk produced by encryptChunk.
 *
 * @param {Buffer} encrypted  [IV][tag][ciphertext]
 * @param {Buffer} key
 * @returns {Buffer} plaintext
 */
export function decryptChunk (encrypted, key) {
  if (encrypted.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Encrypted chunk too short')
  }
  const iv = encrypted.subarray(0, IV_BYTES)
  const tag = encrypted.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = encrypted.subarray(IV_BYTES + TAG_BYTES)

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

// ── Metadata encryption ──────────────────────────────────────────────────────

/**
 * Encrypt a JSON-serialisable metadata object with the file key.
 * Returns a Buffer with the same layout as encryptChunk.
 */
export function encryptMetadata (meta, key) {
  const plaintext = Buffer.from(JSON.stringify(meta), 'utf8')
  return encryptChunk(plaintext, key)
}

/**
 * Decrypt and parse metadata.
 */
export function decryptMetadata (encrypted, key) {
  const plaintext = decryptChunk(encrypted, key)
  return JSON.parse(plaintext.toString('utf8'))
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a Buffer.
 */
export function sha256 (data) {
  return crypto.createHash('sha256').update(data).digest()
}

/**
 * Derive a Hyperswarm topic from a share code so peers can find each other.
 * topic = SHA-256("eaglebox-v1:" + shareCode)
 */
export function shareCodeToTopic (shareCode) {
  return crypto.createHash('sha256').update('eaglebox-v1:' + shareCode).digest()
}
