const { contextBridge, ipcRenderer } = require('electron');

const exposeAPI = {
  getModels: () => ipcRenderer.invoke('fetch-models'),
  askOllama: (payload) => ipcRenderer.invoke('ask-ollama', payload),
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
};

contextBridge.exposeInMainWorld('api', exposeAPI);
