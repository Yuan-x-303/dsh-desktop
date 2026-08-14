import { app, BrowserWindow } from 'electron';
import { launchDsh } from './dsh';

let mainWindow: BrowserWindow | null = null;
let stopDsh: (() => void) | null = null;
let quitting = false;

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
    const { child, url, stop } = launchDsh({ port: 0 });
    stopDsh = stop;

    child.on('exit', (code) => {
      if (!quitting) {
        console.error(
          `[dsh-desktop] DeepSeek Harness exited unexpectedly (code=${code}). Closing.`
        );
        app.quit();
      }
    });

    url
      .then(openWindow)
      .catch((err: Error) => {
        console.error(
          '[dsh-desktop] failed to start DeepSeek Harness:',
          err?.message ?? err
        );
        app.quit();
      });
  });
}

function openWindow(url: string): void {
  mainWindow = new BrowserWindow({
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

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED — ignore
    console.error('[dsh-desktop] page failed to load:', errorDescription, validatedURL);
  });

  mainWindow.loadURL(url);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
