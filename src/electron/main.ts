import { app, BrowserWindow } from 'electron';
import { launchDsh } from './dsh';

// Windows: a stable AppUserModelID groups taskbar icons and enables notifications.
app.setAppUserModelId('com.dsh.desktop');

let mainWindow: BrowserWindow | null = null;
let stopDsh: (() => void) | null = null;
let quitting = false;
let appLoaded = false;

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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);

  // Show a loading screen immediately so the (potentially slow) dsh boot never
  // looks like a hang; navigate to the real URL once dsh announces it.
  win.loadURL(dataUrl(LOADING_HTML));

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED — ignore
    console.error('[dsh-desktop] page failed to load:', errorDescription, validatedURL);
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function startDsh(): void {
  const { child, url, logs, stop } = launchDsh({
    port: 0,
    timeoutMs: STARTUP_TIMEOUT_MS,
  });
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
      mainWindow?.loadURL(u);
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

function dataUrl(html: string): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const LOADING_HTML = `<!doctype html>
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
</style></head>
<body>
  <div class="wrap">
    <div class="spinner"></div>
    <div class="title">正在启动 DeepSeek Harness…</div>
    <div class="sub">首次启动可能需要几十秒，请稍候</div>
  </div>
</body></html>`;

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
  <div class="badge">启动失败</div>
  <h1>DeepSeek Harness 未能启动</h1>
  <div class="msg">${escapeHtml(message)}</div>
  <pre>${escapeHtml(logText || '(没有捕获到输出)')}</pre>
  <div class="hint">请关闭此窗口后重试；若持续失败，请把上面的日志反馈给开发者。</div>
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
