# opencode-go-usage-plugin

A widget for the [opencode](https://opencode.ai) TUI sidebar that keeps your **OpenCode Go** plan quota always visible — the 5-hour, weekly and monthly windows.

[Español](./README.es.md)

## What it does

- Shows the **percentage used** of each quota window: `5h`, `Weekly` and `Monthly`, colored by severity (green → amber → red).
- Shows the **countdown until each window resets** (`↻ 4h 13m`).
- Shows **data freshness** in the header (`1m ago`) and readable **error states**.
- **Caches** the last good snapshot so it paints instantly when opencode starts.
- **Refreshes itself** (on open, every 5 min, and when a turn finishes) and can also be refreshed **manually**.

## Preview

Real sidebar output:

```
OpenCode Go · 1m ago
5h 1% ↻ 4h 13m
Weekly 4% ↻ 2d 5h
Monthly 9% ↻ 19d 22h
```

## Requirements

- **opencode >= 1.18**.
- An active **OpenCode Go** plan (with its API key configured in opencode). Without a plan, the endpoint returns `403` and the widget says so.
- **Node >= 20** — development only. The opencode runtime (Bun) compiles the `.tsx` directly, so **no bundler or build step is needed**.

## Installation

### Option A — Local (verified)

1. Install dependencies (only if you are going to edit it):

   ```sh
   npm install
   ```

2. Register the plugin in the **TUI** config (not in `opencode.json`). Create or edit `~/.config/opencode/tui.json` with an **absolute path** to the entrypoint:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["/absolute/path/to/opencode-go-usage-plugin/src/tui.tsx"]
   }
   ```

   > `plugin` is an array; each entry can be a `string` or a `[spec, options]` pair. The **absolute path** form is the one that is verified.

3. **Restart opencode.** The "OpenCode Go" block should appear in the session sidebar.

### Option B — npm (once the package is published)

Install it with the opencode plugin command (it updates the config for you):

```sh
opencode plugin opencode-go-usage-plugin
```

Or add it by hand to `~/.config/opencode/tui.json` using the package spec:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-go-usage-plugin"]
}
```

> The package exposes its entrypoint at the `./tui` subpath (`exports["./tui"]`). If your loader version does not resolve the default export, use the explicit subpath: `opencode-go-usage-plugin/tui`.

Then **restart opencode**.

## Refresh policy

The plugin queries the official usage endpoint with this policy:

| Trigger | When |
| --- | --- |
| **On open** (`mount`) | Paints the cache (if any) and fires a fetch in parallel. |
| **Timer** | Every **5 min**, only if the last fetch is 5 min old or more. |
| **Turn finished** (`session.idle`) | When a turn ends, with a **60 s** debounce to absorb bursts. |
| **Manual** | Command **"Refresh OpenCode Go usage"**: `Ctrl+X` then `o`, or `Ctrl+P` → palette → *"Refresh OpenCode Go usage"*. Has a **30 s cooldown**. |

**Hard floor:** never more than **1 request every 60 s**, whatever the trigger. On error, retries back off `5 → 10 → 20 → 30 min` (capped) and reset on the first success.

The reset countdown is recomputed **locally every second**, with no network access.

## Privacy

- The **API key is read at runtime** from opencode's `auth.json` (it looks for the `opencode-go` provider entry, falling back to `opencode`). The plugin **never logs or persists it**: it is not written to logs, the KV cache, or error messages.
- The only network call is `GET https://opencode.ai/zen/go/v1/usage` (the official usage endpoint), with `Authorization: Bearer <key>`. The original network error is deliberately discarded so headers cannot leak.
- The **KV cache** stores only the snapshot of percentages and dates, never the key.

## Troubleshooting

- **The plugin does not show up**
  - Check that the plugin is registered with `/plugins` inside opencode.
  - Start with verbose logs: `opencode --print-logs --log-level DEBUG` and look for plugin or `sidebar_content` slot errors.
  - Verify the path in `tui.json` is **absolute** and the file exists.

- **"No OpenCode Go API key"**
  - `auth.json` was not found, or it has no `opencode-go`/`opencode` entry with a `key`.
  - Authenticate in opencode with your OpenCode Go account and retry.

- **"No active OpenCode Go plan"**
  - The endpoint returned `403`: the account has no active OpenCode Go plan (or the key belongs to another provider).

- **"API key rejected (401)"**
  - The key exists but the service rejected it; authenticate again.

- **"Could not reach the service" / "Invalid response from the service"**
  - Network failure, timeout (10 s), or an unexpected payload. The widget keeps the last good data visible while showing the error.

- **Disabling it**
  - Set `plugin_enabled` to `false` in `tui.json`, or remove the entry from the `plugin` array, and restart opencode.

## Development

```sh
npm install        # dependencies
npm run typecheck  # npx tsc --noEmit
npm test           # npx vitest run
```

There is no build step: opencode loads `src/tui.tsx` directly.

## License

[MIT](./LICENSE).
