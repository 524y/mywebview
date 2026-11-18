// preload.js — コントロールパネルに公開する API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('panel:init'),
  navigate: (url) => ipcRenderer.invoke('panel:navigate', url),
  closeExe: (text) => ipcRenderer.invoke('panel:close-exe', text),
  setPreview: (on) => ipcRenderer.invoke('panel:set-preview', on),
  setVirtual: (on) => ipcRenderer.invoke('panel:set-virtual', on),
  setBlackout: (on) => ipcRenderer.invoke('panel:set-blackout', on),
  reloadList: () => ipcRenderer.invoke('panel:reload-list'),
  input: (ev) => ipcRenderer.send('panel:input', ev),
  insertText: (text) => ipcRenderer.send('panel:insert-text', text),
  onUrl: (cb) => ipcRenderer.on('display:url', (_e, url) => cb(url)),
  onBounds: (cb) => ipcRenderer.on('display:bounds', (_e, bounds) => cb(bounds)),
  onFrame: (cb) => ipcRenderer.on('preview:frame', (_e, jpeg) => cb(jpeg)),
  onSource: (cb) => ipcRenderer.on('preview:source', (_e, id) => cb(id)),
  onStatus: (cb) => ipcRenderer.on('display:status', (_e, m) => cb(m)),
  onRunning: (cb) => ipcRenderer.on('display:running', (_e, list) => cb(list)),
  onBlackout: (cb) => ipcRenderer.on('display:blackout', (_e, on) => cb(on)),
});
