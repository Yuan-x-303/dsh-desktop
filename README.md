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

## Interop with the official DeepSeek Harness (session data location)

Sessions are plain files under the configured `home`:

```
<home>\sessions\<workspace-key>\session-<id>\session.jsonl.zstd
```

Any `dsh` instance — this app's bundled one or the official `dsh web` CLI —
that points at the **same `home`** reads the same files. By default everything
already lines up:

- This app defaults to `home = ~/.dsh` and `workspace = ~/dsh-workspace` —
  identical to the official CLI's defaults. So **out of the box, sessions
  created here and in the official web UI are the same files** and interoperate
  (settings and API keys in `home` are shared too).
- The sidebar groups sessions by workspace; different workspaces in the same
  home are all listed (each as its own group). New sessions land in the current
  workspace.
- The workspace registry (`<home>\storages\workspace.json`) is rebuilt from the
  sessions folder **on startup**, so sessions created by another instance appear
  after a restart — there is no live cross-process sync.

Two things break the shared view, and both are the usual cause of "my sessions
disappeared":

1. **A different `home`**: if you create `%APPDATA%\dsh-desktop\config.json`
   (or set `DSH_HOME`) for this app but launch the official CLI without the
   same setting, each entry point reads a different folder. To share, launch
   the official CLI with the same home/workspace, e.g. in PowerShell:
   ```powershell
   $env:DSH_HOME='E:\somewhere\.dsh'; $env:DSH_WORKSPACE='E:\somewhere\workspace'; dsh web
   ```
2. **Running both at the same time**: each instance appends to the same session
   log file (zstd frames) with **no cross-process lock**. Two instances writing
   one home concurrently can tear or corrupt a session log. Use one entry point
   at a time (the ports never clash — this app uses a random port, the official
   CLI uses 3080).

Version pinning: this app bundles a specific `@deepseek-ai/dsh` (see
`package.json`). Session logs carry a format version; if the official harness
ships a newer session format, this app refuses to open those sessions until the
bundled harness is upgraded (see [Upgrading](#upgrading-deepseek-harness)).

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
scripts/generate-icon.mjs   regenerate the default build/icon.png & build/icon.ico
scripts/import-icon.mjs     import a custom icon from build/icon-source.jpg
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
  This is outside the install folder: uninstalling or reinstalling the app does
  **not** remove your data. To keep sessions across machines (or after a
  reinstall of Windows), back up `~/.dsh` and `~/dsh-workspace`.
- **My yesterday's sessions are gone** — the session files are never deleted;
  the app is probably reading a different `home` than before. Check
  `%APPDATA%\dsh-desktop\config.json`: if it sets a `home`, the app reads only
  that home's sessions. Sessions written while no config existed live under the
  default `~/.dsh`. Point `home` back (or copy the session folders) to see them
  again — see [Interop with the official DeepSeek Harness](#interop-with-the-official-deepseek-harness-session-data-location).
- **Don't run this app and an official `dsh web` at the same time** — both
  append to the same session log files without a lock; concurrent use can
  corrupt a session. Close one before opening the other.
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

> **Session format compatibility**: session logs carry a format version. If a
> newer upstream Harness bumps that version, older builds refuse to open the
> new logs (and vice versa). Upgrade the bundle before it falls behind — an
> installed app whose bundled Harness is old will show your newer sessions as
> unreadable, not as deleted.

## Custom app icon

The app icon is `build/icon.ico` (Windows exe/taskbar) and `build/icon.png`
(512px, used as the base by the icon pipeline). Two ways to change it:

1. **From an image file** (recommended): drop a picture with a plain near-white
   background (e.g. a JPEG of your mascot on white) at `build/icon-source.jpg`,
   then run:

   ```sh
   npm run icon:import          # uses build/icon-source.jpg by default
   npm run icon:import path\to\my.png   # or point at any file
   ```

   The script flood-fills the near-white background from the image edges
   (keeping white areas *inside* the subject), feathers the boundary, removes
   the white halo, and writes a fresh `build/icon.png` + `build/icon.ico` plus a
   checkered `icon-preview.png` at the repo root so you can eyeball the cutout.
   The source file stays untouched.

2. **From scratch**: `npm run icon` regenerates the default terminal-prompt
   icon (this overwrites any custom icon — run it only if you want the default
   back).

Then rebuild the installer (`npm run dist`) — the exe and shortcuts pick up the
new icon automatically.

## Auto-update

The installed build checks for updates on launch (the portable build cannot
self-update). New versions are served from GitHub Releases via
[electron-updater](https://www.electron.build/auto-update).

To wire it up:

1. Create a GitHub repo and push this project.
2. In `electron-builder.yml`, replace `publish.owner` (currently
   `YOUR_GITHUB_USERNAME`) with your GitHub username.
3. Push a version tag — `git tag v0.3.0 && git push origin --tags` — and the
   release workflow builds, publishes the installer + `latest.yml` + blockmap
   to GitHub Releases.
4. If the release is created as a draft, click **Publish** on the release page
   so installed apps can see it.

End users then get a "restart to update" prompt automatically; no re-download
is needed. Note: binaries are not code-signed yet, so antivirus may flag the
downloaded update just as it does the initial installer.

## Contributing

PRs welcome. Regenerate assets with `npm run icon` and `npm run fetch:node` as
needed; do not commit `release/` or `resources/runtime/`.

## License

[MIT](LICENSE). This project is a community launcher and is not affiliated with
or endorsed by DeepSeek.
