'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Same narrow renderer contract; independent channels, never EdgeDock handlers.
contextBridge.exposeInMainWorld('tokenMonitorEdgeDock', {
  ready: () => ipcRenderer.send('topNotch:ready'),
  reportNotchSize: (height, slots, rows, summaryMeasurement) => ipcRenderer.send('topNotch:size', { height, slots, rows, summaryMeasurement }),
  reportBubbleSize: (cellId, height) => ipcRenderer.send('topNotch:bubbleSize', { cellId, height }),
  reportMotionFrame: (id, elapsed) => ipcRenderer.send('topNotch:frame', { id, elapsed }),
  onAnimate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('topNotch:animate', listener);
    return () => ipcRenderer.removeListener('topNotch:animate', listener);
  },
  onMotion: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('topNotch:motion', listener);
    return () => ipcRenderer.removeListener('topNotch:motion', listener);
  },
  dismiss: () => ipcRenderer.send('topNotch:dismiss'),
  refreshLimits: () => ipcRenderer.invoke('topNotch:refreshLimits'),
  toggleRateMode: () => ipcRenderer.send('topNotch:toggleRateMode'),
  switchCodexAccount: (accountId) => ipcRenderer.invoke('topNotch:switchCodexAccount', { accountId }),
  openResetForecastSource: () => ipcRenderer.send('topNotch:openResetForecastSource'),
  onRender: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('topNotch:render', listener);
    return () => ipcRenderer.removeListener('topNotch:render', listener);
  }
});
