const { app, BrowserWindow, ipcMain, desktopCapturer, Tray, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { createServer } = require('./server');

const isDev = !app.isPackaged;
const AUDIO_CAPTURE_EXE = isDev
  ? path.join(__dirname, '..', 'native', 'AudioCapture.exe')
  : path.join(process.resourcesPath, 'native', 'AudioCapture.exe');

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let mainWindow;
let tray;
let serverInstance;
let audioCaptureProcess = null;

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

  mainWindow.loadURL(`http://localhost:${serverInstance.port}/host.html`);
}

app.whenReady().then(async () => {
  serverInstance = await createServer(3030);
  await createWindow();
});

app.on('window-all-closed', () => {
  stopAudioCapture();
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

    audioCaptureProcess = spawn(AUDIO_CAPTURE_EXE, args);

    let started = false;
    let headerBuffer = Buffer.alloc(0);

    audioCaptureProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      try {
        const json = JSON.parse(msg);
        if (json.started && !started) {
          started = true;
          resolve(json);
        }
        if (json.error) {
          if (!started) resolve(json);
          mainWindow?.webContents.send('audio-capture-error', json.error);
        }
      } catch {}
    });

    // Read binary audio data: [4 bytes length LE][audio data]
    let pendingLength = -1;
    let accumulated = Buffer.alloc(0);

    audioCaptureProcess.stdout.on('data', (chunk) => {
      accumulated = Buffer.concat([accumulated, chunk]);

      while (accumulated.length >= 4) {
        if (pendingLength === -1) {
          pendingLength = accumulated.readUInt32LE(0);
          accumulated = accumulated.slice(4);
        }

        if (accumulated.length >= pendingLength) {
          const audioData = accumulated.slice(0, pendingLength);
          accumulated = accumulated.slice(pendingLength);
          pendingLength = -1;

          // Convert to Float32Array and send to renderer
          const float32 = new Float32Array(audioData.buffer, audioData.byteOffset, audioData.length / 4);
          mainWindow?.webContents.send('audio-data', Array.from(float32));
        } else {
          break;
        }
      }
    });

    audioCaptureProcess.on('close', () => {
      audioCaptureProcess = null;
      mainWindow?.webContents.send('audio-capture-stopped');
      if (!started) resolve({ error: 'Process exited' });
    });

    audioCaptureProcess.on('error', (err) => {
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
  if (audioCaptureProcess) {
    try {
      audioCaptureProcess.stdin.write('stop\n');
      setTimeout(() => {
        if (audioCaptureProcess) {
          audioCaptureProcess.kill();
          audioCaptureProcess = null;
        }
      }, 1000);
    } catch {
      try { audioCaptureProcess.kill(); } catch {}
      audioCaptureProcess = null;
    }
  }
}

ipcMain.handle('get-server-port', () => {
  return serverInstance?.port || 3030;
});
