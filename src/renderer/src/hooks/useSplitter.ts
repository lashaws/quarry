import { useCallback, useEffect, useRef, useState } from 'react'

/** Drag-to-resize for the tool-window splitters, with sizes owned by the caller. */
export function useSplitter(
  initial: number,
  axis: 'x' | 'y',
  invert = false
): { size: number; setSize: (n: number) => void; dragging: boolean; onMouseDown: () => void } {
  const [size, setSize] = useState(initial)
  const [dragging, setDragging] = useState(false)
  const start = useRef({ pos: 0, size: 0 })

  const onMouseDown = useCallback((): void => setDragging(true), [])

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      const pos = axis === 'x' ? e.clientX : e.clientY
      if (!start.current.pos) {
        start.current = { pos, size }
        return
      }
      const delta = pos - start.current.pos
      setSize(Math.max(120, start.current.size + (invert ? -delta : delta)))
    }
    const up = (): void => {
      setDragging(false)
      start.current = { pos: 0, size: 0 }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, axis, invert, size])

  return { size, setSize, dragging, onMouseDown }
}
