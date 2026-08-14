# DSH Desktop

One-click desktop launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It starts the Harness Web UI in a native window with **zero setup** — the end user does not need Node.js or anything else installed.

- **Zero dependency**: a portable Node.js runtime is bundled, so `dsh web` runs out of the box.
- **Portable & installable**: ship a single `.exe` (portable) or a per-user installer (NSIS).
- **Auto port**: passes `--port 0` and parses the real URL from stdout — no port clashes.
- **Loopback only**: forces `--host 127.0.0.1`, so the Harness server is never exposed to the LAN.
- **Single instance**: launching again focuses the existing window.
- **Clean lifecycle**: closing the window stops `dsh` and its child processes; if `dsh` crashes, the app closes.
- **Friendly startup**: a loading screen is shown while `dsh` boots; failures show the captured log.

## Install

Download the latest release from the **Releases** page of this repository:

- `DSH-Desktop-<version>-setup.exe` — installer (per-user, no admin rights needed).
- `DSH-Desktop-<version>-portable.exe` — portable, no install.

Windows SmartScreen may warn on first run because binaries are not yet code-signed; click **More info → Run anyway**.

## Develop

Requirements: Node.js ≥ 20 (verified on v24). Built against `@deepseek-ai/dsh` 0.1.0-rc.6.

```bash
npm install
npm start          # compiles TS and launches Electron
```

## Build the installer

```bash
npm run dist       # fetch Node runtime + compile + electron-builder --win
```

Artifacts land in `release/`. The first build downloads the portable Node runtime
(once, cached in `resources/runtime/node.exe`) and electron-builder's NSIS tooling.

> `npm run dist` refuses to run while DSH Desktop is running from
> `release\win-unpacked` (the build clears that directory, and a running app
> locks its files). Close the app first, or set `SKIP_GUARD=1` if you know
> what you are doing.

## Configuration

The launcher reads a `config.json` (optional). It is looked up, in order:

1. `<project>/config.json` — development only.
2. `%APPDATA%\dsh-desktop\config.json` — **packaged builds** and a shared
   user-level override (this is where you point an installed/portable build at
   your existing workspace and DSH data).
3. `./config.json` (process working directory).

See [`config.example.json`](config.example.json):

```json
{
  "workspace": "C:\\Users\\<you>\\dsh-workspace",
  "home": "C:\\Users\\<you>\\.dsh"
}
```

| Field       | Meaning                                        | Default             |
| ----------- | ---------------------------------------------- | ------------------- |
| `workspace` | Harness workspace root (agent file I/O)        | `~/dsh-workspace`   |
| `home`      | Harness data dir (settings, keys, sessions)    | `~/.dsh`            |

Precedence: `config.json` → env var → default.

Environment variables:

| Variable           | Purpose                                   | Default            |
| ------------------ | ----------------------------------------- | ------------------ |
| `DSH_WORKSPACE`    | workspace root (`config.json` wins)        | `~/dsh-workspace`  |
| `DSH_HOME`         | Harness data dir (`config.json` wins)      | `~/.dsh`           |
| `DSH_DESKTOP_NODE` | node executable used to run `dsh`          | bundled runtime    |

## How it works

```
start.bat (dev only)
   └─ electron .            main process
        ├─ spawn <node> dsh web --host 127.0.0.1 --port 0   (bundled Node in packaged builds)
        ├─ parse stdout: "dsh web: http://127.0.0.1:PORT"
        ├─ show a loading screen while dsh boots
        └─ open BrowserWindow at that URL (external links go to the system browser)
```

`node_modules` is shipped unpacked (`asar: false`) so the bundled Node can read
`@deepseek-ai/dsh` as plain files. Native modules are not rebuilt for Electron
because `dsh` runs under the bundled Node, not inside Electron.

## Project structure

```
src/electron/main.ts        window + lifecycle + navigation guard
src/electron/dsh.ts         spawn dsh + resolve bundled Node / dsh bin
scripts/fetch-node.mjs      download portable Node runtime
scripts/generate-icon.mjs   regenerate build/icon.png & build/icon.ico
scripts/guard-dist.mjs      predist guard: refuse to package while the app is running
electron-builder.yml        packaging config (NSIS + portable)
config.example.json         configuration template
```

## Troubleshooting

- **Windows SmartScreen warning on first run** — the binaries are not code-signed
  yet; click **More info → Run anyway**.
- **First launch is slow** — the first boot installs the profile's plugins under
  `$DSH_HOME/profiles`; subsequent launches are fast.
- **Where is my data?** — sessions/settings live under the configured `home`
  (default `~/.dsh`), workspace files under `workspace` (default `~/dsh-workspace`).
- **`npm run dist` refuses to run** — DSH Desktop is still running from
  `release\win-unpacked`; close it first (see the Build section).

## Upgrading DeepSeek Harness

The desktop shell is a thin wrapper; all features come from the bundled
`@deepseek-ai/dsh` package, which does **not** update automatically. When a new
Harness version ships, bump it by hand:

1. Set the new version in `package.json`:
   ```json
   "@deepseek-ai/dsh": "0.2.0"
   ```
2. `npm install`
3. `npm run dist`
4. `npm run check:deps` — the dsh ecosystem declares many plugins as
   `peerDependencies`, which electron-builder does **not** bundle. This script
   diffs the dev and packaged `@deepseek-ai` trees and prints any missing
   package (with its exact version) plus a JSON snippet to paste into
   `package.json`'s `dependencies`. Re-run `npm install && npm run dist` until
   it reports no gaps.
5. Smoke-test `release\win-unpacked\DSH Desktop.exe`.
6. Bump the app version, then `git tag v0.3.0 && git push origin --tags`.

> The explicit `@deepseek-ai/*` entries in `package.json`'s `dependencies`
> exist **because** of step 4 — they are the peer dependencies the launcher must
> declare so electron-builder includes them. Keep them when upgrading.

## Contributing

PRs welcome. Regenerate assets with `npm run icon` and `npm run fetch:node` as
needed; do not commit `release/` or `resources/runtime/`.

## License

[MIT](LICENSE). This project is a community launcher and is not affiliated with
or endorsed by DeepSeek.
