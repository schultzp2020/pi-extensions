export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  const verifier = Buffer.from(array).toString('base64url').replace(/=+$/, '')

  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const challenge = Buffer.from(new Uint8Array(hash)).toString('base64url').replace(/=+$/, '')

  return { verifier, challenge }
}
