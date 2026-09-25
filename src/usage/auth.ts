/**
 * Resolve and read the OpenCode Go API key from `auth.json`.
 *
 * `auth.json` lives in the OpenCode DATA dir (e.g. `~/.local/share/opencode`), which
 * the TUI plugin API does not expose, so we probe a list of candidate locations.
 * Everything here accepts injected `env` / `dataDir` / `readFile` so it stays pure
 * and testable without touching the real filesystem.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Provider keys we accept, most specific first. */
const PROVIDER_KEYS = ["opencode-go", "opencode"] as const

export interface ResolveAuthPathOverrides {
  /** Explicit OpenCode data dir to check first. */
  dataDir?: string
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

export interface ReadApiKeyOptions extends ResolveAuthPathOverrides {
  /** Fully-resolved path to `auth.json`; skips candidate probing when given. */
  authPath?: string
  /** Injectable file reader (receives a path, returns UTF-8 contents). */
  readFile?: (path: string) => string
}

/** Build the candidate data directories, in priority order. */
function candidateDataDirs(overrides: ResolveAuthPathOverrides): string[] {
  const env = overrides.env ?? process.env
  const home = homedir()
  const dirs: string[] = []

  if (overrides.dataDir) dirs.push(overrides.dataDir)
  if (env.OPENCODE_DATA_HOME) dirs.push(env.OPENCODE_DATA_HOME)
  if (env.XDG_DATA_HOME) dirs.push(join(env.XDG_DATA_HOME, "opencode"))

  switch (process.platform) {
    case "darwin":
      dirs.push(join(home, "Library", "Application Support", "opencode"))
      break
    case "win32": {
      const appData = env.APPDATA ?? join(home, "AppData", "Roaming")
      dirs.push(join(appData, "opencode"))
      break
    }
    default:
      dirs.push(join(home, ".local", "share", "opencode"))
  }

  return dirs
}

/**
 * Return the first existing `auth.json` among the candidate data dirs, or
 * `undefined` when none exists.
 */
export function resolveAuthPath(overrides: ResolveAuthPathOverrides = {}): string | undefined {
  for (const dir of candidateDataDirs(overrides)) {
    const candidate = join(dir, "auth.json")
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Read the OpenCode Go API key.
 *
 * Prefers the `opencode-go` provider entry and falls back to `opencode`. Returns
 * `undefined` when the file is missing, unreadable, malformed, or has no key.
 * The file contents are never logged or returned.
 */
export function readApiKey(opts: ReadApiKeyOptions = {}): string | undefined {
  const authPath = opts.authPath ?? resolveAuthPath(opts)
  if (!authPath) return undefined

  const read = opts.readFile ?? ((path: string) => readFileSync(path, "utf8"))

  let parsed: unknown
  try {
    parsed = JSON.parse(read(authPath))
  } catch {
    return undefined
  }

  if (typeof parsed !== "object" || parsed === null) return undefined
  const auth = parsed as Record<string, { key?: unknown } | undefined>

  for (const provider of PROVIDER_KEYS) {
    const key = auth[provider]?.key
    if (typeof key === "string" && key.length > 0) return key
  }
  return undefined
}
