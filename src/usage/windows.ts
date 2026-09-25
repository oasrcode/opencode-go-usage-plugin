/**
 * Pure formatting/normalization helpers for usage windows.
 */
import {
  USAGE_WINDOW_KEYS,
  type RawUsageWindow,
  type RawUsageWindows,
  type UsageWindow,
  type UsageWindowKey,
} from "./types"

/** Display labels per window, in canonical order. */
export const WINDOW_LABELS: Record<UsageWindowKey, string> = {
  rolling: "5h",
  weekly: "Weekly",
  monthly: "Monthly",
}

/** Severity buckets used to pick colors in the UI. */
export type Severity = "normal" | "warning" | "error"

/**
 * Milliseconds between `resetsAt` and `now`, clamped at 0 when already past.
 *
 * Returns `NaN` when `resetsAt` is not a parseable date so callers can render it
 * as an explicit "unknown" reset instead of a misleading `0` (which would show
 * `↻ <1m` forever).
 */
export function resetsInMs(resetsAt: string, now: number): number {
  const target = Date.parse(resetsAt)
  if (!Number.isFinite(target)) return Number.NaN
  return Math.max(0, target - now)
}

/**
 * Normalize the raw wire `usage` object into display-ready windows.
 *
 * Only present, well-formed windows are emitted, always in rolling → weekly →
 * monthly order. Non-numeric `percent` values are ignored and out-of-range
 * percentages are clamped to 0-100 so a hostile/negative value can neither
 * render as `-5%`/`150%` nor skew the severity bucket.
 */
export function normalizeWindows(raw: RawUsageWindows, now: number): UsageWindow[] {
  const windows: UsageWindow[] = []

  for (const key of USAGE_WINDOW_KEYS) {
    const entry: RawUsageWindow | undefined = raw[key]
    if (!entry || typeof entry.percent !== "number" || !Number.isFinite(entry.percent)) continue
    if (typeof entry.resetsAt !== "string") continue

    windows.push({
      key,
      label: WINDOW_LABELS[key],
      percent: Math.min(100, Math.max(0, entry.percent)),
      resetsAt: entry.resetsAt,
      resetsInMs: resetsInMs(entry.resetsAt, now),
    })
  }

  return windows
}

/** Format a used percentage, e.g. `8%`. */
export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`
}

/** Format a duration in ms as a compact human string, e.g. `2h 15m`, `3d 16h`, `45m`, `<1m`. */
export function formatReset(ms: number): string {
  // Unknown reset (unparseable `resetsAt` is surfaced as NaN): render an explicit
  // placeholder instead of a false "<1m".
  if (!Number.isFinite(ms)) return "—"

  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000)
  if (totalMinutes < 1) return "<1m"
  if (totalMinutes < 60) return `${totalMinutes}m`

  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`

  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

/** Map a used percentage to a severity bucket (`<70` normal, `70-90` warning, `>90` error). */
export function severity(percent: number): Severity {
  if (percent < 70) return "normal"
  if (percent <= 90) return "warning"
  return "error"
}

/** Format how old a snapshot is, e.g. `ahora`, `hace 2m`, `hace 3h`, `hace 1d`. */
export function formatFreshness(fetchedAt: number, now: number): string {
  const ageMinutes = Math.floor(Math.max(0, now - fetchedAt) / 60_000)
  if (ageMinutes < 1) return "ahora"
  if (ageMinutes < 60) return `hace ${ageMinutes}m`

  const ageHours = Math.floor(ageMinutes / 60)
  if (ageHours < 24) return `hace ${ageHours}h`

  return `hace ${Math.floor(ageHours / 24)}d`
}
