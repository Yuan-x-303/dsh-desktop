import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { launchDsh, resolveLaunchPaths, type DshLaunchResult } from './dsh';

// Windows: a stable AppUserModelID groups taskbar icons and enables notifications.
app.setAppUserModelId('com.dsh.desktop');

// The packaged build keeps package.json name "dsh-desktop", so packaged and
// dev would share the same userData — and the same single-instance lock. Give
// dev its own profile dir so `npm start` can run while the installed app is
// open. Must happen before requestSingleInstanceLock.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('temp'), 'dsh-desktop-dev'));
}

let mainWindow: BrowserWindow | null = null;
let stopDsh: (() => void) | null = null;
let quitting = false;
let appLoaded = false;
let harnessOrigin: string | null = null;

const STARTUP_TIMEOUT_MS = 120_000;

// Single instance: focus the existing window instead of opening a second app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    mainWindow = createWindow();
    startDsh();
    setupAutoUpdater();
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    // Dev runs from source: point the window at build/icon.png so `npm start`
    // shows the custom icon too. The packaged exe carries its own .ico and does
    // not need an icon option (build/ isn't shipped inside the app).
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);

  // Show a loading screen immediately so the (potentially slow) dsh boot never
  // looks like a hang; navigate to the real URL once dsh announces it. The
  // resolved workspace/home are shown so users can see where their data lives.
  const { workspace, home } = resolveLaunchPaths();
  win.loadURL(dataUrl(loadingHtml(workspace, home)));

  // Keep the app window on the Harness UI. Page-initiated navigations away
  // from the harness origin (external links) are handed to the system browser.
  win.webContents.on('will-navigate', (event, targetUrl) => {
    const origin = harnessOrigin;
    if (origin === null) return; // still on the loading page
    try {
      if (new URL(targetUrl).origin !== origin) {
        event.preventDefault();
        if (/^https?:/i.test(targetUrl)) void shell.openExternal(targetUrl);
      }
    } catch {
      event.preventDefault();
    }
  });

  // target=_blank / window.open: open in the default browser, never a second
  // app window that would lose the harness session.
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:/i.test(targetUrl)) void shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED — ignore
    console.error('[dsh-desktop] page failed to load:', errorDescription, validatedURL);
  });

  // The web UI can request browser permissions (camera, geolocation, MIDI, ...).
  // This shell serves a local agent host with arbitrary command execution, so
  // capabilities that expose hardware, location, or the network are denied.
  //
  // Clipboard WRITE is the deliberate exception. Electron treats it as a
  // permission (`clipboard-sanitized-write`), and a blanket deny silently
  // breaks the Harness's copy buttons: the UI calls
  // navigator.clipboard.writeText() and only falls back to execCommand when
  // that API is *absent* — not when it is rejected — so the failure produces no
  // feedback at all. Writing to the user's own clipboard is not a privilege
  // escalation for a local shell, so allow exactly that and nothing else.
  const CLIPBOARD_WRITE = 'clipboard-sanitized-write';
  const isAllowed = (permission: string): boolean => permission === CLIPBOARD_WRITE;

  win.webContents.session.setPermissionCheckHandler((_wc, permission) =>
    isAllowed(permission)
  );
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isAllowed(permission));
  });

  // Electron ships NO default context menu, so right-clicking the Harness UI did
  // nothing at all — users had to know the Ctrl+V shortcut to paste, and a
  // web page cannot read the clipboard programmatically (execCommand('paste')
  // is refused by Chromium), so a page-level "paste" could never work.
  //
  // These are native `role` items, executed by the main process rather than the
  // page, so they are not subject to the renderer's clipboard restrictions.
  // Enablement comes from `params.editFlags`, so the menu only offers actions
  // that apply to whatever was clicked.
  win.webContents.on('context-menu', (_event, params) => {
    const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags;
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (canCut || canCopy || canPaste) {
      template.push(
        { role: 'cut', enabled: canCut },
        { role: 'copy', enabled: canCopy },
        { role: 'paste', enabled: canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: canSelectAll }
      );
    } else if (params.selectionText.trim() !== '') {
      // Read-only area (a rendered answer, a code block, a diff): copying is the
      // only meaningful action.
      template.push({ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' });
    } else {
      return; // nothing useful to offer — stay out of the way
    }
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function startDsh(): void {
  // launchDsh can throw synchronously (unusable workspace/home from config,
  // missing dsh package). Surface that on the error page instead of leaving
  // the loading screen up forever.
  let launch: DshLaunchResult;
  try {
    launch = launchDsh({ port: 0, timeoutMs: STARTUP_TIMEOUT_MS });
  } catch (err) {
    if (quitting) return;
    showError(err instanceof Error ? err.message : String(err), []);
    return;
  }

  const { child, url, logs, stop } = launch;
  stopDsh = stop;

  child.on('exit', (code) => {
    if (quitting) return;
    if (appLoaded) {
      console.error(
        `[dsh-desktop] DeepSeek Harness exited unexpectedly (code=${code}). Closing.`
      );
      app.quit();
    }
    // If the app hasn't loaded yet, the `url` promise rejects and showError runs.
  });

  url
    .then((u) => {
      appLoaded = true;
      const target = new URL(u);
      harnessOrigin = target.origin;
      // Tell the web UI which platform is hosting it (mirrors the official
      // desktop build, which passes ?dsh-desktop-platform=win32 so the UI can
      // pick native directory pickers / title bar behavior).
      target.searchParams.set('dsh-desktop-platform', process.platform);
      mainWindow?.loadURL(target.toString());
    })
    .catch((err: Error) => {
      if (quitting) return;
      showError(err?.message ?? String(err), logs);
    });
}

function showError(message: string, logs: string[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(dataUrl(errorHtml(message, logs)));
}

function setupAutoUpdater(): void {
  // Only the installed build can self-update: the portable exe has no install
  // location, and dev has no app-update.yml. Update checks must never break
  // startup, so every failure is swallowed with a warning.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', () => {
    if (quitting) return;
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: 'Update ready',
      message: 'A new version of DSH Desktop has been downloaded.',
      detail: 'Restart now to install it, or it will be installed the next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    console.warn('[dsh-desktop] update check failed:', err?.message ?? err);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[dsh-desktop] update check failed:', err?.message ?? err);
  });
}

function dataUrl(html: string): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadingHtml(workspace: string, home: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0}
  body{background:#0f1115;color:#8b93a7;font-family:"Segoe UI",system-ui,sans-serif;
       display:flex;align-items:center;justify-content:center;user-select:none}
  .wrap{text-align:center}
  .spinner{width:38px;height:38px;margin:0 auto 18px;border:3px solid #232a3d;
       border-top-color:#4f8cff;border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .title{font-size:15px;color:#c7cde0}
  .sub{font-size:12px;margin-top:8px;color:#5b6478}
  .paths{margin-top:22px;font-size:11px;color:#4a5266;line-height:1.8;
       font-family:Consolas,"Courier New",monospace;word-break:break-all}
</style></head>
<body>
  <div class="wrap">
    <div class="spinner"></div>
    <div class="title">Starting DeepSeek Harness&hellip;</div>
    <div class="sub">First launch may take up to a minute &mdash; please wait</div>
    <div class="paths">workspace: ${escapeHtml(workspace)}<br>home: ${escapeHtml(home)}</div>
  </div>
</body></html>`;
}

function errorHtml(message: string, logs: string[]): string {
  const logText = logs.slice(-150).join('\n').trim();
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0}
  body{background:#0f1115;color:#c7cde0;font-family:"Segoe UI",system-ui,sans-serif;
       padding:32px;box-sizing:border-box;overflow:auto}
  .badge{display:inline-block;background:#3a1d1d;color:#ff7b72;border:1px solid #5c2b2b;
       border-radius:6px;padding:4px 10px;font-size:13px;margin-bottom:16px}
  h1{font-size:18px;margin:0 0 8px;color:#ff8a80}
  .msg{font-size:14px;color:#c7cde0;margin-bottom:20px;word-break:break-all}
  pre{background:#10141d;border:1px solid #232a3d;border-radius:8px;padding:14px;
       font-size:12px;line-height:1.5;color:#8b93a7;overflow:auto;max-height:50vh;
       white-space:pre-wrap;word-break:break-all}
  .hint{font-size:12px;color:#5b6478;margin-top:16px}
</style></head>
<body>
  <div class="badge">STARTUP FAILED</div>
  <h1>DeepSeek Harness could not start</h1>
  <div class="msg">${escapeHtml(message)}</div>
  <pre>${escapeHtml(logText || '(no output captured)')}</pre>
  <div class="hint">Close this window and try again. If the problem persists, share the log above with the developers.</div>
</body></html>`;
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (stopDsh) {
    stopDsh();
    stopDsh = null;
  }
});

app.on('will-quit', () => {
  if (stopDsh) {
    stopDsh();
    stopDsh = null;
  }
});
