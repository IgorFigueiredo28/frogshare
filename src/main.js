const { app, BrowserWindow, ipcMain, desktopCapturer, session, Tray, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { createServer } = require('./server');

const isDev = !app.isPackaged;
const AUDIO_CAPTURE_EXE = isDev
  ? path.join(__dirname, '..', 'native', 'AudioCapture.exe')
  : path.join(process.resourcesPath, 'native', 'AudioCapture.exe');

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
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'Screen Share',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    },
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true
  });

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
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });

  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
    isScreen: s.id.startsWith('screen:')
  }));
});

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

    proc.on('close', () => {
      if (audioCaptureProcess !== proc) return;
      audioCaptureProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio-capture-stopped');
      }
      if (!started) resolve({ error: 'Process exited' });
    });

    proc.on('error', (err) => {
      if (!started) resolve({ error: err.message });
    });

    setTimeout(() => {
      if (!started) resolve({ error: 'Timeout starting capture' });
    }, 5000);
  });
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

ipcMain.handle('get-signal-server', () => {
  return process.env.SIGNAL_SERVER || 'https://telaskzpetentes.onrender.com';
});
