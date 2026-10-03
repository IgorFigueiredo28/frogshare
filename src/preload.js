const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  setCaptureSource: (sourceId) => ipcRenderer.invoke('set-capture-source', sourceId),
  listAudioSessions: () => ipcRenderer.invoke('list-audio-sessions'),
  startAudioCapture: (pidOrMode) => ipcRenderer.invoke('start-audio-capture', pidOrMode),
  stopAudioCapture: () => ipcRenderer.invoke('stop-audio-capture'),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  getSignalServer: () => ipcRenderer.invoke('get-signal-server'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setStreamStatus: (status) => ipcRenderer.invoke('set-stream-status', status),
  getOverlayEnabled: () => ipcRenderer.invoke('get-overlay-enabled'),
  setOverlayEnabled: (enabled) => ipcRenderer.invoke('set-overlay-enabled', enabled),
  overlayOpenApp: () => ipcRenderer.invoke('overlay-open-app'),
  overlayHide: () => ipcRenderer.invoke('overlay-hide'),
  overlayExpand: () => ipcRenderer.invoke('overlay-expand'),
  overlayDrag: (dx, dy) => ipcRenderer.send('overlay-drag', { dx, dy }),
  overlayDragEnd: () => ipcRenderer.invoke('overlay-drag-end'),
  onOverlayCompact: (callback) => {
    ipcRenderer.on('overlay-compact', (_, state) => callback(state));
  },
  onOverlayStatus: (callback) => {
    ipcRenderer.on('overlay-status', (_, status) => callback(status));
  },
  openDownload: (url) => ipcRenderer.invoke('open-download', url),
  setStreamingPriority: (on) => ipcRenderer.invoke('set-streaming-priority', on),

  onAudioData: (callback) => {
    ipcRenderer.on('audio-data', (_, data) => callback(data));
  },
  onAudioCaptureError: (callback) => {
    ipcRenderer.on('audio-capture-error', (_, error) => callback(error));
  },
  onWindowFocus: (callback) => {
    ipcRenderer.on('window-focus', (_, focused) => callback(focused));
  },
  onAudioCaptureStopped: (callback) => {
    ipcRenderer.on('audio-capture-stopped', () => callback());
  },

  removeAudioListeners: () => {
    ipcRenderer.removeAllListeners('audio-data');
    ipcRenderer.removeAllListeners('audio-capture-error');
    ipcRenderer.removeAllListeners('audio-capture-stopped');
  }
});
