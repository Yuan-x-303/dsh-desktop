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
  /** Reject the url promise if dsh doesn't announce its URL within this many ms. */
  timeoutMs?: number;
}

export interface DshLaunchResult {
  child: ChildProcess;
  /** Resolves with the announced URL once dsh prints it (e.g. http://127.0.0.1:3080). */
  url: Promise<string>;
  /** Accumulated stdout/stderr lines, for diagnostics on failure. */
  logs: string[];
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

/** User-level config for packaged builds: %APPDATA%\dsh-desktop\config.json. */
function userConfigPath(): string | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return join(appData, 'dsh-desktop', 'config.json');
}

/** Candidate locations for config.json, in priority order. */
function configCandidates(): string[] {
  const candidates: (string | null)[] = [
    join(__dirname, '..', '..', 'config.json'), // dev: dist/electron → project root
    userConfigPath(), // packaged build + shared user-level override
    join(process.cwd(), 'config.json'),
  ];
  return candidates.filter((p): p is string => typeof p === 'string');
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

  const logs: string[] = [];

  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  const url = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  let timeout: NodeJS.Timeout | undefined;
  let settled = false;
  const clearTimer = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const resolveOnce = (u: string) => {
    if (settled) return;
    settled = true;
    clearTimer();
    resolveUrl(u);
  };
  const rejectOnce = (err: Error) => {
    if (settled) return;
    settled = true;
    clearTimer();
    rejectUrl(err);
  };

  if (options.timeoutMs && options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      rejectOnce(
        new Error(`dsh did not announce its URL within ${options.timeoutMs}ms`)
      );
    }, options.timeoutMs);
  }

  const stdout = createInterface({ input: child.stdout! });
  stdout.on('line', (line) => {
    logs.push(line);
    // Matches: "dsh web: http://127.0.0.1:3080" (with an optional " (LAN: ...)" suffix)
    const match = line.match(/dsh web:\s+(https?:\/\/\S+)/);
    if (match) resolveOnce(match[1]);
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    logs.push(text);
    process.stderr.write(`[dsh] ${text}`);
  });

  child.on('error', (err) => {
    rejectOnce(err);
  });

  child.on('exit', (code, signal) => {
    rejectOnce(
      new Error(
        `dsh exited before announcing its URL (code=${code}, signal=${signal ?? 'none'})`
      )
    );
  });

  return {
    child,
    url,
    logs,
    stop: () => {
      try {
        if (!child.killed) child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
