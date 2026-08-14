#!/usr/bin/env node
// Post-build check: find @deepseek-ai runtime packages that electron-builder
// failed to bundle. The dsh ecosystem declares many plugins as peerDependencies
// (npm auto-installs them in dev, but electron-builder skips peer deps during
// production collection), so the packaged app would crash at startup with
// ERR_MODULE_NOT_FOUND unless each one is declared explicitly in package.json.
//
// Usage: node scripts/check-deps.mjs   (run AFTER `npm run dist`)
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const devDir = join(root, 'node_modules', '@deepseek-ai');
const pkgDir = join(
  root,
  'release',
  'win-unpacked',
  'resources',
  'app',
  'node_modules',
  '@deepseek-ai'
);

if (!existsSync(devDir)) {
  console.error('\n[check-deps] 找不到 node_modules/@deepseek-ai — 请先运行 `npm install`。\n');
  process.exit(1);
}

if (!existsSync(pkgDir)) {
  console.error(
    '\n[check-deps] 找不到打包目录 release/win-unpacked/resources/app/node_modules/@deepseek-ai。\n' +
      '请先运行 `npm run dist` 打包，再运行 `npm run check:deps`。\n'
  );
  process.exit(1);
}

const dev = readdirSync(devDir).filter((n) => !n.startsWith('.'));
const pkg = readdirSync(pkgDir).filter((n) => !n.startsWith('.'));
const missing = dev.filter((n) => !pkg.includes(n));

if (missing.length === 0) {
  console.log('[check-deps] ✅ 无缺失：打包环境已包含所有 @deepseek-ai 运行时包。');
  process.exit(0);
}

console.log(`\n[check-deps] ⚠️ 发现 ${missing.length} 个 @deepseek-ai 包在打包环境中缺失：\n`);
const jsonLines = [];
for (const name of missing) {
  const manifestPath = join(devDir, name, 'package.json');
  const version = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')).version ?? '0.0.0')
    : '0.0.0';
  console.log(`  - @deepseek-ai/${name}@${version}`);
  jsonLines.push(`    "@deepseek-ai/${name}": "${version}",`);
}

console.log('\n请把下面的 JSON 片段加入 package.json 的 dependencies：\n');
console.log(jsonLines.join('\n'));
console.log('\n然后依次执行：');
console.log('  npm install');
console.log('  npm run dist');
console.log('  npm run check:deps   # 再次确认无缺失\n');
process.exit(1);
