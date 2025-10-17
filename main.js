const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { promises: fsPromises } = fs;
const { randomUUID } = require('crypto');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

// Enable hot-reload during development; ignore failures in production builds.
try {
  require('electron-reload')(__dirname, {
    electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
  });
} catch (err) {
  console.warn('electron-reload not available:', err.message);
}

const STORE_FILE = 'ollama-electron-chats.json';

let chatsCache = [];
let chatsLoaded = false;
let storagePath;

app.whenReady().then(async () => {
  await ensureChatsLoaded();
  createWindow();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadFile('index.html');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('fetch-models', async () => {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];

    return models.map((model) => model.name);
  } catch (err) {
    console.error('Error fetching models:', err);
    return [];
  }
});

ipcMain.handle('list-chats', async () => {
  await ensureChatsLoaded();
  return getChatSummaries();
});

ipcMain.handle('create-chat', async (_event, { model }) => {
  await ensureChatsLoaded();
  const chat = createChatRecord(model || null);
  upsertChat(chat);
  await persistChats();
  return sanitizeChat(chat);
});

ipcMain.handle('get-chat', async (_event, { chatId }) => {
  await ensureChatsLoaded();
  const chat = chatsCache.find((item) => item.id === chatId);
  return chat ? sanitizeChat(chat) : null;
});

ipcMain.handle('ask-ollama', async (event, { chatId, model, prompt }) => {
  if (!prompt?.trim()) {
    return { chatId, error: 'Prompt is empty' };
  }

  await ensureChatsLoaded();

  let chat = chatId ? chatsCache.find((item) => item.id === chatId) : null;
  if (!chat) {
    chat = createChatRecord(model || null);
    upsertChat(chat);
    await persistChats();
    chatId = chat.id;
  }

  chat.model = model;

  const now = new Date().toISOString();
  const historyMessages = chat.messages.map(({ role, content }) => ({ role, content }));

  let contextText = '';
  const shouldSearch = shouldUseWebSearch(prompt);

  if (shouldSearch) {
    event.sender.send('ollama-thinking', {
      chatId,
      stage: 'search-started',
      message: 'Searching DuckDuckGo for fresh context…',
    });
    contextText = await performWebSearch(prompt);
    event.sender.send('ollama-thinking', {
      chatId,
      stage: 'context',
      message: contextText ? 'Context gathered from the web.' : 'No relevant web results found.',
      context: contextText,
    });
  } else {
    event.sender.send('ollama-thinking', {
      chatId,
      stage: 'context',
      message: 'Responding with model knowledge (no web search).',
      context: '',
    });
  }

  const messagesForModel = [
    ...historyMessages,
    ...(contextText
      ? [
          {
            role: 'system',
            content: [
              'You are an assistant that can use external context when provided.',
              'Only rely on the context when it clearly answers the question.',
              '',
              'External context:',
              contextText,
            ].join('\n'),
          },
        ]
      : []),
    { role: 'user', content: prompt },
  ];

  let assistantContent = '';

  try {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messagesForModel,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: HTTP ${response.status}`);
    }

    let buffer = '';
    const stream = response.body;

    const processLine = (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const parsed = JSON.parse(line);

        if (parsed?.message?.content) {
          assistantContent += parsed.message.content;
          event.sender.send('ollama-stream', {
            chatId,
            delta: parsed.message.content,
            full: assistantContent,
            done: false,
          });
        }

        if (parsed?.done) {
          event.sender.send('ollama-stream', {
            chatId,
            delta: '',
            full: assistantContent,
            done: true,
          });
        }
      } catch (err) {
        console.error('Failed to parse stream chunk:', err);
      }
    };

    for await (const chunk of stream) {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf('\n');

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    }

    if (buffer.trim()) {
      processLine(buffer);
    }
  } catch (err) {
    console.error('Error querying Ollama:', err);
    event.sender.send('ollama-stream', {
      chatId,
      error: err.message || 'Unknown error',
      done: true,
    });
    return { chatId, error: 'Error: Unable to get response' };
  }

  const trimmedAnswer = assistantContent.trim();

  chat.messages.push(
    {
      id: randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: now,
    },
    {
      id: randomUUID(),
      role: 'assistant',
      content: trimmedAnswer,
      createdAt: new Date().toISOString(),
      meta: {
        context: contextText,
        usedWebSearch: Boolean(contextText),
      },
    }
  );

  if (!chat.title || chat.title === 'New Chat') {
    chat.title = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  }

  upsertChat(chat);
  await persistChats();

  return {
    chatId,
    answer: trimmedAnswer,
    context: contextText,
  };
});

function createChatRecord(model = null) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: 'New Chat',
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

async function ensureChatsLoaded() {
  if (chatsLoaded) {
    return;
  }

  storagePath = path.join(app.getPath('userData'), STORE_FILE);

  try {
    const contents = await fsPromises.readFile(storagePath, 'utf8');
    const parsed = JSON.parse(contents);
    if (Array.isArray(parsed)) {
      chatsCache = parsed;
    } else {
      chatsCache = [];
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to load chats:', err);
    }
    chatsCache = [];
  }

  chatsLoaded = true;
}

function upsertChat(chat) {
  const existingIndex = chatsCache.findIndex((item) => item.id === chat.id);
  if (existingIndex !== -1) {
    chatsCache[existingIndex] = chat;
  } else {
    chatsCache.push(chat);
  }

  chat.updatedAt = new Date().toISOString();
  chatsCache.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function persistChats() {
  if (!storagePath) {
    return;
  }

  await fsPromises.mkdir(path.dirname(storagePath), { recursive: true });
  await fsPromises.writeFile(storagePath, JSON.stringify(chatsCache, null, 2), 'utf8');
}

function getChatSummaries() {
  return chatsCache.map((chat) => ({
    id: chat.id,
    title: chat.title || 'New Chat',
    model: chat.model,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  }));
}

function sanitizeChat(chat) {
  return JSON.parse(JSON.stringify(chat));
}

function shouldUseWebSearch(prompt) {
  if (!prompt) {
    return false;
  }

  const lower = prompt.toLowerCase();
  const questionWords = ['who', 'what', 'when', 'where', 'why', 'how', 'latest', 'today', 'current'];
  const looksLikeQuestion = prompt.trim().endsWith('?');
  const containsKeyword = questionWords.some((word) => lower.includes(word));

  return looksLikeQuestion || containsKeyword;
}

async function performWebSearch(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
      },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo HTTP ${res.status}`);
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const snippets = [];

    $('.result').each((index, element) => {
      if (snippets.length >= 3) {
        return false;
      }

      const title = $(element).find('.result__title').text().trim();
      const snippet = $(element).find('.result__snippet').text().trim();
      if (snippet) {
        snippets.push([title, snippet].filter(Boolean).join('\n'));
      }
    });

    if (!snippets.length) {
      return '';
    }

    return snippets.join('\n\n');
  } catch (err) {
    console.error('Web search failed:', err);
    return '';
  }
}
