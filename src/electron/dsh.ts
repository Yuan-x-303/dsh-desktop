import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface DshLaunchOptions {
  /** Workspace root handed to DeepSeek Harness. Defaults to ~/dsh-workspace. */
  workspace?: string;
  /** DeepSeek Harness home (DSH_HOME). Defaults to ~/.dsh. */
  home?: string;
  /** Listen port. Defaults to 0 (let the OS pick a free port). */
  port?: number;
  /** Extra args forwarded to `dsh web`. */
  extraArgs?: string[];
}

export interface DshLaunchResult {
  child: ChildProcess;
  /** Resolves with the announced URL once dsh prints it (e.g. http://127.0.0.1:3080). */
  url: Promise<string>;
  /** Kills the dsh child process. */
  stop: () => void;
}

/** App root: the project directory in dev, or <resources>/app in a packaged (asar:false) build. */
function appRoot(): string {
  return join(__dirname, '..', '..');
}

/** Locate the @deepseek-ai/dsh CLI entry. */
export function resolveDshBin(): string {
  try {
    return require.resolve('@deepseek-ai/dsh/lib/bin.js');
  } catch {
    const fromRoot = join(
      appRoot(),
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js'
    );
    if (existsSync(fromRoot)) return fromRoot;
    throw new Error(
      'Cannot locate @deepseek-ai/dsh. Run `npm install` in the project root first.'
    );
  }
}

/**
 * Node binary used to run dsh. Prefers an explicit DSH_DESKTOP_NODE override,
 * then the bundled portable runtime (resources/runtime/node.exe), then the
 * system `node` on PATH.
 */
export function resolveNodeBin(): string {
  const explicit = process.env.DSH_DESKTOP_NODE?.trim();
  if (explicit) return explicit;

  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'runtime', 'node.exe');
    if (existsSync(packaged)) return packaged;
  }

  const dev = join(appRoot(), 'resources', 'runtime', 'node.exe');
  if (existsSync(dev)) return dev;

  return 'node';
}

interface DesktopConfig {
  /** Optional workspace root. Empty/omitted → fall back to the default. */
  workspace?: string;
  /** Optional DeepSeek Harness home (DSH_HOME). Empty/omitted → ~/.dsh. */
  home?: string;
}

/** Candidate locations for config.json (dev: project root). */
function configCandidates(): string[] {
  return [
    join(__dirname, '..', '..', 'config.json'), // dist/electron → project root
    join(process.cwd(), 'config.json'),
  ];
}

function loadConfig(): DesktopConfig {
  for (const path of configCandidates()) {
    try {
      if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf8')) as DesktopConfig;
      }
    } catch (err) {
      console.warn(
        `[dsh-desktop] ignoring unreadable config ${path}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return {};
}

function resolveWorkspace(options: DshLaunchOptions): string {
  const explicit = options.workspace?.trim();
  if (explicit) return explicit;
  const cfg = loadConfig();
  const fromConfig = cfg.workspace?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.DSH_WORKSPACE?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), 'dsh-workspace');
}

function resolveHome(options: DshLaunchOptions): string {
  const explicit = options.home?.trim();
  if (explicit) return explicit;
  const cfg = loadConfig();
  const fromConfig = cfg.home?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), '.dsh');
}

export function launchDsh(options: DshLaunchOptions = {}): DshLaunchResult {
  const dshBin = resolveDshBin();
  const nodeBin = resolveNodeBin();
  const port = options.port ?? 0;
  const args = [dshBin, 'web', '--port', String(port), ...(options.extraArgs ?? [])];

  const workspace = resolveWorkspace(options);
  const home = resolveHome(options);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });

  const child = spawn(nodeBin, args, {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  const url = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const stdout = createInterface({ input: child.stdout! });
  stdout.on('line', (line) => {
    // Matches: "dsh web: http://127.0.0.1:3080" (with an optional " (LAN: ...)" suffix)
    const match = line.match(/dsh web:\s+(https?:\/\/\S+)/);
    if (match) resolveUrl(match[1]);
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    process.stderr.write(`[dsh] ${chunk.toString()}`);
  });

  child.on('error', (err) => {
    rejectUrl(err);
  });

  child.on('exit', (code, signal) => {
    rejectUrl(
      new Error(
        `dsh exited before announcing its URL (code=${code}, signal=${signal ?? 'none'})`
      )
    );
  });

  return {
    child,
    url,
    stop: () => {
      try {
        if (!child.killed) child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
