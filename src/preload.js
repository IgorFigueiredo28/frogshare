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
