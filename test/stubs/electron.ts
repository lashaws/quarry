/**
 * Minimal Electron stand-in so the main-process Session can be exercised under
 * plain Node. Only the surface the store modules touch is provided.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'quarry-test-'))

export const app = {
  getPath: (): string => dir,
  getName: (): string => 'quarry-test'
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer): string => b.toString('utf8')
}

export const ipcMain = { handle: (): void => undefined }
export const dialog = { showMessageBox: async (): Promise<{ response: number }> => ({ response: 2 }) }
export const BrowserWindow = class {}
export const Menu = { buildFromTemplate: (): unknown => ({}), setApplicationMenu: (): void => undefined }
export const shell = { openExternal: async (): Promise<void> => undefined }
export default { app, safeStorage, ipcMain, dialog, BrowserWindow, Menu, shell }
