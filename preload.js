const { contextBridge, ipcRenderer } = require('electron');

const exposeAPI = {
  getModels: () => ipcRenderer.invoke('fetch-models'),
  askOllama: (payload) => ipcRenderer.invoke('ask-ollama', payload),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),
  cancelOllama: (payload) => ipcRenderer.invoke('cancel-ollama', payload),
  exportChat: ({ chatId, format }) => ipcRenderer.invoke('export-chat', { chatId, format }),
  listChats: () => ipcRenderer.invoke('list-chats'),
  createChat: (model) => ipcRenderer.invoke('create-chat', { model }),
  getChat: (chatId) => ipcRenderer.invoke('get-chat', { chatId }),
  deleteAllChats: () => ipcRenderer.invoke('delete-all-chats'),
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
};

contextBridge.exposeInMainWorld('api', exposeAPI);
