/**
 * HTTP client for the OpenCode Go usage endpoint.
 *
 * The API key is resolved via `auth.ts` when not supplied and is NEVER included in
 * any error, log, or thrown value. `fetchImpl` is injectable so tests never touch
 * the network.
 */
import { readApiKey } from "./auth"
import { normalizeWindows } from "./windows"
import { USAGE_WINDOW_KEYS, type RawUsageWindows, type UsageError, type UsageResult } from "./types"

/** Verified endpoint returning the rolling / weekly / monthly quota. */
export const USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage"

/** Default abort timeout for a single request. */
export const DEFAULT_TIMEOUT_MS = 10_000

export interface FetchUsageOptions {
  /** Explicit API key; skips auth.json resolution when set. */
  apiKey?: string
  /** Explicit `auth.json` path used to resolve the key. */
  authPath?: string
  /** Injectable fetch implementation (tests). */
  fetchImpl?: typeof fetch
  /** Abort timeout in ms (default 10000). */
  timeoutMs?: number
  /** Injectable clock for `fetchedAt` / `resetsInMs` (tests). */
  now?: () => number
}

function failure(kind: UsageError["kind"], message: string): UsageResult {
  return { ok: false, error: { kind, message } }
}

/** Validate the wire payload and return the raw `usage` windows, or `undefined`. */
function extractUsage(body: unknown): RawUsageWindows | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const usage = (body as { usage?: unknown }).usage
  if (typeof usage !== "object" || usage === null) return undefined

  const record = usage as Record<string, unknown>
  const windows: RawUsageWindows = {}
  let found = false

  for (const key of USAGE_WINDOW_KEYS) {
    const entry = record[key]
    if (entry === undefined) continue
    if (typeof entry !== "object" || entry === null) return undefined

    const candidate = entry as { percent?: unknown; resetsAt?: unknown }
    if (typeof candidate.percent !== "number" || !Number.isFinite(candidate.percent)) return undefined
    if (typeof candidate.resetsAt !== "string") return undefined

    windows[key] = { percent: candidate.percent, resetsAt: candidate.resetsAt }
    found = true
  }

  return found ? windows : undefined
}

/**
 * Fetch the current usage snapshot.
 *
 * Never rejects: all failures are returned as `{ ok: false, error }`.
 */
export async function fetchUsage(opts: FetchUsageOptions = {}): Promise<UsageResult> {
  const now = opts.now ?? (() => Date.now())

  const apiKey = opts.apiKey ?? readApiKey({ authPath: opts.authPath })
  if (!apiKey) {
    return failure("no-key", "No OpenCode Go API key found.")
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const controller = new AbortController()

  // `aborted` lets the catch handlers tell a timeout apart from any other
  // transport failure. It is set before aborting so it is observed synchronously.
  let aborted = false
  const timer = setTimeout(() => {
    aborted = true
    controller.abort()
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  // The abort signal is not guaranteed to make an injected `response.json()`
  // reject (and a stalled body would otherwise hang forever). Race the body read
  // against this rejection so aborting the request always settles the whole
  // operation. The eager `catch` marks it handled even when the abort lands
  // before the race is reached.
  const abortedPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
  abortedPromise.catch(() => {})

  // The `finally` wraps the ENTIRE operation (headers + body) so the abort timer
  // stays armed until the body has been read as well.
  try {
    const response = await fetchImpl(USAGE_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    })

    if (!response.ok) {
      if (response.status === 401) {
        return failure("unauthorized", "The OpenCode Go API key was rejected (401).")
      }
      if (response.status === 403) {
        return failure("no-plan", "The account has no active OpenCode Go plan (403).")
      }
      return failure("network", `The usage endpoint returned HTTP ${response.status}.`)
    }

    let body: unknown
    try {
      body = await Promise.race([response.json(), abortedPromise])
    } catch {
      if (aborted) return failure("network", "The usage request timed out.")
      return failure("invalid-response", "The usage endpoint returned invalid JSON.")
    }

    const raw = extractUsage(body)
    if (!raw) {
      return failure("invalid-response", "The usage endpoint returned an unexpected payload.")
    }

    const fetchedAt = now()
    const windows = normalizeWindows(raw, fetchedAt)
    if (windows.length === 0) {
      return failure("invalid-response", "The usage payload contained no usable windows.")
    }

    return { ok: true, snapshot: { windows, fetchedAt } }
  } catch {
    if (aborted) return failure("network", "The usage request timed out.")
    // Deliberately drop the original error: it may embed request headers.
    return failure("network", "Could not reach the usage endpoint.")
  } finally {
    clearTimeout(timer)
  }
}
