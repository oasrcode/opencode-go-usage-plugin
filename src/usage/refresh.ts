/**
 * Pure, injectable-clock refresh scheduler for usage data.
 *
 * Policy (confirmed):
 *  - mount: emit cache if present AND fetch in parallel.
 *  - timer: every 5 min, only when the last fetch is >= 5 min old.
 *  - idle: refresh only when >= 60 s since the last fetch (debounces bursts).
 *  - manual: force a fetch subject to a 30 s manual cooldown.
 *  - error: backoff 5 → 10 → 20 → 30 min (capped), reset on first success.
 *  - HARD RULE: never more than one request per 60 s, whatever the trigger.
 *
 * The controller takes `now` and `timers` as dependencies so tests never use real
 * timers or the network.
 */
import type { UsageResult, UsageSnapshot } from "./types"

/** Hard floor between any two requests. */
export const MIN_INTERVAL_MS = 60_000
/** Staleness threshold for the base timer. */
export const TTL_MS = 5 * 60_000
/** Debounce for `session.idle` bursts. */
export const IDLE_DEBOUNCE_MS = 60_000
/** Cooldown between manual refreshes. */
export const MANUAL_COOLDOWN_MS = 30_000
/** Base interval for a healthy scheduler. */
export const BASE_INTERVAL_MS = TTL_MS
/** Backoff ladder (ms) indexed by `errorStreak - 1`, capped at the last entry. */
export const ERROR_BACKOFF_MS: readonly number[] = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000]

export type RefreshReason = "mount" | "timer" | "idle" | "manual"

export interface RefreshState {
  /** Epoch ms of the last fetch attempt; `null` before the first one. */
  lastFetchAt: number | null
  /** Epoch ms of the last manual trigger; `null` if never. */
  lastManualAt: number | null
  /** Consecutive failures; drives the backoff ladder. */
  errorStreak: number
  /** True while a request is in flight. */
  inFlight: boolean
}

/** Minimal timer surface, injectable for tests. */
export interface TimerApi {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export function initialRefreshState(): RefreshState {
  return { lastFetchAt: null, lastManualAt: null, errorStreak: 0, inFlight: false }
}

/** Enforce the hard 1-request-per-60 s rule (and never overlap requests). */
export function canFetch(state: RefreshState, now: number): boolean {
  if (state.inFlight) return false
  if (state.lastFetchAt === null) return true
  return now - state.lastFetchAt >= MIN_INTERVAL_MS
}

/** Decide whether a given trigger may start a fetch right now. */
export function shouldRefresh(state: RefreshState, reason: RefreshReason, now: number): boolean {
  if (!canFetch(state, now)) return false

  switch (reason) {
    case "mount":
      return true
    case "timer":
      return state.lastFetchAt === null || now - state.lastFetchAt >= TTL_MS
    case "idle":
      return state.lastFetchAt === null || now - state.lastFetchAt >= IDLE_DEBOUNCE_MS
    case "manual":
      return state.lastManualAt === null || now - state.lastManualAt >= MANUAL_COOLDOWN_MS
  }
}

/** Delay (ms) until the next scheduled poll, given the current error streak. */
export function nextDelayMs(state: RefreshState): number {
  if (state.errorStreak <= 0) return BASE_INTERVAL_MS
  const index = Math.min(state.errorStreak - 1, ERROR_BACKOFF_MS.length - 1)
  return ERROR_BACKOFF_MS[index] ?? BASE_INTERVAL_MS
}

export interface RefreshControllerOptions {
  /** Perform one usage fetch (never throws by contract). */
  fetch: () => Promise<UsageResult>
  /** Injectable clock. */
  now: () => number
  /** Called with the cache on mount and with every fetch result. */
  onUpdate: (result: UsageResult) => void
  /** Last known snapshot; emitted immediately on mount while the fetch runs. */
  cache?: UsageSnapshot
  /** Injectable timers. */
  timers?: TimerApi
}

export interface RefreshController {
  /** Attempt a fetch for `reason`; resolves `true` if a request was started. */
  trigger(reason: RefreshReason): Promise<boolean>
  /** Cancel any pending timer and ignore future triggers. */
  dispose(): void
  /** Current scheduler state (read-only snapshot). */
  getState(): RefreshState
}

const defaultTimers: TimerApi = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createRefreshController(options: RefreshControllerOptions): RefreshController {
  const timers = options.timers ?? defaultTimers
  const now = options.now
  const fetchImpl = options.fetch
  const onUpdate = options.onUpdate
  const cache = options.cache

  let state = initialRefreshState()
  let timer: unknown = null
  let disposed = false

  function scheduleNext(): void {
    if (disposed) return
    if (timer !== null) {
      timers.clearTimeout(timer)
      timer = null
    }
    timer = timers.setTimeout(() => {
      timer = null
      // A successful trigger reschedules itself; a refusal (e.g. a request is
      // already in flight) must still reschedule or auto-refresh stops forever.
      void trigger("timer").then((started) => {
        if (!started) scheduleNext()
      })
    }, nextDelayMs(state))
  }

  async function trigger(reason: RefreshReason): Promise<boolean> {
    if (disposed) return false
    if (!shouldRefresh(state, reason, now())) return false

    const at = now()
    if (reason === "mount" && cache) {
      onUpdate({ ok: true, snapshot: cache })
    }
    state = {
      ...state,
      inFlight: true,
      lastFetchAt: at,
      lastManualAt: reason === "manual" ? at : state.lastManualAt,
    }

    let result: UsageResult
    try {
      result = await fetchImpl()
    } catch {
      result = { ok: false, error: { kind: "network", message: "Usage fetch failed." } }
    }

    state = {
      ...state,
      inFlight: false,
      errorStreak: result.ok ? 0 : state.errorStreak + 1,
    }
    // A dispose may land while the fetch is pending: suppress post-dispose work.
    if (disposed) return true
    onUpdate(result)
    scheduleNext()
    return true
  }

  function dispose(): void {
    disposed = true
    if (timer !== null) {
      timers.clearTimeout(timer)
      timer = null
    }
  }

  return { trigger, dispose, getState: () => state }
}
