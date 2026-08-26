import type { Api } from '@shared/ipc'

declare global {
  interface Window {
    api: Api
    menu: { on(channel: string, cb: () => void): () => void }
  }
}
export {}
