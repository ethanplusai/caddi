const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') throw new Error('Callback required');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('caddi', Object.freeze({
  getState: () => ipcRenderer.invoke('caddi-desktop:state'),
  action: value => ipcRenderer.invoke('caddi-desktop:action', value),
  artifactPreview: value => ipcRenderer.invoke('caddi-desktop:artifact-preview', value),
  preparedPreview: value => ipcRenderer.invoke('caddi-desktop:prepared-preview', value),
  layout: value => ipcRenderer.invoke('caddi-desktop:layout', value),
  voiceAudio: value => ipcRenderer.invoke('caddi-desktop:audio', value),
  voiceStopped: value => ipcRenderer.invoke('caddi-desktop:audio-stopped', value),
  liveAudio: value => ipcRenderer.invoke('caddi-desktop:live-audio', value),
  liveStopped: value => ipcRenderer.invoke('caddi-desktop:live-audio-stopped', value),
  boardImage: value => ipcRenderer.invoke('caddi-desktop:board-image', value),
  onState: callback => subscribe('caddi-desktop:state', callback),
  onNotice: callback => subscribe('caddi-desktop:notice', callback),
  onVoiceStop: callback => subscribe('caddi-desktop:voice-stop', callback),
  onCommand: callback => subscribe('caddi-desktop:command', callback),
}));
