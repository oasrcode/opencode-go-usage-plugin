/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import type { JSX } from "@opentui/solid"
import { Plugin } from "@opencode/plugin/tui"

/**
 * The V2 plugin context. The entrypoint re-exports the module namespace as
 * `Plugin` (there is no top-level `Context` export), so the context type is
 * reached through `Plugin.Context`.
 */
type Context = Plugin.Context

import { fetchUsage } from "./usage/client"
import { createRefreshController, type RefreshController } from "./usage/refresh"
import {
  formatFreshness,
  formatPercent,
  formatReset,
  resetsInMs,
  severity,
  WINDOW_LABELS,
} from "./usage/windows"
import {
  USAGE_WINDOW_KEYS,
  type UsageError,
  type UsageSnapshot,
  type UsageWindow,
  type UsageWindowKey,
} from "./usage/types"

/** Stable plugin id used by opencode to address this plugin. */
export const id = "opencode-usage-plugin"

/** `storage.store` key holding the last successful snapshot so mount paints instantly. */
export const SNAPSHOT_KEY = "opencode-usage:snapshot"

/** Number of milliseconds between two local countdown ticks (no network). */
const TICK_INTERVAL_MS = 1000

/**
 * Map a normalized fetch failure to a short, user-facing Spanish message.
 * The underlying `UsageError.message` is English and may be noisy in a narrow
 * sidebar, so we translate by `kind` instead.
 */
function errorMessage(kind: UsageError["kind"]): string {
  switch (kind) {
    case "no-key":
      return "Sin clave API de OpenCode Go"
    case "unauthorized":
      return "Clave API rechazada (401)"
    case "no-plan":
      return "Sin plan OpenCode Go activo"
    case "network":
      return "Sin conexión con el servicio"
    case "invalid-response":
      return "Respuesta inválida del servicio"
  }
}

/**
 * Wire-derived fields of a window persisted in the durable store. `resetsInMs` is
 * deliberately excluded: it is derived from `resetsAt`, the sidebar never reads
 * it (`buildSidebarView` recomputes the countdown on every render) and it does
 * not survive a JSON round-trip when `resetsAt` is unparseable (`normalizeWindows`
 * emits `NaN`, which `JSON.stringify` turns into `null`).
 */
type CachedUsageWindow = Omit<UsageWindow, "resetsInMs">

/** Shape persisted through `storage.store` (durable JSON, untrusted on read). */
interface PersistedSnapshot {
  windows: CachedUsageWindow[]
  fetchedAt: number
}

/** Initial durable value; `readCachedSnapshot` rejects it as an empty cache. */
const EMPTY_SNAPSHOT: PersistedSnapshot = { windows: [], fetchedAt: 0 }

/** Structural guard for the wire-derived fields loaded back from the store (untrusted). */
function isUsageWindow(value: unknown): value is CachedUsageWindow {
  if (typeof value !== "object" || value === null) return false
  const w = value as Record<string, unknown>
  return (
    (w.key === "rolling" || w.key === "weekly" || w.key === "monthly") &&
    typeof w.label === "string" &&
    typeof w.percent === "number" &&
    Number.isFinite(w.percent) &&
    typeof w.resetsAt === "string"
  )
}

/**
 * Read and validate the cached snapshot from the reactive store. Never throws;
 * returns `undefined` on garbage. The store is a proxied object, so a plain
 * synchronous property read yields the current value (instant paint).
 */
function readCachedSnapshot(store: PersistedSnapshot): UsageSnapshot | undefined {
  const raw: unknown = store
  if (typeof raw !== "object" || raw === null) return undefined

  const candidate = raw as { windows?: unknown; fetchedAt?: unknown }
  if (!Array.isArray(candidate.windows)) return undefined
  if (typeof candidate.fetchedAt !== "number" || !Number.isFinite(candidate.fetchedAt)) return undefined

  // Rebuild the full `UsageWindow` by recomputing the derived `resetsInMs` from
  // `resetsAt`, so a stale (or JSON-nulled) cached value never leaks through.
  const now = Date.now()
  const windows: UsageWindow[] = candidate.windows
    .filter(isUsageWindow)
    .map((w) => ({ ...w, resetsInMs: resetsInMs(w.resetsAt, now) }))
  if (windows.length === 0) return undefined
  return { windows, fetchedAt: candidate.fetchedAt }
}

/** One display row of the sidebar body: pure data, no rendering concerns. */
export interface SidebarRow {
  label: string
  percentText: string
  /** Percentage used, or `undefined` when the window is absent (renderer picks the color). */
  percent: number | undefined
  resetText: string
}

/** Pure, total view model for the sidebar. Safe to call with any state. */
export interface SidebarView {
  header: string
  errorText: string | undefined
  loading: boolean
  rows: Record<UsageWindowKey, SidebarRow>
}

/**
 * Derive the sidebar's display data from the reactive state.
 *
 * Kept pure and total so it can be exercised without a terminal renderer; the
 * component below is only a thin adapter from this model to host elements.
 */
export function buildSidebarView(
  snapshot: UsageSnapshot | undefined,
  error: UsageError | undefined,
  loading: boolean,
  now: number,
): SidebarView {
  const rows = {} as Record<UsageWindowKey, SidebarRow>
  for (const key of USAGE_WINDOW_KEYS) {
    const win = snapshot?.windows.find((w) => w.key === key)
    rows[key] = {
      label: `${WINDOW_LABELS[key]} `,
      percentText: win ? formatPercent(win.percent) : "—",
      percent: win?.percent,
      resetText: ` ↻ ${win ? formatReset(resetsInMs(win.resetsAt, now)) : "—"}`,
    }
  }

  return {
    header: snapshot ? `OpenCode Go · ${formatFreshness(snapshot.fetchedAt, now)}` : "OpenCode Go",
    errorText: error ? errorMessage(error.kind) : undefined,
    loading,
    rows,
  }
}

interface UsageSidebarProps {
  theme: Context["theme"]
  snapshot: Accessor<UsageSnapshot | undefined>
  error: Accessor<UsageError | undefined>
  loading: Accessor<boolean>
  /** Ticking clock driving the local countdown / freshness label. */
  now: Accessor<number>
}

/**
 * Compact sidebar body: one header line plus one line per quota window.
 *
 * Reads only theme tokens and signals; never touches the API key and never
 * throws out of render (all formatting logic lives in `buildSidebarView`).
 */
function UsageSidebar(props: UsageSidebarProps): JSX.Element {
  const muted = () => props.theme.text.muted

  const view = createMemo(() =>
    buildSidebarView(props.snapshot(), props.error(), props.loading(), props.now()),
  )

  /** Percent color by severity, using real theme tokens (normal → success). */
  const percentColor = (percent: number | undefined) => {
    if (percent === undefined) return muted()
    switch (severity(percent)) {
      case "error":
        return props.theme.text.feedback.error.base
      case "warning":
        return props.theme.text.feedback.warning.base
      default:
        return props.theme.text.feedback.success.base
    }
  }

  return (
    <box flexDirection="column">
      <text fg={muted()}>{view().header}</text>

      <Show when={view().errorText}>
        {(text) => <text fg={props.theme.text.feedback.error.base}>{text()}</text>}
      </Show>

      <Show
        when={props.snapshot()}
        fallback={
          <Show when={props.loading()}>
            <text fg={muted()}>Cargando…</text>
          </Show>
        }
      >
        <For each={USAGE_WINDOW_KEYS}>
          {(key) => {
            const row = () => view().rows[key]
            return (
              // One row box per window: separate <text> nodes keep each color
              // independently typed (span's `fg` is not exposed in this version).
              <box flexDirection="row">
                <text fg={muted()}>{row().label}</text>
                <text fg={percentColor(row().percent)}>{row().percentText}</text>
                <text fg={muted()}>{row().resetText}</text>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

/** Reactive state exposed by {@link createUsageWidget}. */
export interface UsageWidget {
  snapshot: Accessor<UsageSnapshot | undefined>
  error: Accessor<UsageError | undefined>
  loading: Accessor<boolean>
  now: Accessor<number>
  /** Release every owned resource (idempotent). */
  dispose: () => void
}

/**
 * Wire the usage widget: cache paint, refresh controller, tick interval,
 * `session.idle` subscription, keymap layer and `sidebar.content` slot.
 *
 * V2 cleanup is the function RETURNED from `setup`, so resource allocation is
 * wrapped in `try/catch`: any failure halfway through tears down whatever was
 * already created before re-throwing, keeping partial failures leak-free. Every
 * disposer is guarded so a partially-initialized widget disposes without
 * throwing. Unlike V1 key map layers (which had an explicit unregister handle),
 * `context.keymap.layer` is scoped to the plugin and removed by the host on
 * deactivate, so no disposer is needed for it.
 */
export function createUsageWidget(context: Context): UsageWidget {
  const [snapshot, setSnapshot] = createSignal<UsageSnapshot | undefined>(undefined)
  const [error, setError] = createSignal<UsageError | undefined>(undefined)
  const [loading, setLoading] = createSignal(true)
  const [now, setNow] = createSignal(Date.now())

  // Disposers, assigned as their resources come up. Each is guarded so a
  // partially-initialized widget disposes without throwing.
  let controller: RefreshController | undefined
  let tick: ReturnType<typeof setInterval> | undefined
  let unsubscribeIdle: (() => void) | undefined
  let unregisterSlot: (() => void) | undefined
  let disposed = false

  const dispose = () => {
    // A host may invoke cleanup more than once; run it at most once.
    if (disposed) return
    disposed = true
    controller?.dispose()
    if (tick !== undefined) clearInterval(tick)
    unsubscribeIdle?.()
    unregisterSlot?.()
  }

  try {
    // Durable, reactive store: hydrated from disk by the host before we read it.
    const [cachedStore, persistSnapshot] = context.storage.store<PersistedSnapshot>(SNAPSHOT_KEY, {
      initial: EMPTY_SNAPSHOT,
    })
    const cached = readCachedSnapshot(cachedStore)
    if (cached) {
      setSnapshot(cached)
      setLoading(false)
    }

    controller = createRefreshController({
      fetch: () => fetchUsage(),
      now: () => Date.now(),
      cache: cached,
      onUpdate: (result) => {
        if (result.ok) {
          setSnapshot(result.snapshot)
          setError(undefined)
          // Cache persistence is best-effort; never break the widget over it.
          try {
            void persistSnapshot((draft) => {
              draft.windows = result.snapshot.windows
              draft.fetchedAt = result.snapshot.fetchedAt
            }).catch(() => {})
          } catch {
            // Swallow synchronous updater failures too.
          }
        } else {
          // Keep the last good snapshot visible while surfacing the failure.
          setError(result.error)
        }
        setLoading(false)
      },
    })

    // Local-only countdown: recompute reset durations every second, no network.
    tick = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS)

    unsubscribeIdle = context.data.on("session.idle", () => {
      void controller?.trigger("idle")
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "usage.refresh",
          title: "Refrescar uso OpenCode Go",
          description: "Vuelve a consultar las cuotas de OpenCode Go",
          group: "System",
          palette: true,
          // A literal binding is used instead of V1's `<leader>o`: V2 leader
          // tokens are an opt-in keymap addon (`registerLeader`) whose presence
          // in the host is not guaranteed, whereas `ctrl+g` is parsed by the
          // default key parser. `palette: true` keeps the command reachable
          // from the command palette regardless.
          bind: "ctrl+g",
          run: () => {
            void controller?.trigger("manual")
          },
        },
      ],
      // IDs of commands whose configured bindings should be active in this layer.
      bindings: ["usage.refresh"],
    }))

    unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      // The slot input carries only `sessionID`, unused here because the widget
      // closes over the plugin-scoped signals above.
      render: () => (
        <UsageSidebar
          theme={context.theme}
          snapshot={snapshot}
          error={error}
          loading={loading}
          now={now}
        />
      ),
    })

    // Paint cache (if any) and fetch in parallel; fire-and-forget by contract.
    void controller.trigger("mount")
  } catch (err) {
    // A throwing setup cannot return the cleanup, so run it here and re-throw.
    dispose()
    throw err
  }

  return { snapshot, error, loading, now, dispose }
}

/**
 * TUI entry point. opencode 2.0 calls `setup` once with the plugin `Context` and
 * keeps the returned cleanup for teardown.
 *
 * Wave 3 (V2): real sidebar widget wired to the data layer + refresh scheduler:
 *  - paints the store-cached snapshot immediately, then refreshes on mount;
 *  - refreshes on the controller's own timer and on `session.idle`;
 *  - exposes a `usage.refresh` command (command palette, `ctrl+g`) for manual refresh;
 *  - ticks a local clock every second for the reset countdown (no network);
 *  - the returned cleanup disposes the controller, interval, listener and slot.
 */
export default Plugin.define({
  id,
  async setup(context: Context) {
    const widget = createUsageWidget(context)
    return () => widget.dispose()
  },
})
