// preload.js — コントロールパネルに公開する API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('panel:init'),
  navigate: (url) => ipcRenderer.invoke('panel:navigate', url),
  setPreview: (on) => ipcRenderer.invoke('panel:set-preview', on),
  setVirtual: (on) => ipcRenderer.invoke('panel:set-virtual', on),
  reloadList: () => ipcRenderer.invoke('panel:reload-list'),
  input: (ev) => ipcRenderer.send('panel:input', ev),
  insertText: (text) => ipcRenderer.send('panel:insert-text', text),
  onUrl: (cb) => ipcRenderer.on('display:url', (_e, url) => cb(url)),
  onBounds: (cb) => ipcRenderer.on('display:bounds', (_e, bounds) => cb(bounds)),
  onFrame: (cb) => ipcRenderer.on('preview:frame', (_e, jpeg) => cb(jpeg)),
});
