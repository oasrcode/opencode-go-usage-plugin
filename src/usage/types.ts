/**
 * Shared types for the OpenCode Go usage data layer.
 *
 * This module is intentionally dependency-free and pure so it can be imported by
 * both the TUI renderer (Wave 3) and the unit tests.
 */

/** The three quota windows returned by the usage endpoint. */
export type UsageWindowKey = "rolling" | "weekly" | "monthly"

/** Canonical order used everywhere a list of windows is rendered. */
export const USAGE_WINDOW_KEYS: readonly UsageWindowKey[] = ["rolling", "weekly", "monthly"]

/** A normalized quota window ready for display. */
export interface UsageWindow {
  key: UsageWindowKey
  /** Human label, e.g. "5h" / "Semanal" / "Mensual". */
  label: string
  /** Percentage already used, 0-100. */
  percent: number
  /** ISO-8601 UTC instant when the window resets. */
  resetsAt: string
  /** Milliseconds until the reset, clamped at 0 when already past. */
  resetsInMs: number
}

/** A full snapshot of usage as fetched at a point in time. */
export interface UsageSnapshot {
  windows: UsageWindow[]
  /** Epoch milliseconds when the snapshot was produced. */
  fetchedAt: number
}

/** A single raw window as it appears on the wire (untrusted). */
export interface RawUsageWindow {
  status?: string
  percent: number
  resetsAt: string
}

/** The `usage` object of the wire payload; keys may be missing in theory. */
export type RawUsageWindows = Partial<Record<UsageWindowKey, RawUsageWindow>>

/** Discriminated failure returned by the client. */
export interface UsageError {
  kind: "no-key" | "unauthorized" | "no-plan" | "network" | "invalid-response"
  /** Safe for display: never contains the API key. */
  message: string
}

/** Result of a usage fetch. */
export type UsageResult = { ok: true; snapshot: UsageSnapshot } | { ok: false; error: UsageError }
