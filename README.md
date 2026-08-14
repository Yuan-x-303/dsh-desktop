# DSH Desktop

One-click desktop launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It starts the Harness Web UI in a native window with **zero setup** — the end user does not need Node.js or anything else installed.

- **Zero dependency**: a portable Node.js runtime is bundled, so `dsh web` runs out of the box.
- **Portable & installable**: ship a single `.exe` (portable) or a per-user installer (NSIS).
- **Auto port**: passes `--port 0` and parses the real URL from stdout — no port clashes.
- **Single instance**: launching again focuses the existing window.
- **Clean lifecycle**: closing the window stops `dsh`; if `dsh` crashes, the app closes.

## Install

Download the latest release from the [Releases](https://github.com/<owner>/dsh-desktop/releases) page:

- `DSH-Desktop-<version>-setup.exe` — installer (per-user, no admin rights needed).
- `DSH-Desktop-<version>-portable.exe` — portable, no install.

Windows SmartScreen may warn on first run because binaries are not yet code-signed; click **More info → Run anyway**.

## Develop

Requirements: Node.js ≥ 20 (verified on v24).

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

## Configuration

The launcher reads `config.json` (optional, at the project root in dev). See
[`config.example.json`](config.example.json):

```json
{
  "workspace": "E:\\Deepseek Harness\\workspace",
  "home": "E:\\Deepseek Harness\\.dsh"
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
        ├─ spawn <node> dsh web --port 0    (bundled Node in packaged builds)
        ├─ parse stdout: "dsh web: http://127.0.0.1:PORT"
        └─ open BrowserWindow at that URL
```

`node_modules` is shipped unpacked (`asar: false`) so the bundled Node can read
`@deepseek-ai/dsh` as plain files. Native modules are not rebuilt for Electron
because `dsh` runs under the bundled Node, not inside Electron.

## Project structure

```
src/electron/main.ts        window + lifecycle
src/electron/dsh.ts         spawn dsh + resolve bundled Node / dsh bin
scripts/fetch-node.mjs      download portable Node runtime
scripts/generate-icon.mjs   regenerate build/icon.png & build/icon.ico
electron-builder.yml        packaging config (NSIS + portable)
config.example.json         configuration template
```

## Contributing

PRs welcome. Regenerate assets with `npm run icon` and `npm run fetch:node` as
needed; do not commit `release/` or `resources/runtime/`.

## License

[MIT](LICENSE). This project is a community launcher and is not affiliated with
or endorsed by DeepSeek.
