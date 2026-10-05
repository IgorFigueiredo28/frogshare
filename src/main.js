const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, nativeTheme, systemPreferences, screen, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createServer } = require('./server');

const isDev = !app.isPackaged;
const isMac = process.platform === 'darwin';
// Same protocol on both: WASAPI (C#) on Windows, Core Audio process taps (Swift) on macOS
const AUDIO_CAPTURE_BIN = isMac ? 'AudioCapture-mac' : 'AudioCapture.exe';
const AUDIO_CAPTURE_EXE = isDev
  ? path.join(__dirname, '..', 'native', AUDIO_CAPTURE_BIN)
  : path.join(process.resourcesPath, 'native', AUDIO_CAPTURE_BIN);

const SIGNAL_SERVER = process.env.SIGNAL_SERVER || 'https://frogshare.onrender.com';

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
        app_version: '1.5.0'
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
  // The source and audio lists stop refreshing while minimized
  for (const evt of ['minimize', 'restore']) {
    mainWindow.on(evt, () => mainWindow.webContents.send('window-minimized', mainWindow.isMinimized()));
  }

  // While streaming, minimizing shows a small floating notice so it's obvious the screen is shared
  mainWindow.on('minimize', showOverlay);
  for (const evt of ['restore', 'show', 'focus']) mainWindow.on(evt, hideOverlay);
  mainWindow.on('closed', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverInstance.port}/host.html`);
}

// ======== "You're live" overlay ========
let overlayWindow = null;
const streamStatus = { streaming: false, viewers: 0, mode: 'direto' };
// x/y is where the full notice sits; anchor says which side the compact chip hugs
const overlayPrefs = { enabled: true, x: null, y: null, anchor: 'right' };
const OVERLAY_SIZE = { width: 340, height: 76 };
const OVERLAY_COMPACT_SIZE = { width: 140, height: 44 };
const OVERLAY_COMPACT_AFTER_MS = 30000;
let overlayCompact = false;
let overlayCompactTimer = null;

function overlayPrefsFile() {
  return path.join(app.getPath('userData'), 'overlay.json');
}

function loadOverlayPrefs() {
  try { Object.assign(overlayPrefs, JSON.parse(fs.readFileSync(overlayPrefsFile(), 'utf8'))); } catch {}
}

function saveOverlayPrefs() {
  try { fs.writeFileSync(overlayPrefsFile(), JSON.stringify(overlayPrefs)); } catch {}
}

// A saved spot can end up off-screen after a monitor is unplugged; fall back to the corner
function overlayPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  const corner = {
    x: workArea.x + workArea.width - OVERLAY_SIZE.width - 16,
    y: workArea.y + workArea.height - OVERLAY_SIZE.height - 16
  };
  if (overlayPrefs.x == null || overlayPrefs.y == null) return corner;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    overlayPrefs.x >= a.x && overlayPrefs.y >= a.y &&
    overlayPrefs.x + OVERLAY_SIZE.width <= a.x + a.width && overlayPrefs.y + OVERLAY_SIZE.height <= a.y + a.height);
  return onScreen ? { x: overlayPrefs.x, y: overlayPrefs.y } : corner;
}

// The chip keeps the full notice's vertical centre and the edge on its anchor side
function compactBounds(full) {
  const { width, height } = OVERLAY_COMPACT_SIZE;
  return {
    x: overlayPrefs.anchor === 'left' ? full.x : full.x + OVERLAY_SIZE.width - width,
    y: Math.round(full.y + (OVERLAY_SIZE.height - height) / 2),
    width, height
  };
}

// Kept inside the chip's screen so the full notice doesn't fall back to the default corner
function fullPositionFromCompact(chip) {
  const { workArea: a } = screen.getDisplayMatching(chip);
  const x = overlayPrefs.anchor === 'left' ? chip.x : chip.x + chip.width - OVERLAY_SIZE.width;
  const y = Math.round(chip.y - (OVERLAY_SIZE.height - chip.height) / 2);
  return {
    x: Math.min(Math.max(x, a.x), a.x + a.width - OVERLAY_SIZE.width),
    y: Math.min(Math.max(y, a.y), a.y + a.height - OVERLAY_SIZE.height)
  };
}

function anchorFor(bounds) {
  const { workArea } = screen.getDisplayMatching(bounds);
  return bounds.x + bounds.width / 2 < workArea.x + workArea.width / 2 ? 'left' : 'right';
}

function setOverlayCompact(compact) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  clearTimeout(overlayCompactTimer);
  overlayCompact = compact;
  const full = { ...overlayPosition(), ...OVERLAY_SIZE };
  overlayWindow.webContents.send('overlay-compact', { compact, anchor: overlayPrefs.anchor });
  const bounds = compact ? compactBounds(full) : full;
  overlayWindow.setBounds(bounds);
  // Windows won't make the window shorter than 64px, so the chip would leave an invisible
  // strip below it that swallows clicks; clipping the window region to the chip removes it
  overlayWindow.setShape([{ x: 0, y: 0, width: bounds.width, height: bounds.height }]);
  // Expanded again: shrink back after another stretch so it stays out of the way
  if (!compact) overlayCompactTimer = setTimeout(() => setOverlayCompact(true), OVERLAY_COMPACT_AFTER_MS);
}

function createOverlay() {
  overlayWindow = new BrowserWindow({
    ...OVERLAY_SIZE,
    ...overlayPosition(),
    title: 'FrogShare: ao vivo',
    // An NSPanel can float over another app's full-screen Space without changing how FrogShare shows in the Dock
    type: isMac ? 'panel' : undefined,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never take focus away from the game
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // A full-screen game on macOS gets its own Space, and a plain always-on-top window stays behind on the desktop.
  // Electron's default here turns the app into a background agent, which drops its Dock icon for good.
  if (isMac) overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  overlayWindow.on('moved', () => {
    // The chip is dragged by hand (it also needs clicks), see overlay-drag-end
    if (overlayCompact) return;
    const [x, y] = overlayWindow.getPosition();
    overlayPrefs.anchor = anchorFor(overlayWindow.getBounds());
    overlayPrefs.x = x;
    overlayPrefs.y = y;
    saveOverlayPrefs();
  });
  overlayWindow.on('closed', () => { overlayWindow = null; });
  overlayWindow.webContents.on('did-finish-load', () => sendOverlayStatus());
  overlayWindow.loadURL(`http://127.0.0.1:${serverInstance.port}/overlay.html`);
}

function sendOverlayStatus() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('overlay-status', streamStatus);
}

function showOverlay() {
  if (!streamStatus.streaming || !overlayPrefs.enabled) return;
  if (!overlayWindow) createOverlay();
  sendOverlayStatus();
  // Every minimize starts with the full notice, then it shrinks to a small chip
  setOverlayCompact(false);
  overlayWindow.showInactive();
  // Keeps the notice out of the stream itself. Windows only honours this once the window is
  // visible and drops it on every hide, so it has to be re-applied after each show (measured).
  overlayWindow.setContentProtection(true);
}

function hideOverlay() {
  clearTimeout(overlayCompactTimer);
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) overlayWindow.hide();
}

// Pink dot on the taskbar button while live, visible even with the window minimized
function liveBadge() {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const i = (y * size + x) * 4;
      if (d <= 7.5) {
        const ring = d > 6;
        pixels[i] = ring ? 0xFF : 0x6C;     // B
        pixels[i + 1] = ring ? 0xFF : 0x33; // G
        pixels[i + 2] = ring ? 0xFF : 0xD6; // R
        pixels[i + 3] = 0xFF;
      }
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

ipcMain.handle('set-stream-status', (event, status) => {
  const wasStreaming = streamStatus.streaming;
  streamStatus.streaming = !!status.streaming;
  streamStatus.viewers = Number(status.viewers) || 0;
  streamStatus.mode = status.mode === 'sfu' ? 'sfu' : 'direto';
  if (streamStatus.streaming !== wasStreaming && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOverlayIcon(streamStatus.streaming ? liveBadge() : null, streamStatus.streaming ? 'Transmitindo' : '');
  }
  if (!streamStatus.streaming) hideOverlay();
  else if (mainWindow && mainWindow.isMinimized() && !wasStreaming) showOverlay();
  sendOverlayStatus();
  return true;
});

ipcMain.handle('get-overlay-enabled', () => overlayPrefs.enabled);

ipcMain.handle('set-overlay-enabled', (event, enabled) => {
  overlayPrefs.enabled = !!enabled;
  saveOverlayPrefs();
  if (!overlayPrefs.enabled) hideOverlay();
  return overlayPrefs.enabled;
});

ipcMain.handle('overlay-open-app', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
});

ipcMain.handle('overlay-expand', () => {
  setOverlayCompact(false);
  return true;
});

ipcMain.on('overlay-drag', (event, { dx, dy }) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const [x, y] = overlayWindow.getPosition();
  overlayWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.handle('overlay-drag-end', () => {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayCompact) return false;
  const chip = overlayWindow.getBounds();
  overlayPrefs.anchor = anchorFor(chip);
  Object.assign(overlayPrefs, fullPositionFromCompact(chip));
  saveOverlayPrefs();
  return true;
});

ipcMain.handle('overlay-hide', () => {
  hideOverlay();
  return true;
});

// ======== Web content lockdown ========
// The app only ever shows its own pages from the local server. Anything that tries to open a new
// window or navigate elsewhere (a link, or injected content) is stopped; https links go to the browser.
const isOwnPage = (url) => {
  try { return new URL(url).origin === `http://127.0.0.1:${serverInstance?.port}`; } catch { return false; }
};
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => { if (!isOwnPage(url)) e.preventDefault(); });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.whenReady().then(async () => {
  loadOverlayPrefs();
  // Only what the app uses: screen capture and the clipboard (copy link). Everything else is refused.
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'clipboard-read']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed.has(permission) && isOwnPage(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && (!origin || isOwnPage(origin)));
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
// Cheap check for "did a window open or close?". The page only asks for the full list (with
// thumbnails) when this changes. Electron's own list costs ~400 ms of this process even without
// thumbnails (17% of a core when polled every 3 s), so on Windows the helper enumerates instead (~70 ms).
ipcMain.handle('get-source-ids', async () => {
  if (!isMac) {
    const { windows } = await runHelperJson(['windows']);
    if (Array.isArray(windows)) return windows.map(String).sort().join('|');
  }
  try {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
    const overlayId = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getMediaSourceId() : null;
    return sources.filter(s => s.id !== overlayId).map(s => s.id).sort().join('|');
  } catch {
    return '';
  }
});

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

  // The "you're live" notice is our own window; it shouldn't be offered as something to share
  const overlayId = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getMediaSourceId() : null;
  return sources.filter(s => s.id !== overlayId).map(s => ({
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

// ======== In-app update ========
// The installer lives on Google Drive. The signaling server publishes its version, size and
// SHA-512; nothing runs unless the downloaded file matches that hash exactly.
let downloadedUpdate = null;
let updateDownload = null;
let installerLaunched = false;

function versionOlder(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

// Big Drive files come back as a "can't scan this file for viruses" page; its form leads to the file.
// Accepting the warning up front (confirm=t) answers in ~2s; the form's own link took ~16s (measured).
async function fetchDriveFile(url) {
  const direct = new URL(url);
  if (direct.hostname === 'drive.usercontent.google.com') direct.searchParams.set('confirm', 't');
  let res = await fetch(direct);
  if ((res.headers.get('content-type') || '').includes('text/html')) {
    const html = await res.text();
    const action = html.match(/<form[^>]*action="([^"]+)"/);
    if (!action) throw new Error('o Drive não liberou o arquivo');
    const next = new URL(action[1].replace(/&amp;/g, '&'));
    if (next.protocol !== 'https:' || !/(^|\.)(google|googleusercontent)\.com$/.test(next.hostname)) {
      throw new Error('link de download inesperado');
    }
    for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
      next.searchParams.set(m[1], m[2]);
    }
    res = await fetch(next);
  }
  if (!res.ok || !res.body) throw new Error(`o Drive respondeu ${res.status}`);
  return res;
}

function sendUpdateProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', progress);
}

async function hashFile(file) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

async function downloadUpdate() {
  const latest = await (await fetch(`${SIGNAL_SERVER}/api/app-version`)).json();
  if (!latest.version || !versionOlder(app.getVersion(), latest.version)) throw new Error('já está na versão mais recente');
  if (!latest.sha512 || !latest.size) throw new Error('essa versão ainda não tem verificação publicada');

  const dir = path.join(app.getPath('temp'), 'FrogShare-update');
  const file = path.join(dir, `FrogShare-Setup-${latest.version}.exe`);
  fs.mkdirSync(dir, { recursive: true });

  // A finished download from an earlier attempt is reused if it still checks out
  if (fs.existsSync(file) && fs.statSync(file).size === latest.size && await hashFile(file) === latest.sha512) {
    return { version: latest.version, file };
  }

  const res = await fetchDriveFile(latest.url);
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(file);
  let received = 0;
  let lastSent = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (received > latest.size) throw new Error('o arquivo do Drive é maior que o esperado');
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      if (Date.now() - lastSent > 200) {
        lastSent = Date.now();
        sendUpdateProgress({ received, total: latest.size });
      }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw err;
  }
  sendUpdateProgress({ received, total: latest.size });

  if (received !== latest.size || hash.digest('base64') !== latest.sha512) {
    fs.rmSync(file, { force: true });
    throw new Error('o arquivo baixado não confere com a versão publicada');
  }
  return { version: latest.version, file };
}

ipcMain.handle('download-update', async () => {
  // The published installer is the Windows NSIS build; Macs update through the .dmg in the browser
  if (process.platform !== 'win32') return { ok: false, error: 'só no Windows' };
  try {
    // A second click while downloading joins the same download
    updateDownload = updateDownload || downloadUpdate();
    downloadedUpdate = await updateDownload;
    return { ok: true, version: downloadedUpdate.version };
  } catch (err) {
    reportMainError('Update download failed: ' + err.message, err.stack);
    return { ok: false, error: err.message };
  } finally {
    updateDownload = null;
  }
});

ipcMain.handle('install-update', async () => {
  if (!downloadedUpdate) return { ok: false, error: 'nenhuma atualização baixada' };
  if (isDev) return { ok: false, error: 'só dá para instalar pelo app instalado' };
  if (streamStatus.streaming) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Instalar agora', 'Depois'],
      defaultId: 1,
      cancelId: 1,
      title: 'Atualizar o FrogShare',
      message: 'Você está transmitindo.',
      detail: 'Instalar agora encerra a transmissão. O app fecha e abre de novo já atualizado.'
    });
    if (response !== 0) return { ok: false, cancelled: true };
  }
  // /S installs silently; --force-run reopens the app when it's done
  launchInstaller(['/S', '--force-run']);
  setTimeout(() => app.quit(), 300);
  return { ok: true };
});

function launchInstaller(args) {
  if (installerLaunched) return;
  installerLaunched = true;
  spawn(downloadedUpdate.file, args, { detached: true, stdio: 'ignore' }).unref();
}

// A downloaded update installs itself when the app is closed, so nobody has to click anything.
// No --force-run here: the person chose to close the app, so it stays closed until reopened.
app.on('will-quit', () => {
  if (downloadedUpdate && !isDev && process.platform === 'win32') launchInstaller(['/S']);
});

ipcMain.handle('get-signal-server', () => {
  return process.env.SIGNAL_SERVER || 'https://frogshare.onrender.com';
});
