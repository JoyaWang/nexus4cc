export function scrollbackKey(session: string, windowIndex: number): string {
  return `${session}:${windowIndex}`
}

export function shouldRetainScrollbackCacheOnClose(): boolean {
  return true
}
