const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  listAudioSessions: () => ipcRenderer.invoke('list-audio-sessions'),
  startAudioCapture: (pidOrMode) => ipcRenderer.invoke('start-audio-capture', pidOrMode),
  stopAudioCapture: () => ipcRenderer.invoke('stop-audio-capture'),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),

  onAudioData: (callback) => {
    ipcRenderer.on('audio-data', (_, data) => callback(data));
  },
  onAudioCaptureError: (callback) => {
    ipcRenderer.on('audio-capture-error', (_, error) => callback(error));
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
