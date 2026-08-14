#!/usr/bin/env node
// Predist guard: refuse to package while DSH Desktop is running from
// release\win-unpacked. electron-builder clears that directory before copying
// the new build, so a running app locks files (e.g. d3dcompiler_47.dll) and the
// build fails mid-copy with EPERM, leaving win-unpacked half-deleted.
//
// Runs automatically before `npm run dist` (npm's predist lifecycle hook).
// Override with SKIP_GUARD=1 npm run dist if you know what you are doing.
import { openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exePath = join(root, 'release', 'win-unpacked', 'DSH Desktop.exe');

if (process.env.SKIP_GUARD === '1') {
  console.log('[guard-dist] SKIP_GUARD=1 — skipping running-app check.');
  process.exit(0);
}

// A process image is locked for writing while it runs on Windows. If the
// win-unpacked exe can't be opened r+, a process is running from there. The
// installed copy (in %LOCALAPPDATA%) does NOT lock this path, so it won't
// falsely block builds.
function isRunningFromWinUnpacked() {
  try {
    const fd = openSync(exePath, 'r+');
    closeSync(fd);
    return false;
  } catch (err) {
    if (err.code === 'ENOENT') return false; // not built yet — nothing to lock
    return true; // EBUSY/EPERM/EACCES — locked by a running process
  }
}

if (isRunningFromWinUnpacked()) {
  console.error(
    '\n[guard-dist] DSH Desktop is still running from release\\win-unpacked.\n' +
      'Close it before packaging: electron-builder clears that directory and will\n' +
      'fail with EPERM on files locked by the running app.\n'
  );
  process.exit(1);
}

console.log('[guard-dist] OK — nothing running from release\\win-unpacked.');
