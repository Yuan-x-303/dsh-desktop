#!/usr/bin/env node
// Download a portable Node.js runtime so the packaged app can run `dsh web`
// without the end user having Node installed. Node's own TLS stack is used
// (schannel/curl are not used, so this works in constrained environments too).
//
// Usage:
//   node scripts/fetch-node.mjs            # download if missing, else skip
//   NODE_VERSION=v22.12.0 node scripts/fetch-node.mjs
//   FETCH_NODE_FORCE=1 node scripts/fetch-node.mjs
import { createWriteStream, mkdirSync, rmSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(root, 'resources', 'runtime');
const version = process.env.NODE_VERSION || 'v24.18.1';
const zipName = `node-${version}-win-x64.zip`;
const zipUrl = `https://nodejs.org/dist/${version}/${zipName}`;
const zipPath = join(runtimeDir, zipName);
const extractDir = join(runtimeDir, '.extract');
const nodeExe = join(runtimeDir, 'node.exe');

mkdirSync(runtimeDir, { recursive: true });

if (existsSync(nodeExe) && !process.env.FETCH_NODE_FORCE) {
  console.log(`[fetch-node] ${nodeExe} already exists — skipping (set FETCH_NODE_FORCE=1 to redownload)`);
  process.exit(0);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        rmSync(dest, { force: true });
        resolve(download(res.headers.location, dest));
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        rmSync(dest, { force: true });
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', (err) => {
      file.close();
      rmSync(dest, { force: true });
      reject(err);
    });
  });
}

console.log(`[fetch-node] downloading ${zipUrl}`);
await download(zipUrl, zipPath);
console.log('[fetch-node] extracting node.exe ...');

rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });
const res = spawnSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' });
if (res.status !== 0) {
  console.error('[fetch-node] tar extraction failed');
  process.exit(res.status ?? 1);
}

const entries = readdirSync(extractDir);
const top = entries.find((e) => !e.startsWith('.'));
const extractedExe = top ? join(extractDir, top, 'node.exe') : null;
if (!extractedExe || !existsSync(extractedExe)) {
  console.error(`[fetch-node] node.exe not found under ${extractDir}`);
  process.exit(1);
}

cpSync(extractedExe, nodeExe);
rmSync(extractDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
console.log(`[fetch-node] wrote ${nodeExe}`);
