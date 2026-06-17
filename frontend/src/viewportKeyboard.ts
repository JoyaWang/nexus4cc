export function detectKeyboardVisible(opts: {
  isTouch: boolean
  viewportHeight: number
  maxViewportHeight: number
  minDelta?: number
}): boolean {
  const minDelta = opts.minDelta ?? 120
  return opts.isTouch && opts.maxViewportHeight - opts.viewportHeight > minDelta
}
