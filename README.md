# paseo-plugin-zcode

[中文说明](README_CN.md)

A [Paseo](https://paseo.sh) provider plugin that adds **ZCode** — Z.ai's coding agent, backed by GLM — as an agent backend. It wraps the community [zcode-acp-server](https://github.com/william0wang/zcode-acp) ACP bridge with Paseo's `runAcpProvider()` shim: streaming, editing modes, permissions, session resume, and the model/thinking catalogs all arrive through the standard Agent Client Protocol. ZCode itself owns authentication, tools, models and conversation storage — your existing sign-in and GLM Coding Plan are used as-is, and no API keys are configured in Paseo.

> **Unofficial integration.** Not affiliated with or endorsed by Zhipu AI / Z.ai.

## How it works

```text
Paseo daemon
  └─ index.server.ts (this plugin)      finds the bridge, finds the ZCode CLI,
       └─ node <generated shim>         generates a launcher that sets ZCODE_BIN/ZCODE_NODE
            └─ zcode-acp-server         the ACP bridge (pinned in this repo's lockfile)
                 └─ zcode app-server    the real ZCode engine  ──▶  GLM (your Coding Plan)
```

The plugin ships no UI and no protocol code. On `paseo plugin add` / `update`, the manifest `build` runs `npm ci --omit=dev` inside the managed checkout, installing the exact bridge version pinned here. The plugin then locates that copy (preferring the checkout, then well-known global roots), resolves the ZCode CLI, and registers the provider `zcode`.

## Requirements

| Requirement | Notes |
| --- | --- |
| Paseo ≥ 0.11.0 on the daemon | provider-plugin API (`status`, `getCatalogCacheKey`, `registerUsageSource`); tested against 0.12.x |
| Node.js ≥ 22 on the daemon host | the bridge needs `node:sqlite`; a capable node binary is probed automatically and never resolves to the Electron daemon binary |
| ZCode installed and signed in | desktop app or CLI (≥ 0.14.8; the 0.16+ line is fully supported); credentials come from `~/.zcode/v2/config.json` |
| Plugins enabled | `"pluginsEnabled": true` at the root of `~/.paseo/config.json`, then `paseo reload` |
| npm + network on the daemon host | needed during `add`/`update` to install the bridge |

## What it contributes to Paseo

- A **`zcode` provider** — streaming, editing modes (Plan / Build / Edit / Guarded / Yolo), permissions, session resume, and the model + thinking catalogs, all over the standard Agent Client Protocol.
- A **GLM Coding Plan usage source** — the plugin registers a Paseo usage card (shown in **Usage** and `paseo usage`) that reads the same `~/.zcode/v2/config.json` credentials and queries the official quota endpoint, no bridge process spawned. On a standard Coding Plan account it shows the 5-hour, weekly, and MCP windows with reset times. On a non-official active provider (a gateway, custom endpoint, or a keyless plan) it degrades to `unavailable` rather than guessing.

## Install

Listed in the Paseo plugin registry as [`lianxin255/zcode`](https://paseo.sh/plugins):

```bash
paseo plugin add lianxin255/zcode
paseo plugin ls                   # expect: paseo-plugin-zcode  running
paseo provider diagnostic zcode   # expect: Status Ready, model list
```

Installing by repository URL (`paseo plugin add lianxin255/paseo-plugin-zcode`) works the same way and tracks `main` instead of the registry's approved pin.

![ZCode usage card in Paseo](images/zcode-usage-card.png)

Run agents as usual:

```bash
paseo run --provider zcode "Fix the failing test"
```

The first run installs the bridge and warms up ZCode's skill/plugin discovery, so the very first session can take a minute or two; the ACP handshake window is 180 s.

## Upgrading

```bash
paseo plugin update paseo-plugin-zcode
```

This re-checks out `main`, re-runs `npm ci`, and reloads. New bridge versions flow through this repo: bump `zcode-acp-server` in `package.json`, regenerate the lockfile, tag a release. A globally installed bridge (`npm i -g zcode-acp-server`) is honored as a fallback, but the checkout-local copy always takes precedence so the bridge version stays pinned to a plugin release.

## Configuration

Nothing to configure when ZCode is at a default location: `/Applications/ZCode.app` (macOS), `%LOCALAPPDATA%\Programs\ZCode` (Windows), or a `zcode` entry on `PATH` that resolves to a `.cjs`/`.js` file. For custom layouts, use the provider entry in `~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "zcode": {
        "env": { "ZCODE_BIN": "D:\\Tools\\ZCode\\resources\\glm\\zcode.cjs" }
      }
    }
  }
}
```

`command` overrides (replace/append) for the bridge launch are also applied by the daemon. Run `paseo reload` after editing.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `paseo plugin ls` shows an error | `paseo plugin logs paseo-plugin-zcode`; usually Node < 22 or npm unavailable during the build step |
| `Failed to create agent: Internal error` | the ZCode backend died at boot. Check the bridge diary `~/.zcode/cli/log/zcode-acp-<date>.log`; if it says `无法定位 CLI ZCode Built-in Provider Config`, the plugin could not find the real `zcode.cjs` — set `agents.providers.zcode.env.ZCODE_BIN` |
| status: `zcode-acp-server was not found` | `paseo plugin update` to re-install the bridge, or `npm i -g zcode-acp-server` |
| status shows a too-old Node | install Node ≥ 22 on the daemon host, or point `agents.providers.zcode.command` at a specific node binary |
| Usage card shows `quota endpoint reported no limits` | your active ZCode provider is not an official Coding Plan (e.g. a gateway/custom endpoint, or keyless after a plan upgrade). Expected — the official quota API has nothing to report. Sign into a Coding Plan account to populate the card. |
| first session slow, later ones fine | expected warm-up (bridge install + skill discovery) |

`paseo provider diagnostic zcode` always shows the exact bridge version and node binary the plugin will launch, including whether a `ZCODE_BIN` override is in effect.

## Platform notes

- **macOS** — reference platform, end-to-end tested with Paseo 0.12 (app-hosted daemon; verified across multiple real sessions including streaming turns and model discovery).
- **Linux** — same code path as macOS; standard installs should work but are not yet confirmed on real hardware. Set `env.ZCODE_BIN` if your CLI lives outside the scanned roots.
- **Windows** — supported in code: the generated launcher needs no shell (`/usr/bin/env` is used on no platform), and the default ZCode app-bundle location is discovered automatically. **Not yet verified on real hardware** — if you hit problems (especially around ZCode child-process cleanup or custom install locations), please open an issue; `env.ZCODE_BIN` pointing at the full path of `zcode.cjs` resolves most layout problems.

## Development

- `index.server.ts` — provider registration: bridge/node/CLI resolution and the generated launcher shim. `server/usage.ts` — the GLM Coding Plan usage source. No client entry, no build artifacts committed.
- `npm run typecheck` — checks against `@getpaseo/plugin` (a devDependency; the host provides it at runtime).
- `npm run smoke` — compiles the plugin and drives a real ACP session through it (status probe, bridge handshake, usage discover+fetch).
- `main` is what `paseo plugin add` tracks; releases are git tags (`v0.3.2` style).

## License

[MIT](LICENSE) for this plugin. The bridge it installs (`zcode-acp-server`) ships under its own Apache-2.0 license from npm. The icon is Z.ai's logo mark, used nominatively to indicate which agent this plugin wraps.
