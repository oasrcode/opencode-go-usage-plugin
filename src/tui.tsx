/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"

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

/** `api.kv` key holding the last successful snapshot so mount paints instantly. */
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

/** Structural guard for a window loaded back from the KV cache (untrusted). */
function isUsageWindow(value: unknown): value is UsageWindow {
  if (typeof value !== "object" || value === null) return false
  const w = value as Record<string, unknown>
  return (
    (w.key === "rolling" || w.key === "weekly" || w.key === "monthly") &&
    typeof w.label === "string" &&
    typeof w.percent === "number" &&
    Number.isFinite(w.percent) &&
    typeof w.resetsAt === "string" &&
    typeof w.resetsInMs === "number"
  )
}

/** Read and validate the cached snapshot. Never throws; returns `undefined` on garbage. */
function readCachedSnapshot(api: TuiPluginApi): UsageSnapshot | undefined {
  let raw: unknown
  try {
    raw = api.kv.get<unknown>(SNAPSHOT_KEY, undefined)
  } catch {
    return undefined
  }
  if (typeof raw !== "object" || raw === null) return undefined

  const candidate = raw as { windows?: unknown; fetchedAt?: unknown }
  if (!Array.isArray(candidate.windows)) return undefined
  if (typeof candidate.fetchedAt !== "number" || !Number.isFinite(candidate.fetchedAt)) return undefined

  const windows = candidate.windows.filter(isUsageWindow)
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
  api: TuiPluginApi
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
  const theme = () => props.api.theme.current
  const muted = () => theme().textMuted

  const view = createMemo(() =>
    buildSidebarView(props.snapshot(), props.error(), props.loading(), props.now()),
  )

  /** Percent color by severity, using real theme tokens (normal → success). */
  const percentColor = (percent: number | undefined) => {
    if (percent === undefined) return muted()
    const t = theme()
    switch (severity(percent)) {
      case "error":
        return t.error
      case "warning":
        return t.warning
      default:
        return t.success
    }
  }

  return (
    <box flexDirection="column">
      <text fg={muted()}>{view().header}</text>

      <Show when={view().errorText}>
        {(text) => <text fg={theme().error}>{text()}</text>}
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
}

/**
 * Wire the usage widget: cache paint, refresh controller, tick interval,
 * `session.idle` subscription, keymap layer and sidebar slot.
 *
 * The dispose handler is registered BEFORE any resource is allocated (N1) and
 * reads the disposers through guarded `let` bindings, so a failure halfway
 * through setup still tears down whatever was already created. `api.slots`
 * has no unregister API, so slot cleanup is left to the host.
 */
export function createUsageWidget(api: TuiPluginApi): UsageWidget {
  const [snapshot, setSnapshot] = createSignal<UsageSnapshot | undefined>(undefined)
  const [error, setError] = createSignal<UsageError | undefined>(undefined)
  const [loading, setLoading] = createSignal(true)
  const [now, setNow] = createSignal(Date.now())

  // Disposers, assigned as their resources come up. Each is guarded so a
  // partially-initialized widget disposes without throwing.
  let controller: RefreshController | undefined
  let tick: ReturnType<typeof setInterval> | undefined
  let unsubscribeIdle: (() => void) | undefined
  let unregisterKeymap: (() => void) | undefined

  api.lifecycle.onDispose(() => {
    controller?.dispose()
    if (tick !== undefined) clearInterval(tick)
    unsubscribeIdle?.()
    unregisterKeymap?.()
  })

  const cached = readCachedSnapshot(api)
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
        try {
          api.kv.set(SNAPSHOT_KEY, result.snapshot)
        } catch {
          // Cache persistence is best-effort; never break the widget over it.
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

  unsubscribeIdle = api.event.on("session.idle", () => {
    void controller?.trigger("idle")
  })

  unregisterKeymap = api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "usage.refresh",
        title: "Refrescar uso OpenCode Go",
        desc: "Vuelve a consultar las cuotas de OpenCode Go",
        category: "System",
        run: () => {
          void controller?.trigger("manual")
        },
      },
    ],
    // `<leader>o` is free among opencode's default keybinds (leader = ctrl+x).
    // The command is also reachable from the command palette (ctrl+p).
    bindings: [{ key: "<leader>o", cmd: "usage.refresh" }],
  })

  api.slots.register({
    order: 50,
    // SlotRenderer is invoked as (context, props); both are unused here because
    // the widget closes over the plugin-scoped signals above.
    slots: {
      sidebar_content: (_ctx, _props) => (
        <UsageSidebar api={api} snapshot={snapshot} error={error} loading={loading} now={now} />
      ),
    },
  })

  // Paint cache (if any) and fetch in parallel; fire-and-forget by contract.
  void controller.trigger("mount")

  return { snapshot, error, loading, now }
}

/**
 * TUI entry point. opencode calls this once with the plugin API.
 *
 * Wave 3: real sidebar widget wired to the data layer + refresh scheduler:
 *  - paints the KV-cached snapshot immediately, then refreshes on mount;
 *  - refreshes on the controller's own timer and on `session.idle`;
 *  - exposes a `usage.refresh` command (command palette) for a manual refresh;
 *  - ticks a local clock every second for the reset countdown (no network);
 *  - disposes the controller, interval, listener and keymap layer on dispose.
 */
export const tui: TuiPlugin = async (api) => {
  createUsageWidget(api)
}

// opencode's loader reads the module DEFAULT export (a `{ id, tui }` object);
// named exports are ignored. We also keep the named exports above for tests/types.
const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
