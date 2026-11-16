/**
 * The viewer only ever talks to itself (same-origin page) or to the local CLI (Node fetch, which
 * sends no Origin). Anything else reaching the loopback port is a web page trying to use the
 * server as a confused deputy (writing memories that agents later trust, or reading the vault via
 * DNS rebinding), so these checks reject it before routing.
 */

export const MAX_BODY_BYTES = 1_000_000

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]']

function allowedHostnames(bindHost: string): Set<string> {
  const names = new Set(LOOPBACK_HOSTNAMES)
  const bound = bindHost.toLowerCase()
  if (bound && bound !== '0.0.0.0' && bound !== '::') {
    names.add(bound.includes(':') && !bound.startsWith('[') ? `[${bound}]` : bound)
  }
  return names
}

/** Rejects DNS-rebinding requests whose Host is an attacker-controlled name. */
export function isAllowedHost(hostHeader: string | undefined, port: number, bindHost = '127.0.0.1'): boolean {
  if (!hostHeader) return false
  const host = hostHeader.trim().toLowerCase()
  for (const name of allowedHostnames(bindHost)) {
    if (host === `${name}:${port}`) return true
  }
  return false
}

/** Same-origin browser requests and Origin-less local clients pass; any foreign or opaque origin fails. */
export function isAllowedOrigin(originHeader: string | undefined, port: number, bindHost = '127.0.0.1'): boolean {
  if (originHeader === undefined) return true
  const origin = originHeader.trim().toLowerCase()
  for (const name of allowedHostnames(bindHost)) {
    if (origin === `http://${name}:${port}`) return true
  }
  return false
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * `<img>`/`<script>` GETs from another site carry no Origin but browsers tag them with
 * Sec-Fetch-Site. Absent (CLI, older browsers), `same-origin` and `none` (typed URL) pass.
 */
export function isAllowedFetchSite(fetchSiteHeader: string | undefined): boolean {
  if (fetchSiteHeader === undefined) return true
  const site = fetchSiteHeader.trim().toLowerCase()
  return site === 'same-origin' || site === 'none'
}

/**
 * A link to the viewer from another site (README, chat) is a top-level navigation tagged
 * `cross-site`. Only that shell page is exempt: it carries no vault data and every request it
 * then makes is same-origin, while `/api/*` stays subject to the fetch-metadata check.
 */
export function isViewerNavigation(req: {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
}): boolean {
  const target = req.url ?? ''
  return (
    req.method === 'GET' &&
    (target === '/' || target.startsWith('/?')) &&
    firstHeader(req.headers['sec-fetch-mode']) === 'navigate' &&
    firstHeader(req.headers['sec-fetch-dest']) === 'document'
  )
}

/** Requiring JSON forces a CORS preflight for browsers, which this server never approves. */
export function isJsonContentType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase()
  return mediaType === 'application/json'
}

/** A client error raised while reading a request; the handler turns it into that status code. */
export class RequestError extends Error {
  readonly status: number
  readonly closeConnection: boolean

  constructor(status: number, message: string, closeConnection = false) {
    super(message)
    this.status = status
    this.closeConnection = closeConnection
  }
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'none'",
}
