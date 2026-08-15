import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * Resolve the effective workspace and home (config → env → default) without
 * launching. The loading screen shows these so users always know where their
 * data (sessions/settings) lives.
 */
export function resolveLaunchPaths(
  options: DshLaunchOptions = {}
): { workspace: string; home: string } {
  return { workspace: resolveWorkspace(options), home: resolveHome(options) };
}

/** Create a directory, or throw a clear error naming the setting and path. */
function ensureDir(dir: string, what: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`The configured ${what} "${dir}" cannot be created: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Readiness-line parsing (mirrors the official desktop app's strict parser).
//
// `dsh web` prints a single readiness line of the form:
//     dsh web: http://127.0.0.1:PORT
// We buffer stdout by chunks (a line can straddle chunk boundaries), require
// the URL to be loopback HTTP with an explicit integer port and nothing else,
// and reject conflicting readiness URLs.
// ---------------------------------------------------------------------------

const READINESS_PREFIX = 'dsh web: ';
const DEFAULT_READINESS_TIMEOUT_MS = 90_000;

/** Assert and normalize one readiness line; undefined if it is not one. */
function parseReadinessLine(line: string): string | undefined {
  if (!line.startsWith(READINESS_PREFIX)) return undefined;
  const token = line.slice(READINESS_PREFIX.length).split(/\s/u, 1)[0];
  if (token === undefined) {
    throw new Error(`dsh readiness line has no URL: ${line}`);
  }
  let url: URL;
  try {
    url = new URL(token);
  } catch {
    throw new Error(`dsh readiness URL is invalid: ${token}`);
  }
  const port = Number(url.port);
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const isBareHttp =
    url.protocol === 'http:' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535;
  if (!isLoopback || !isBareHttp) {
    throw new Error(
      `dsh readiness URL must be loopback HTTP with an explicit port: ${token}`
    );
  }
  return url.origin;
}

/** Incremental chunk-based parser that is stable once readiness is reached. */
function createReadinessParser(): { push(chunk: string): string | undefined } {
  let pending = '';
  let readyUrl: string | undefined;
  const accept = (line: string): string | undefined => {
    const parsed = parseReadinessLine(line.replace(/\r$/u, ''));
    if (parsed === undefined) return undefined;
    if (readyUrl !== undefined && parsed !== readyUrl) {
      throw new Error(
        `dsh emitted conflicting readiness URLs: ${readyUrl} and ${parsed}`
      );
    }
    readyUrl = parsed;
    return readyUrl;
  };
  return {
    push(chunk: string): string | undefined {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline === -1) return readyUrl;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const parsed = accept(line);
        if (parsed !== undefined) return parsed;
      }
    },
  };
}

export function launchDsh(options: DshLaunchOptions = {}): DshLaunchResult {
  const dshBin = resolveDshBin();
  const nodeBin = resolveNodeBin();
  const port = options.port ?? 0;
  // Force the loopback bind: dsh web itself refuses `--host 0.0.0.0`, but a
  // user profile patch could still bind all interfaces and expose the
  // remote-code-execution-capable server to the LAN. The CLI flag overrides it.
  const args = [
    dshBin,
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    ...(options.extraArgs ?? []),
  ];

  const { workspace, home } = resolveLaunchPaths(options);
  ensureDir(workspace, 'workspace');
  ensureDir(home, 'home');

  const child = spawn(nodeBin, args, {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: home,
      // Lets the harness know it is hosted by the desktop app (mirrors the
      // official desktop build) so the web UI can adapt (e.g. native pickers).
      DSH_DESKTOP: '1',
    },
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

  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  timeout = setTimeout(() => {
    rejectOnce(new Error(`dsh did not announce its URL within ${timeoutMs}ms`));
  }, timeoutMs);

  const parser = createReadinessParser();
  child.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    logs.push(text);
    process.stdout.write(`[dsh] ${text}`);
    if (settled) return;
    try {
      const announced = parser.push(text);
      if (announced !== undefined) resolveOnce(announced);
    } catch (err) {
      rejectOnce(err instanceof Error ? err : new Error(String(err)));
      if (child.pid !== undefined) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    }
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
      const pid = child.pid;
      if (pid === undefined || child.killed) return;
      try {
        if (process.platform === 'win32') {
          // child.kill() on Windows is TerminateProcess on the direct child
          // only; taskkill /T also reaps grandchildren (tool subprocesses)
          // that would otherwise be orphaned when the app quits.
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          child.kill();
        }
      } catch {
        /* already gone */
      }
    },
  };
}
