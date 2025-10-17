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

const DEFAULT_SETTINGS = {
  autoWebSearch: true,
  openThoughtsByDefault: false,
  searchResultLimit: 6,
};

const STORE_FILE = 'ollama-electron-chats.json';
const SETTINGS_FILE = 'ollama-electron-settings.json';

let chatsCache = [];
let chatsLoaded = false;
let storagePath;
let settings = null;
let settingsLoaded = false;
let settingsPath;

app.whenReady().then(async () => {
  await Promise.all([ensureSettingsLoaded(), ensureChatsLoaded()]);
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

ipcMain.handle('get-settings', async () => {
  await ensureSettingsLoaded();
  settings = sanitizeSettings(settings);
  return settings;
});

ipcMain.handle('update-settings', async (_event, partialSettings) => {
  await ensureSettingsLoaded();
  const base = settings || getDefaultSettings();
  const next = applySettingsPatch(base, partialSettings);
  settings = sanitizeSettings(next);
  await persistSettings();
  return sanitizeSettings(settings);
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
  await ensureSettingsLoaded();

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

  const effectiveSettings = getEffectiveSettings();
  const searchPlan = createSearchPlan(prompt, effectiveSettings);
  let contextResult = { text: '', entries: [], queries: [], retrievedAt: null };

  if (searchPlan.shouldSearch && searchPlan.queries.length) {
    event.sender.send('ollama-thinking', {
      chatId,
      stage: 'search-plan',
      message: searchPlan.message,
      queries: searchPlan.queries,
    });

    contextResult = await performWebSearch(searchPlan.queries, {
      limit: effectiveSettings.searchResultLimit,
    });

    event.sender.send('ollama-thinking', {
      chatId,
      stage: 'context',
      message: contextResult.entries.length ? 'Context gathered from the web.' : 'No relevant web results found.',
      context: contextResult.text,
      queries: contextResult.queries,
      retrievedAt: contextResult.retrievedAt,
    });
  } else {
    event.sender.send('ollama-thinking', {
      chatId,
      stage: 'context',
      message: searchPlan.disabled
        ? searchPlan.message || 'Web search disabled in settings.'
        : 'Responding with model knowledge (no web search).',
      context: '',
      queries: searchPlan.disabled ? searchPlan.queries : [],
    });
  }

  const messagesForModel = [
    { role: 'system', content: buildBaseSystemPrompt() },
    ...historyMessages,
  ];

  if (contextResult.text) {
    messagesForModel.push({
      role: 'system',
      content: buildContextInstruction({
        context: contextResult.text,
        retrievedAt: contextResult.retrievedAt,
        genericFresh: searchPlan.genericFresh,
      }),
    });
  }

  messagesForModel.push({ role: 'user', content: prompt });

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
  const contextQueries =
    Array.isArray(contextResult.queries) && contextResult.queries.length
      ? contextResult.queries
      : searchPlan.disabled
        ? searchPlan.queries
        : [];
  const contextRetrievedAt = contextResult.retrievedAt || null;

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
        context: contextResult.text,
        contextQueries,
        contextRetrievedAt,
        usedWebSearch: Boolean(contextResult.text),
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
    context: contextResult.text,
    contextQueries,
    contextRetrievedAt,
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

function getDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

async function ensureSettingsLoaded() {
  if (settingsLoaded) {
    return;
  }

  settingsPath = path.join(app.getPath('userData'), SETTINGS_FILE);

  try {
    const contents = await fsPromises.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(contents);
    settings = sanitizeSettings(parsed);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to load settings:', err);
    }
    settings = getDefaultSettings();
  }

  settingsLoaded = true;
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

async function persistSettings() {
  if (!settingsPath) {
    settingsPath = path.join(app.getPath('userData'), SETTINGS_FILE);
  }

  const safeSettings = sanitizeSettings(settings);
  settings = safeSettings;
  await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsPromises.writeFile(settingsPath, JSON.stringify(safeSettings, null, 2), 'utf8');
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

function sanitizeSettings(value) {
  if (!value || typeof value !== 'object') {
    return getDefaultSettings();
  }

  return applySettingsPatch(getDefaultSettings(), value);
}

function applySettingsPatch(base, partial) {
  const next = { ...base };
  if (!partial || typeof partial !== 'object') {
    return next;
  }

  if (partial.autoWebSearch !== undefined) {
    next.autoWebSearch = Boolean(partial.autoWebSearch);
  }

  if (partial.openThoughtsByDefault !== undefined) {
    next.openThoughtsByDefault = Boolean(partial.openThoughtsByDefault);
  }

  if (partial.searchResultLimit !== undefined) {
    next.searchResultLimit = clampSearchLimit(Number(partial.searchResultLimit));
  }

  return next;
}

function getEffectiveSettings() {
  const safe = sanitizeSettings(settings);
  settings = safe;
  return safe;
}

function clampSearchLimit(value) {
  const numeric = Number.isFinite(value) ? value : DEFAULT_SETTINGS.searchResultLimit;
  return Math.max(1, Math.min(12, Math.round(numeric)));
}

function shouldUseWebSearch(prompt) {
  if (!prompt) {
    return false;
  }

  const lower = prompt.toLowerCase();
  const questionWords = [
    'who',
    'what',
    'when',
    'where',
    'why',
    'how',
    'latest',
    'today',
    'current',
    'news',
    'update',
    'updates',
    'breaking',
  ];
  const looksLikeQuestion = prompt.trim().endsWith('?');
  const containsKeyword = questionWords.some((word) => lower.includes(word));

  return looksLikeQuestion || containsKeyword;
}

async function performWebSearch(queries, options = {}) {
  const uniqueQueries = Array.from(new Set((queries || []).filter(Boolean)));
  if (!uniqueQueries.length) {
    return { text: '', entries: [], queries: [], retrievedAt: null };
  }

  const entries = [];
  const seenUrls = new Set();
  const maxEntries = clampSearchLimit(
    options && options.limit !== undefined ? Number(options.limit) : DEFAULT_SETTINGS.searchResultLimit
  );
  const retrievedAt = new Date().toISOString();

  try {
    /* eslint-disable no-await-in-loop */
    for (const query of uniqueQueries) {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&ia=web`;
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

      $('.result').each((index, element) => {
        if (entries.length >= maxEntries) {
          return false;
        }

        const title =
          $(element).find('.result__a').text().trim() ||
          $(element).find('.result__title').text().trim();
        const snippet = $(element).find('.result__snippet').text().trim();
        const rawHref = $(element).find('.result__a').attr('href');
        const urlValue = decodeDuckDuckGoUrl(rawHref);

        if (!title && !snippet) {
          return;
        }

        if (urlValue && seenUrls.has(urlValue)) {
          return;
        }

        if (urlValue) {
          seenUrls.add(urlValue);
        }

        entries.push({
          title: title || urlValue || 'Result',
          snippet: snippet ? truncateSnippet(snippet) : '',
          url: urlValue,
          queryUsed: query,
        });
      });

      if (entries.length >= maxEntries) {
        break;
      }
    }
    /* eslint-enable no-await-in-loop */

    if (!entries.length) {
      return { text: '', entries: [], queries: uniqueQueries, retrievedAt };
    }

    return {
      text: formatSearchEntries(entries, retrievedAt, uniqueQueries),
      entries,
      queries: uniqueQueries,
      retrievedAt,
    };
  } catch (err) {
    console.error('Web search failed:', err);
    return { text: '', entries: [], queries: uniqueQueries, retrievedAt };
  }
}

function createSearchPlan(prompt, prefs = getDefaultSettings()) {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return {
      shouldSearch: false,
      queries: [],
      genericFresh: false,
      message: '',
      disabled: prefs?.autoWebSearch === false,
    };
  }

  const autoEnabled = prefs?.autoWebSearch !== false;
  const genericFresh = isGenericFreshInfoPrompt(trimmed);
  const baseShouldSearch = shouldUseWebSearch(trimmed);
  const queries = generateSearchQueries(trimmed);

  if (!autoEnabled) {
    return {
      shouldSearch: false,
      queries: queries.length ? queries : [trimmed],
      genericFresh,
      message: 'Web search is disabled in settings.',
      disabled: true,
    };
  }

  const hasQueries = queries.length > 0;
  const shouldSearch = autoEnabled ? hasQueries || baseShouldSearch || genericFresh : baseShouldSearch || genericFresh;

  return {
    shouldSearch,
    queries: queries.length ? queries : [trimmed],
    genericFresh,
    message: genericFresh
      ? 'Broad request detected – gathering current headlines.'
      : autoEnabled
        ? 'Automatic web search is enabled – gathering supporting snippets.'
        : 'Collecting supporting information from the web.',
    disabled: false,
  };
}

function isGenericFreshInfoPrompt(prompt) {
  const lower = prompt.toLowerCase();
  const genericPhrases = [
    'latest news',
    'whats the latest news',
    "what's the latest news",
    'what is the latest news',
    'what is happening',
    "what's happening",
    'current events',
    'latest updates',
    'latest headlines',
    'breaking news',
  ];

  if (genericPhrases.some((phrase) => lower === phrase || lower.startsWith(`${phrase} `))) {
    return true;
  }

  if (prompt.split(/\s+/).length <= 4 && /latest|news|update|updates|headlines/.test(lower)) {
    return true;
  }

  return false;
}

function generateSearchQueries(prompt) {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return [];
  }

  const lower = trimmed.toLowerCase();
  const queries = new Set([trimmed]);
  const today = new Date();
  const isoDate = today.toISOString().split('T')[0];
  const readableDate = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(today);

  if (lower.includes('news')) {
    const topic = extractNewsTopic(trimmed);
    const focus = topic || 'world';
    queries.add(`${focus} news ${readableDate}`);
    queries.add(`breaking ${focus} news ${isoDate}`);
    queries.add(`top ${focus} headlines ${isoDate}`);
  } else if (lower.includes('update') || lower.includes('latest')) {
    const keyword = trimmed
      .replace(/(what('?s)?|is|are|the|latest|updates|update)/gi, '')
      .trim() || 'latest developments';
    queries.add(`${keyword} updates ${readableDate}`);
    queries.add(`${keyword} developments ${isoDate}`);
  }

  return Array.from(queries).slice(0, 4);
}

function extractNewsTopic(prompt) {
  const match = prompt.match(/latest\s+news(?:\s+(?:about|on|regarding))?\s*(.*)/i);
  if (match && match[1]) {
    const topic = match[1].trim();
    if (topic) {
      return topic;
    }
  }

  const aboutMatch = prompt.match(/news\s+(?:about|on|regarding)\s+(.*)/i);
  if (aboutMatch && aboutMatch[1]) {
    return aboutMatch[1].trim();
  }

  return '';
}

function buildBaseSystemPrompt() {
  return [
    'You are a precise assistant that values factual accuracy.',
    'Cite the source domain in parentheses when you use supplied context.',
    'If the provided context does not answer the question, say you do not know.',
  ].join(' ');
}

function buildContextInstruction({ context, retrievedAt, genericFresh }) {
  const lines = [
    'Incorporate the verified facts from the context below when answering.',
    'Never invent information that is not supported by the context or prior conversation.',
  ];

  if (genericFresh) {
    lines.push(
      'Summarize the most important updates as concise bullet points, grouped by theme when possible.'
    );
    lines.push('Mention each source domain in parentheses and include a short closing takeaway.');
  } else {
    lines.push('Reference the source domain in parentheses after key facts.');
  }

  if (retrievedAt) {
    lines.push('', `Context retrieved: ${formatReadableDate(retrievedAt)}`);
  }

  lines.push('', 'Context:', context);
  return lines.join('\n');
}

function formatReadableDate(isoString) {
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch (err) {
    return isoString;
  }
}

function formatSearchEntries(entries, retrievedAt, queries) {
  const header = [
    `Fresh context collected ${formatReadableDate(retrievedAt)}:`,
    queries.length ? `Queries used: ${queries.join(', ')}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const body = entries
    .map((entry) => {
      const lines = [`• ${entry.title}`];
      if (entry.snippet) {
        lines.push(entry.snippet);
      }
      if (entry.url) {
        try {
          const host = new URL(entry.url).hostname.replace(/^www\./, '');
          lines.push(`Source: ${host} (${entry.url})`);
        } catch (err) {
          lines.push(`Source: ${entry.url}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');

  return `${header}${body}`;
}

function decodeDuckDuckGoUrl(href) {
  if (!href) {
    return '';
  }

  try {
    const absolute = href.startsWith('http') ? href : `https://duckduckgo.com${href}`;
    const url = new URL(absolute);

    if (url.hostname.includes('duckduckgo.com') && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg');
      if (target) {
        return decodeURIComponent(target);
      }
    }

    return absolute;
  } catch (err) {
    return '';
  }
}

function truncateSnippet(snippet) {
  if (snippet.length <= 320) {
    return snippet;
  }
  return `${snippet.slice(0, 317)}…`;
}
