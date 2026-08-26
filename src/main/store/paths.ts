import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export function userDataDir(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

export const filePath = (name: string): string => join(userDataDir(), name)
