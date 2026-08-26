declare module 'pg-cursor' {
  import type { Result, Submittable } from 'pg'

  interface CursorConfig {
    rowMode?: 'array'
    types?: unknown
  }

  /**
   * pg-cursor ships no types. Declared here rather than cast to `any` so the
   * read/close callbacks stay checked — they are the streaming hot path.
   */
  class Cursor<R = unknown[]> implements Submittable {
    constructor(text: string, values?: unknown[], config?: CursorConfig)
    read(rowCount: number, callback: (err: Error | null, rows: R[], result: Result) => void): void
    close(callback?: (err?: Error) => void): void
    submit(connection: unknown): void
  }

  export = Cursor
}
