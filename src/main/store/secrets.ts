import { safeStorage } from 'electron'
import { readJson, writeJson } from './json'

const FILE = 'secrets.json'
type Vault = Record<string, string>

/**
 * Passwords are encrypted with Electron's safeStorage, which is backed by the
 * macOS Keychain. Nothing readable ever lands on disk. Deliberately not keytar:
 * that is a native module needing an Electron rebuild, and safeStorage supersedes it.
 */
export function setSecret(id: string, password: string): void {
  const vault = readJson<Vault>(FILE, {})
  if (!password) {
    delete vault[id]
  } else if (safeStorage.isEncryptionAvailable()) {
    vault[id] = safeStorage.encryptString(password).toString('base64')
  } else {
    throw new Error('OS keychain unavailable; refusing to store password in plaintext')
  }
  writeJson(FILE, vault)
}

export function getSecret(id: string): string | undefined {
  const vault = readJson<Vault>(FILE, {})
  const blob = vault[id]
  if (!blob) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return undefined
  }
}

export function deleteSecret(id: string): void {
  const vault = readJson<Vault>(FILE, {})
  delete vault[id]
  writeJson(FILE, vault)
}
