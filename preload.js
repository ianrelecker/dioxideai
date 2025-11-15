const { contextBridge, ipcRenderer } = require('electron');

const exposeAPI = {
  getModels: () => ipcRenderer.invoke('fetch-models'),
  askOllama: (payload) => ipcRenderer.invoke('ask-ollama', payload),
  deepResearch: (payload) => ipcRenderer.invoke('deep-research', payload),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),
  cancelOllama: (payload) => ipcRenderer.invoke('cancel-ollama', payload),
  exportChat: ({ chatId, format }) => ipcRenderer.invoke('export-chat', { chatId, format }),
  listChats: () => ipcRenderer.invoke('list-chats'),
  createChat: (model) => ipcRenderer.invoke('create-chat', { model }),
  getChat: (chatId) => ipcRenderer.invoke('get-chat', { chatId }),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  deleteAllChats: () => ipcRenderer.invoke('delete-all-chats'),
  pickLocalFiles: (options) => ipcRenderer.invoke('pick-local-files', options),
  setChatAttachments: ({ chatId, attachments }) =>
    ipcRenderer.invoke('set-chat-attachments', { chatId, attachments }),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onStream: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ollama-stream', listener);
    return () => ipcRenderer.removeListener('ollama-stream', listener);
  },
  onThinking: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ollama-thinking', listener);
    return () => ipcRenderer.removeListener('ollama-thinking', listener);
  },
  renderMarkdown: (text) => ipcRenderer.invoke('render-markdown', text),
  onAutoUpdateStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('auto-update-status', listener);
    return () => ipcRenderer.removeListener('auto-update-status', listener);
  },
  onAutoUpdateProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('auto-update-progress', listener);
    return () => ipcRenderer.removeListener('auto-update-progress', listener);
  },
  onDeepResearchProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('deep-research-progress', listener);
    return () => ipcRenderer.removeListener('deep-research-progress', listener);
  },
  initAnalytics: (options) => ipcRenderer.invoke('analytics-init', options),
  setAnalyticsOptOut: (optOut) => ipcRenderer.invoke('analytics-set-opt-out', optOut),
  trackAnalyticsEvent: (name, props) => ipcRenderer.invoke('analytics-track', { name, props }),
};

contextBridge.exposeInMainWorld('api', exposeAPI);
