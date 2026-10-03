const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, nativeTheme, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { createServer } = require('./server');

const isDev = !app.isPackaged;
const isMac = process.platform === 'darwin';
// Same protocol on both: WASAPI (C#) on Windows, Core Audio process taps (Swift) on macOS
const AUDIO_CAPTURE_BIN = isMac ? 'AudioCapture-mac' : 'AudioCapture.exe';
const AUDIO_CAPTURE_EXE = isDev
  ? path.join(__dirname, '..', 'native', AUDIO_CAPTURE_BIN)
  : path.join(process.resourcesPath, 'native', AUDIO_CAPTURE_BIN);

const SIGNAL_SERVER = process.env.SIGNAL_SERVER || 'https://telaskzpetentes.onrender.com';

function reportMainError(message, stack, context) {
  try {
    fetch(`${SIGNAL_SERVER}/api/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'main',
        level: 'error',
        message: String(message).slice(0, 2000),
        stack: stack ? String(stack).slice(0, 5000) : null,
        context: context || null,
        app_version: '1.4.0'
      })
    }).catch(() => {});
  } catch {}
}

process.on('uncaughtException', (err) => {
  reportMainError('uncaughtException: ' + err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : null;
  reportMainError('unhandledRejection: ' + msg, stack);
});

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'WGCCapturerWin,WGCScreenCapturer');

let mainWindow;
let tray;
let serverInstance;
let audioCaptureProcess = null;
let pendingCaptureSourceId = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 600,
    minHeight: 500,
    title: 'FrogShare',
    // macOS takes the icon from the app bundle
    icon: isMac ? undefined : path.join(__dirname, '..', 'server', 'public', 'brand', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    },
    // Matches the theme's page background so the window doesn't flash before the page paints
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B1A10' : '#F3F8EC',
    autoHideMenuBar: true,
    // --hidden runs the app without a window, for automated checks that must not steal focus
    show: !process.argv.includes('--hidden')
  });

  const sendFocus = () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-focus', mainWindow.isFocused() && !mainWindow.isMinimized());
    }
  };
  for (const evt of ['focus', 'blur', 'minimize', 'restore']) mainWindow.on(evt, sendFocus);

  mainWindow.loadURL(`http://127.0.0.1:${serverInstance.port}/host.html`);
}

app.whenReady().then(async () => {
  serverInstance = await createServer(3030);

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 0, height: 0 }
    });
    const source = pendingCaptureSourceId
      ? sources.find(s => s.id === pendingCaptureSourceId)
      : sources[0];
    pendingCaptureSourceId = null;
    callback({ video: source || sources[0] });
  }, { useSystemPicker: false });

  await createWindow();
});

ipcMain.handle('set-capture-source', (event, sourceId) => {
  pendingCaptureSourceId = sourceId;
  return true;
});

app.on('before-quit', () => {
  stopAudioCapture();
});

app.on('window-all-closed', () => {
  app.quit();
});

// ======== IPC: Window/Screen Sources ========
ipcMain.handle('get-sources', async () => {
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
  } catch (err) {
    // macOS rejects outright until Screen Recording is allowed; the page shows how to fix that
    if (isMac) return [];
    throw err;
  }

  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
    isScreen: s.id.startsWith('screen:')
  }));
});

// ======== IPC: macOS permissions ========
// Screen Recording and System Audio Recording are separate macOS permissions. Missing the first
// makes every capture blank, missing the second makes the sound silent, and neither says so itself.
const PRIVACY_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  audio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture'
};

function runHelperJson(args) {
  return new Promise((resolve) => {
    const proc = spawn(AUDIO_CAPTURE_EXE, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', () => { try { resolve(JSON.parse(stderr.trim())); } catch { resolve({}); } });
    proc.on('error', () => resolve({}));
  });
}

async function getPermissions() {
  if (!isMac) return { screen: 'granted', audio: 'granted' };
  const { status } = await runHelperJson(['audio-permission']);
  return { screen: systemPreferences.getMediaAccessStatus('screen'), audio: status || 'unknown' };
}

ipcMain.handle('get-permissions', getPermissions);

ipcMain.handle('request-permission', async (event, kind) => {
  if (!isMac || !PRIVACY_PANES[kind]) return getPermissions();
  if (kind === 'screen') {
    // A capture attempt is what puts FrogShare in the Settings list (and shows the prompt the first time).
    // Granting only takes effect after a relaunch, so Settings is always where this ends up.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') shell.openExternal(PRIVACY_PANES.screen);
  } else {
    // Waits on the system prompt if undecided; after a "no" only Settings can change it
    const { status } = await runHelperJson(['audio-permission', 'request']);
    if (status === 'denied') shell.openExternal(PRIVACY_PANES.audio);
  }
  return getPermissions();
});

ipcMain.handle('relaunch-app', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('get-platform', () => process.platform);

// ======== IPC: Audio Sessions ========
ipcMain.handle('list-audio-sessions', () => {
  return new Promise((resolve) => {
    const proc = spawn(AUDIO_CAPTURE_EXE, ['list']);
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      try {
        const result = JSON.parse(stderr.trim());
        resolve(result);
      } catch {
        resolve({ sessions: [], error: stderr });
      }
    });

    proc.on('error', (err) => {
      resolve({ sessions: [], error: err.message });
    });
  });
});

// ======== IPC: Start/Stop Audio Capture ========
ipcMain.handle('start-audio-capture', (event, pidOrMode) => {
  return new Promise((resolve) => {
    if (audioCaptureProcess) {
      stopAudioCapture();
    }

    const args = pidOrMode === 'system'
      ? ['capture-system']
      : ['capture', pidOrMode.toString()];

    const proc = spawn(AUDIO_CAPTURE_EXE, args);
    audioCaptureProcess = proc;
    // Audio glitches are far more noticeable than a dropped video frame
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_HIGH); } catch {}

    let started = false;

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      try {
        const json = JSON.parse(msg);
        if (json.started && !started) {
          started = true;
          resolve(json);
        }
        if (json.error) {
          if (!started) resolve(json);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('audio-capture-error', json.error);
          }
        }
      } catch {}
    });

    // Framing: [uint32 LE length][float32 PCM]
    let pending = Buffer.alloc(0);

    proc.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;

      while (pending.length - offset >= 4) {
        const len = pending.readUInt32LE(offset);
        if (pending.length - offset - 4 < len) break;
        const start = pending.byteOffset + offset + 4;
        // Copy into a fresh aligned ArrayBuffer (pooled Buffers can have unaligned offsets)
        const samples = new Float32Array(pending.buffer.slice(start, start + len));
        offset += 4 + len;
        if (audioCaptureProcess === proc && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('audio-data', samples);
        }
      }

      pending = pending.subarray(offset);
    });

    proc.on('close', (code) => {
      if (audioCaptureProcess !== proc) return;
      audioCaptureProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio-capture-stopped');
      }
      if (!started) {
        reportMainError('Audio capture process exited', null, { code, args });
        resolve({ error: 'Process exited' });
      }
    });

    proc.on('error', (err) => {
      reportMainError('Audio capture spawn error: ' + err.message, err.stack, { args });
      if (!started) resolve({ error: err.message });
    });

    setTimeout(() => {
      if (!started) resolve({ error: 'Timeout starting capture' });
    }, 5000);
  });
});

// Desktop capture runs in the browser process and encoding in the GPU process; without a boost
// a GPU-bound game starves both and the stream drops to ~30fps.
function setStreamingPriority(on) {
  const pids = app.getAppMetrics().map(m => m.pid);
  const cpu = on ? os.constants.priority.PRIORITY_ABOVE_NORMAL : os.constants.priority.PRIORITY_NORMAL;
  for (const pid of pids) {
    try { os.setPriority(pid, cpu); } catch {}
  }
  // GPU scheduling priority (D3DKMT) is Windows-only
  if (isMac) return;
  const proc = spawn(AUDIO_CAPTURE_EXE, ['gpu-priority', ...pids.map(String), on ? '4' : '2']);
  let out = '';
  proc.stderr.on('data', d => { out += d; });
  proc.on('close', () => {
    if (on && !out.includes('"class":4')) reportMainError('GPU priority boost failed', null, { out: out.slice(0, 500) });
  });
  proc.on('error', () => {});
}

ipcMain.handle('set-streaming-priority', (event, on) => {
  setStreamingPriority(!!on);
  return true;
});

ipcMain.handle('stop-audio-capture', () => {
  stopAudioCapture();
  return { stopped: true };
});

function stopAudioCapture() {
  const proc = audioCaptureProcess;
  if (!proc) return;
  audioCaptureProcess = null;
  try {
    proc.stdin.write('stop\n');
    setTimeout(() => { try { proc.kill(); } catch {} }, 1000);
  } catch {
    try { proc.kill(); } catch {}
  }
}

ipcMain.handle('get-server-port', () => {
  return serverInstance?.port || 3030;
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('open-download', (event, url) => {
  // The link comes from the signaling server; only ever hand a plain https URL to the OS
  if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) return false;
  shell.openExternal(url);
  return true;
});

ipcMain.handle('get-signal-server', () => {
  return process.env.SIGNAL_SERVER || 'https://telaskzpetentes.onrender.com';
});
