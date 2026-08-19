export const CURSOR_PROXY_API_KEY = 'cursor-proxy'

export function getCursorRequestAccessToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  const accessToken = match?.[1]?.trim()
  return accessToken && accessToken !== CURSOR_PROXY_API_KEY ? accessToken : null
}
