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
};

contextBridge.exposeInMainWorld('api', exposeAPI);
