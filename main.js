const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { promises: fsPromises } = fs;
const { randomUUID } = require('crypto');
const fetch = require('node-fetch');
const amplitude = require('@amplitude/analytics-node');
const dns = require('dns');
const dnsPromises = dns.promises;
const cheerio = require('cheerio');
const { marked } = require('marked');
const { autoUpdater } = require('electron-updater');

const isDevelopment = !app.isPackaged;

// Enable hot-reload during development; ignore failures in production builds.
if (isDevelopment) {
  try {
    require('electron-reload')(__dirname, {
      electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
    });
  } catch (err) {
    console.warn('electron-reload not available:', err.message);
  }
}

const DEFAULT_SETTINGS = {
  autoWebSearch: true,
  openThoughtsByDefault: false,
  searchResultLimit: 10,
  theme: 'system',
  showTutorial: true,
  shareAnalytics: true,
  ollamaEndpoint: 'http://localhost:11434',
  analyticsDeviceId: null,
  useOpenAICompatibleEndpoint: false,
};

const STORE_FILE = 'dioxideai-chats.json';
const SETTINGS_FILE = 'dioxideai-settings.json';
const LEGACY_STORE_FILES = ['ollama-electron-chats.json'];
const LEGACY_SETTINGS_FILES = ['ollama-electron-settings.json'];

let chatsCache = [];
let chatsLoaded = false;
let storagePath;
let settings = null;
let settingsLoaded = false;
let settingsPath;

const activeRequests = new Map();
let mainWindow = null;
let autoUpdateInitialized = false;
let lastConnectivityCheck = 0;
let lastConnectivityStatus = true;
const ANALYTICS_CONFIG_FILENAME = 'config/analytics-key.json';
let analyticsClient = null;
let analyticsClientInitPromise = null;
let analyticsOptOut = false;
let analyticsDeviceId = null;
let analyticsDeviceIdPromise = null;
let analyticsApiKey = null;
let analyticsApiKeyLoaded = false;

function normalizeOllamaEndpoint(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const base = trimmed || DEFAULT_SETTINGS.ollamaEndpoint;
  return base.replace(/\/+$/, '');
}

function resolveOllamaEndpoint() {
  const effective = getEffectiveSettings();
  return normalizeOllamaEndpoint(effective.ollamaEndpoint);
}

function buildOllamaUrl(pathname) {
  const base = resolveOllamaEndpoint();
  const cleanPath = pathname && pathname.startsWith('/') ? pathname : `/${pathname || ''}`;
  return `${base}${cleanPath}`;
}

async function chatCompletion(model, messages, options = {}, effectiveSettingsOverride = null) {
  if (!model || !String(model).trim()) {
    throw new Error('Model is required for chat completion.');
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('Messages are required for chat completion.');
  }

  const timeoutMs = Number.isFinite(options?.timeoutMs) ? Math.max(4000, Number(options.timeoutMs)) : 20000;
  const effectiveSettings = effectiveSettingsOverride || getEffectiveSettings();
  const baseUrl = normalizeOllamaEndpoint(effectiveSettings.ollamaEndpoint);
  const usingChatCompat = Boolean(effectiveSettings.useOpenAICompatibleEndpoint);
  const endpointPath = usingChatCompat ? '/v1/chat/completions' : '/api/chat';
  const body = {
    model,
    messages,
    stream: false,
  };
  if (options?.temperature !== undefined) {
    if (usingChatCompat) {
      body.temperature = options.temperature;
    } else {
      body.options = { ...(body.options || {}), temperature: options.temperature };
    }
  }

  const response = await fetchWithTimeout(
    `${baseUrl}${endpointPath}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const sourceLabel = usingChatCompat ? 'ChatGPT-compatible chat' : 'Ollama chat';
    throw new Error(`${sourceLabel} failed (HTTP ${response.status})${errorText ? ` – ${errorText.slice(0, 200)}` : ''}`);
  }

  const data = await response.json();
  const firstChoice = Array.isArray(data?.choices) ? data.choices[0] : null;
  let content = '';
  if (typeof data?.message?.content === 'string') {
    content = data.message.content;
  } else if (typeof data?.response === 'string') {
    content = data.response;
  } else if (usingChatCompat) {
    if (typeof firstChoice?.message?.content === 'string') {
      content = firstChoice.message.content;
    } else if (typeof firstChoice?.delta?.content === 'string') {
      content = firstChoice.delta.content;
    }
  }

  return {
    content: typeof content === 'string' ? content.trim() : '',
    raw: data,
  };
}

function formatFindingsForPrompt(findings = []) {
  if (!Array.isArray(findings) || !findings.length) {
    return '';
  }
  return findings
    .map((entry, index) => {
      const title = entry?.title || entry?.url || `Finding ${index + 1}`;
      const detail = entry?.summary || entry?.snippet || '';
      const host = entry?.url ? resolveHostname(entry.url) : '';
      const parts = [`${index + 1}. ${title}`];
      if (detail) {
        parts.push(detail);
      }
      if (host) {
        parts.push(`(${host})`);
      } else if (entry?.url) {
        parts.push(`(${entry.url})`);
      }
      return parts.join(' ');
    })
    .join('\n');
}

function extractJsonObjectFromText(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    // continue
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    return null;
  }
}

async function synthesizeDeepResearchDraft({
  model,
  topic,
  findings,
  priorDraft = '',
  reflection = '',
}) {
  if (!model || !Array.isArray(findings) || !findings.length) {
    return '';
  }
  const findingsText = formatFindingsForPrompt(findings);
  const lines = [
    `Question: ${topic}`,
    '',
    'Findings gathered from the web:',
    findingsText,
  ];
  if (reflection) {
    lines.push('', 'Key takeaways so far:', reflection);
  }
  if (priorDraft) {
    lines.push('', 'Earlier draft answer:', priorDraft);
  }
  lines.push(
    '',
    'Craft a precise answer that only relies on these findings. Cite concrete facts, note disagreements when present, and explain implications in 2-3 short paragraphs. Do not mention this instruction.'
  );

  const messages = [
    {
      role: 'system',
      content:
        'You are a meticulous researcher that drafts concise, evidence-backed answers from supplied findings. Never fabricate information.',
    },
    { role: 'user', content: lines.join('\n') },
  ];

  const result = await chatCompletion(model, messages, { timeoutMs: 25000 });
  return result.content || '';
}

async function evaluateDeepResearchDraft({ model, topic, draft }) {
  if (!model || !draft) {
    return null;
  }

  const instructions = [
    'You are a critical reviewer that decides whether a draft fully answers the question.',
    'Respond ONLY with JSON: {"verdict":"good"|"revise","critique":"<brief reason>"}',
    'Mark "good" only if the draft directly answers the question, cites concrete facts from the findings, and addresses likely follow-ups.',
  ].join(' ');

  const messages = [
    { role: 'system', content: instructions },
    {
      role: 'user',
      content: `Question: ${topic}\n\nDraft answer:\n${draft}\n\nIs this answer complete and well-supported?`,
    },
  ];

  const result = await chatCompletion(model, messages, { timeoutMs: 20000 });
  const parsed = extractJsonObjectFromText(result.content);
  if (!parsed) {
    return null;
  }
  const verdictRaw = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
  const critique = typeof parsed.critique === 'string' ? parsed.critique.trim() : '';
  const accepted = verdictRaw === 'good' || verdictRaw === 'approve' || verdictRaw === 'yes';

  return {
    verdict: verdictRaw || (accepted ? 'good' : 'revise'),
    critique,
    accepted,
  };
}

function getAnalyticsApiKey() {
  if (!analyticsApiKeyLoaded) {
    analyticsApiKey = resolveAnalyticsApiKey();
    analyticsApiKeyLoaded = true;
  }
  return analyticsApiKey;
}

function resolveAnalyticsApiKey() {
  if (process.env.AMPLITUDE_API_KEY && process.env.AMPLITUDE_API_KEY.trim()) {
    return process.env.AMPLITUDE_API_KEY.trim();
  }

  const configPath = resolveAnalyticsConfigPath();

  try {
    const contents = fs.readFileSync(configPath, 'utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(contents);
    } catch (parseErr) {
      parsed = contents;
    }

    const candidate =
      (parsed && typeof parsed === 'object' && parsed !== null
        ? parsed.amplitudeApiKey || parsed.apiKey || parsed.key
        : parsed) || '';
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('Failed to read analytics API key file:', err.message || err);
    }
  }

  return null;
}

function resolveAnalyticsConfigPath() {
  const candidatePaths = [];

  if (typeof app?.getAppPath === 'function') {
    try {
      candidatePaths.push(path.join(app.getAppPath(), ANALYTICS_CONFIG_FILENAME));
    } catch (err) {
      // Swallow; we'll fall back to other locations.
    }
  }

  if (app?.isPackaged && process?.resourcesPath) {
    candidatePaths.push(path.join(process.resourcesPath, 'app.asar', ANALYTICS_CONFIG_FILENAME));
    candidatePaths.push(path.join(process.resourcesPath, ANALYTICS_CONFIG_FILENAME));
  }

  candidatePaths.push(path.join(__dirname, ANALYTICS_CONFIG_FILENAME));

  for (const candidate of candidatePaths) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (err) {
      // Ignore access errors; continue to next candidate.
    }
  }

  return candidatePaths[candidatePaths.length - 1];
}

async function ensureAnalyticsClient() {
  if (analyticsOptOut) {
    return null;
  }

  if (analyticsClient) {
    if (analyticsClientInitPromise) {
      try {
        await analyticsClientInitPromise;
      } catch (err) {
        console.error('Analytics initialization previously failed:', err);
        return null;
      }
    }
    return analyticsClient;
  }

  const apiKey = getAnalyticsApiKey();
  if (!apiKey) {
    console.warn('Analytics API key not found. Usage analytics disabled.');
    return null;
  }

  analyticsClient = amplitude.createInstance();
  const initResult = analyticsClient.init(apiKey, {
    serverZone: 'US',
    flushIntervalMillis: 5000,
  });

  const initPromise =
    initResult && typeof initResult === 'object' && typeof initResult.promise?.then === 'function'
      ? initResult.promise
      : Promise.resolve();

  analyticsClientInitPromise = initPromise
    .then(() => {
      analyticsClientInitPromise = null;
      if (analyticsClient?.setOptOut) {
        analyticsClient.setOptOut(Boolean(analyticsOptOut));
      }
      return analyticsClient;
    })
    .catch((err) => {
      analyticsClientInitPromise = null;
      analyticsClient = null;
      console.error('Failed to initialize analytics client:', err);
      return null;
    });

  return analyticsClientInitPromise;
}

async function setAnalyticsOptOut(optOut) {
  analyticsOptOut = Boolean(optOut);
  if (analyticsOptOut) {
    if (analyticsClient?.setOptOut) {
      analyticsClient.setOptOut(true);
    }
    return { initialized: Boolean(analyticsClient), optedOut: true };
  }

  const client = await ensureAnalyticsClient();
  if (client?.setOptOut) {
    client.setOptOut(false);
  }
  return { initialized: Boolean(client), optedOut: analyticsOptOut || !client };
}

async function ensureAnalyticsDeviceId() {
  if (analyticsDeviceId) {
    return analyticsDeviceId;
  }
  if (analyticsDeviceIdPromise) {
    return analyticsDeviceIdPromise;
  }

  analyticsDeviceIdPromise = (async () => {
    try {
      await ensureSettingsLoaded();
    } catch (err) {
      console.error('Failed to load settings for analytics device id:', err);
    }

    const existing =
      settings &&
      typeof settings.analyticsDeviceId === 'string' &&
      settings.analyticsDeviceId.trim();

    if (existing) {
      analyticsDeviceId = existing.trim();
      return analyticsDeviceId;
    }

    const generated = randomUUID();
    const baseSettings = settings && typeof settings === 'object' ? settings : getDefaultSettings();
    settings = applySettingsPatch(baseSettings, { analyticsDeviceId: generated });

    try {
      await persistSettings();
    } catch (err) {
      console.error('Failed to persist analytics device id:', err);
    }

    analyticsDeviceId = generated;
    return analyticsDeviceId;
  })();

  try {
    const resolved = await analyticsDeviceIdPromise;
    analyticsDeviceIdPromise = null;
    return resolved;
  } catch (err) {
    analyticsDeviceIdPromise = null;
    throw err;
  }
}

async function trackAnalyticsEventMain(name, props = {}) {
  if (analyticsOptOut || !name) {
    return false;
  }
  const client = await ensureAnalyticsClient();
  if (!client || typeof client.track !== 'function') {
    return false;
  }
  try {
    let deviceId = 'dioxideai-desktop';
    try {
      const ensuredId = await ensureAnalyticsDeviceId();
      if (ensuredId) {
        deviceId = ensuredId;
      }
    } catch (deviceErr) {
      console.error('Failed to resolve analytics device id:', deviceErr);
    }

    const result = client.track({
      event_type: String(name),
      event_properties: props || {},
      device_id: deviceId,
    });
    if (result && typeof result === 'object' && typeof result.promise?.then === 'function') {
      await result.promise;
    }
    return true;
  } catch (err) {
    console.error('Failed to track analytics event:', err);
    return false;
  }
}

const TOKEN_STOP_WORDS = new Set([
  'what',
  "what's",
  'whats',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  "it's",
  'its',
  'that',
  'this',
  'those',
  'these',
  'they',
  'them',
  'their',
  'theirs',
  'he',
  'she',
  'him',
  'her',
  'hers',
  'we',
  'us',
  'our',
  'ours',
  'you',
  'your',
  'yours',
  'me',
  'do',
  'does',
  'did',
  'done',
  'have',
  'has',
  'had',
  'will',
  'would',
  'can',
  'could',
  'should',
  'about',
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'for',
  'on',
  'in',
  'at',
  'with',
  'from',
  'as',
  'so',
  'just',
  'really',
  'thing',
  'things',
  'stuff',
  'one',
  'something',
  'give',
  'more',
  'some',
  'another',
  'else',
  'info',
  'information',
  'details',
  'bit',
  'tell',
  'still',
  'same',
]);

const REFERENTIAL_FOLLOW_UP_STOP_WORDS = TOKEN_STOP_WORDS;

const MAX_ATTACHMENTS_PER_PROMPT = 1;
const MAX_ATTACHMENT_BYTES = 512 * 1024; // 512 KB per file
const MAX_ATTACHMENT_TOTAL_BYTES = 1024 * 1024; // 1 MB per request
const MAX_ATTACHMENT_CHARS = 4000;
const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.log',
  '.yaml',
  '.yml',
]);

const MIN_DEEP_RESEARCH_ITERATIONS = 3;
const MAX_DEEP_RESEARCH_ITERATIONS = 5;
const DEFAULT_DEEP_RESEARCH_ITERATIONS = 4;
const DEEP_RESEARCH_FINDINGS_PER_PASS = 3;
const DEEP_RESEARCH_MAX_QUERY_POOL = 8;
const DEEP_RESEARCH_MAX_SUMMARY_CHARS = 2000;
const DUCKDUCKGO_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const DUCKDUCKGO_HTML_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const DUCKDUCKGO_JSON_ACCEPT = 'application/json, text/plain;q=0.9, */*;q=0.8';
const DUCKDUCKGO_SEARCH_VARIANTS = [
  {
    name: 'html-get',
    type: 'html',
    method: 'GET',
    buildUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&ia=web`,
  },
  {
    name: 'html-post',
    type: 'html',
    method: 'POST',
    buildUrl: () => 'https://html.duckduckgo.com/html/',
    buildBody: (query) => new URLSearchParams({ q: query, ia: 'web' }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  },
  {
    name: 'main-html',
    type: 'html',
    method: 'GET',
    buildUrl: (query) => `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&ia=web`,
  },
  {
    name: 'lite',
    type: 'html',
    method: 'GET',
    buildUrl: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&ia=web`,
  },
  {
    name: 'instant-answer',
    type: 'json',
    method: 'GET',
    buildUrl: (query) =>
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
  },
];

app.whenReady().then(async () => {
  await Promise.all([ensureSettingsLoaded(), ensureChatsLoaded()]);
  createWindow();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 780,
    minWidth: 860,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile('index.html');

  if (isDevelopment) {
    mainWindow.webContents.openDevTools();
  }

  initializeAutoUpdates();
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

app.on('before-quit', () => {
  if (analyticsClient?.flush) {
    try {
      analyticsClient.flush();
    } catch (err) {
      console.error('Failed to flush analytics events:', err);
    }
  }
});

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    return { skipped: true };
  }

  initializeAutoUpdates();

  try {
    const result = await autoUpdater.checkForUpdates();
    return { updateInfo: result?.updateInfo || null };
  } catch (err) {
    console.error('Manual update check failed:', err);
    return { error: err.message || 'Unable to check for updates.' };
  }
});

ipcMain.handle('get-settings', async () => {
  await ensureSettingsLoaded();
  return getRendererSafeSettings();
});

ipcMain.handle('update-settings', async (_event, partialSettings) => {
  await ensureSettingsLoaded();
  const base = settings || getDefaultSettings();
  const next = applySettingsPatch(base, partialSettings);
  settings = next;
  await persistSettings();
  return getRendererSafeSettings();
});

ipcMain.handle('fetch-models', async () => {
  try {
    await ensureSettingsLoaded();
    const effective = getEffectiveSettings();
    const baseUrl = normalizeOllamaEndpoint(effective.ollamaEndpoint);
    const usingChatCompat = Boolean(effective.useOpenAICompatibleEndpoint);
    const endpointPath = usingChatCompat ? '/v1/models' : '/api/tags';
    const res = await fetch(`${baseUrl}${endpointPath}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    if (usingChatCompat) {
      const entries = Array.isArray(data?.data) ? data.data : [];
      return entries
        .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : typeof entry?.name === 'string' ? entry.name.trim() : typeof entry?.model === 'string' ? entry.model.trim() : ''))
        .filter((name) => Boolean(name));
    }

    const models = Array.isArray(data?.models) ? data.models : [];
    return models
      .map((model) => {
        if (typeof model?.name === 'string') {
          return model.name.trim();
        }
        if (typeof model?.model === 'string') {
          return model.model.trim();
        }
        return '';
      })
      .filter((name) => Boolean(name));
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

ipcMain.handle('cancel-ollama', async (_event, { requestId }) => {
  if (!requestId) {
    return { success: false };
  }

  const controller = activeRequests.get(requestId);
  if (controller) {
    controller.abort();
    activeRequests.delete(requestId);
    return { success: true };
  }

  return { success: false };
});

ipcMain.handle('render-markdown', async (_event, text) => {
  try {
    return marked.parse(String(text || ''));
  } catch (err) {
    console.error('Failed to render markdown:', err);
    return String(text || '');
  }
});

ipcMain.handle('export-chat', async (_event, { chatId, format }) => {
  await ensureChatsLoaded();

  const chat = chatsCache.find((item) => item.id === chatId);
  if (!chat) {
    return { error: 'Chat not found' };
  }

  const markdown = buildChatMarkdown(chat);
  const safeTitle = slugify(chat.title || 'conversation');

  if (format === 'markdown') {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('documents'), `${safeTitle}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    await fsPromises.writeFile(filePath, markdown, 'utf8');
    return { success: true, filePath };
  }

  if (format === 'pdf') {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('documents'), `${safeTitle}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    try {
      const pdfBuffer = await generatePdfFromMarkdown(markdown, chat.title || 'Conversation');
      await fsPromises.writeFile(filePath, pdfBuffer);
      return { success: true, filePath };
    } catch (err) {
      console.error('Failed to create PDF:', err);
      return { error: err.message || 'Unable to export PDF' };
    }
  }

  return { error: 'Unsupported format' };
});

ipcMain.handle('delete-all-chats', async () => {
  await ensureChatsLoaded();

  chatsCache = [];
  await persistChats();

  return { success: true };
});

ipcMain.handle('analytics-init', async (_event, rawOptions = {}) => {
  const apiKey = getAnalyticsApiKey();
  if (!apiKey) {
    analyticsClient = null;
    analyticsOptOut = true;
    return { initialized: false, optedOut: true };
  }
  const optOut = Boolean(rawOptions?.optOut);
  return setAnalyticsOptOut(optOut);
});

ipcMain.handle('analytics-set-opt-out', async (_event, optOut) => setAnalyticsOptOut(optOut));

ipcMain.handle('analytics-track', async (_event, payload = {}) => {
  if (!payload || typeof payload !== 'object') {
    return { queued: false };
  }
  const name = payload.name;
  const props = payload.props || {};
  const queued = await trackAnalyticsEventMain(name, props);
  return { queued };
});

ipcMain.handle('set-chat-attachments', async (_event, { chatId, attachments = [] }) => {
  await ensureChatsLoaded();

  if (!chatId) {
    return { success: false, error: 'Chat id is required.' };
  }

  const chat = chatsCache.find((item) => item.id === chatId);
  if (!chat) {
    return { success: false, error: 'Chat not found.' };
  }

  const sanitized = sanitizeStoredAttachments(attachments);
  chat.attachments = sanitized;

  try {
    await persistChats();
  } catch (err) {
    console.error('Failed to persist chat attachments:', err);
    return { success: false, error: err?.message || 'Unable to save attachments.' };
  }

  return { success: true, attachments: sanitized.map((item) => ({ ...item })) };
});

ipcMain.handle('pick-local-files', async (_event, rawOptions = {}) => {
  const options = typeof rawOptions === 'object' && rawOptions !== null ? rawOptions : {};
  const existingCount = Number.isFinite(options.existingCount) ? Number(options.existingCount) : 0;
  const existingBytes = Number.isFinite(options.existingBytes) ? Number(options.existingBytes) : 0;
  const remainingSlots = Math.max(0, MAX_ATTACHMENTS_PER_PROMPT - existingCount);
  const attachmentLimitMessage =
    MAX_ATTACHMENTS_PER_PROMPT === 1
      ? 'Only one file is allowed per prompt. Remove the current attachment before adding another.'
      : `Only ${MAX_ATTACHMENTS_PER_PROMPT} files are allowed per prompt. Remove an attachment before adding more.`;
  const droppedPaths = Array.isArray(options.droppedPaths)
    ? Array.from(
        new Set(
          options.droppedPaths
            .map((value) => {
              if (typeof value === 'string' && value.trim()) {
                return value.trim();
              }
              return '';
            })
            .filter(Boolean)
        )
      )
    : [];

  const limits = {
    maxFiles: MAX_ATTACHMENTS_PER_PROMPT,
    maxPerFileBytes: MAX_ATTACHMENT_BYTES,
    maxTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES,
  };

  if (remainingSlots <= 0) {
    return {
      files: [],
      rejected: [
        {
          reason: attachmentLimitMessage,
        },
      ],
      limits,
    };
  }

  const browserWindow = BrowserWindow.getFocusedWindow() || mainWindow || null;
  const dialogOptions = {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Text files',
        extensions: Array.from(SUPPORTED_ATTACHMENT_EXTENSIONS).map((ext) => ext.slice(1)),
      },
    ],
  };

  const accepted = [];
  const rejected = [];
  let runningBytes = Math.max(0, existingBytes);
  let candidatePaths = [];

  if (droppedPaths.length) {
    candidatePaths = droppedPaths.slice(0, remainingSlots);
    if (droppedPaths.length > remainingSlots) {
      droppedPaths.slice(remainingSlots).forEach((filePath) => {
        rejected.push({
          name: path.basename(filePath),
          reason: attachmentLimitMessage,
        });
      });
    }
  } else {
    const { canceled, filePaths } = await dialog.showOpenDialog(browserWindow, dialogOptions);
    if (canceled || !filePaths || !filePaths.length) {
      return { canceled: true, files: [], rejected, limits };
    }
    candidatePaths = filePaths.slice(0, remainingSlots);
  }

  for (const filePath of candidatePaths) {
    try {
      const stats = await fsPromises.stat(filePath);
      if (!stats.isFile()) {
        rejected.push({
          name: path.basename(filePath),
          reason: 'Only regular files can be attached.',
        });
        continue;
      }

      const originalSize = stats.size;
      if (originalSize === 0) {
        rejected.push({
          name: path.basename(filePath),
          reason: 'File is empty.',
        });
        continue;
      }

      if (originalSize > MAX_ATTACHMENT_BYTES) {
        rejected.push({
          name: path.basename(filePath),
          reason: `File is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
        });
        continue;
      }

      const ext = path.extname(filePath).toLowerCase();
      if (!SUPPORTED_ATTACHMENT_EXTENSIONS.has(ext)) {
        rejected.push({
          name: path.basename(filePath),
          reason: 'Unsupported file type. Only plain text formats are allowed.',
        });
        continue;
      }

      let content;
      try {
        content = await fsPromises.readFile(filePath, 'utf8');
      } catch (err) {
        rejected.push({
          name: path.basename(filePath),
          reason: 'Unable to read the file as UTF-8 text.',
        });
        continue;
      }

      if (isLikelyBinary(content)) {
        rejected.push({
          name: path.basename(filePath),
          reason: 'File appears to be binary. Please convert it to plain text first.',
        });
        continue;
      }

      let sanitizedContent = truncateContentToBytes(content, MAX_ATTACHMENT_BYTES);
      let sanitizedBytes = Buffer.byteLength(sanitizedContent, 'utf8');
      let truncated = sanitizedContent.length < content.length;

      if (runningBytes + sanitizedBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
        const remainingBytes = MAX_ATTACHMENT_TOTAL_BYTES - runningBytes;
        if (remainingBytes <= 0) {
          rejected.push({
            name: path.basename(filePath),
            reason: `Total attachment size would exceed ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}.`,
          });
          continue;
        }

        sanitizedContent = truncateContentToBytes(sanitizedContent, remainingBytes);
        sanitizedBytes = Buffer.byteLength(sanitizedContent, 'utf8');
        truncated = true;
      }

      runningBytes += sanitizedBytes;

      accepted.push({
        id: randomUUID(),
        name: path.basename(filePath),
        size: originalSize,
        bytes: sanitizedBytes,
        displaySize: formatBytes(originalSize),
        truncated,
        content: sanitizedContent,
      });
    } catch (err) {
      rejected.push({
        name: path.basename(filePath),
        reason: err?.message || 'Unable to process file.',
      });
    }
  }

  return { files: accepted, rejected, limits };
});

ipcMain.handle('deep-research', async (event, rawOptions = {}) => {
  await ensureSettingsLoaded();
  await ensureChatsLoaded();
  const options = typeof rawOptions === 'object' && rawOptions !== null ? rawOptions : {};
  const rawTopic = typeof options.topic === 'string' ? options.topic.trim() : '';
  let topic = rawTopic;

  if (!topic) {
    return { error: 'A topic or question is required for deep research.' };
  }

  const chatId = options.chatId || null;
  const iterations = clampDeepResearchIterations(options.iterations);
  const requestId = options.requestId || randomUUID();
  const resultLimit = clampSearchLimit(
    options.resultLimit !== undefined ? Number(options.resultLimit) : DEFAULT_SETTINGS.searchResultLimit
  );
  let primaryGoal =
    typeof options.initialGoal === 'string' && options.initialGoal.trim() ? options.initialGoal.trim() : '';
  if (chatId) {
    const ownedChat = chatsCache.find((item) => item.id === chatId);
    const resolvedGoal = resolveChatInitialGoal(ownedChat);
    if (resolvedGoal) {
      primaryGoal = resolvedGoal;
    }
  }
  const combinedGoal = buildPrimaryAlignedTopic(primaryGoal, rawTopic);
  if (combinedGoal) {
    topic = combinedGoal;
  }

  const seedSource = Array.isArray(options.initialQueries)
    ? options.initialQueries
    : Array.isArray(options.additionalQueries)
    ? options.additionalQueries
    : [];
  const seedQueries = buildInitialResearchQueries(topic, seedSource);
  if (!seedQueries.length) {
    seedQueries.push(topic);
  }
  const usedQueryHashes = new Set(seedQueries.map((value) => value.toLowerCase()));
  const modelForResearch =
    typeof options.model === 'string' && options.model.trim() ? options.model.trim() : '';
  const enqueueQuery = (candidate) => {
    if (!candidate || seedQueries.length >= DEEP_RESEARCH_MAX_QUERY_POOL) {
      return false;
    }
    const trimmedCandidate = String(candidate).trim();
    if (!trimmedCandidate) {
      return false;
    }
    const normalized = trimmedCandidate.toLowerCase();
    if (usedQueryHashes.has(normalized)) {
      return false;
    }
    seedQueries.push(trimmedCandidate);
    usedQueryHashes.add(normalized);
    return true;
  };

  const sendProgress = (payload) => {
    if (!event?.sender || !payload) {
      return;
    }
    try {
      event.sender.send('deep-research-progress', {
        requestId,
        chatId,
        topic,
        primaryGoal,
        ...payload,
      });
    } catch (err) {
      console.error('Failed to send deep research progress:', err);
    }
  };

  try {
    const online = await hasNetworkConnectivity();
    if (!online) {
      const offlineError = 'No network connection detected. Unable to run deep research.';
      sendProgress({ stage: 'error', message: offlineError });
      return { error: offlineError };
    }

    sendProgress({
      stage: 'planning',
      totalIterations: iterations,
      nextQueries: seedQueries.slice(0, 3),
      message: `Preparing ${iterations} passes of deep research.`,
    });

    const timeline = [];
    const seenUrls = new Set();
    const researchMemory = [];
    let queryCursor = 0;
    let satisfied = false;
    let finalDraftAnswer = '';

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const query =
        seedQueries[queryCursor] || seedQueries[seedQueries.length - 1] || topic;
      const iterationLabel = { iteration, totalIterations: iterations, query };

      sendProgress({
        stage: 'iteration-start',
        message: `Pass ${iteration} – searching for fresh coverage…`,
        ...iterationLabel,
      });

      let searchResult = { entries: [] };
      try {
        searchResult = await performWebSearch([query], {
          limit: resultLimit,
          timeoutMs: 7000,
          pageTimeoutMs: 5000,
        });
      } catch (err) {
        console.error('Deep research search failed:', err);
        const errorMessage = err?.message || 'Search failed.';
        timeline.push({
          iteration,
          query,
          findings: [],
          message: errorMessage,
          review: '',
          error: errorMessage,
        });
        sendProgress({
          stage: 'iteration-error',
          message: errorMessage,
          ...iterationLabel,
        });
        queryCursor += 1;
        continue;
      }

      const normalizedEntries = Array.isArray(searchResult.entries) ? searchResult.entries : [];
      const freshEntries = filterFreshEntries(
        normalizedEntries,
        seenUrls,
        DEEP_RESEARCH_FINDINGS_PER_PASS
      );
      const findings = summarizeDeepResearchEntries(freshEntries);
      const iterationMessage = findings.length
        ? `Pass ${iteration} captured ${findings.length} new source${findings.length === 1 ? '' : 's'}.`
        : `Pass ${iteration} produced no novel sources – refining follow-up queries.`;

      timeline.push({
        iteration,
        query,
        findings,
        message: iterationMessage,
        review: '',
      });
      const timelineEntry = timeline[timeline.length - 1];

      sendProgress({
        stage: 'iteration-review',
        findings,
        message: iterationMessage,
        ...iterationLabel,
      });

      const followUps = deriveFollowUpQueries(freshEntries, topic, seedQueries);
      if (followUps.length) {
        followUps.forEach((nextQuery) => enqueueQuery(nextQuery));
      }

      const iterationMemory = freshEntries.map((entry) => ({
        title: entry.title || '',
        summary: entry.summary || entry.snippet || '',
        snippet: entry.snippet || entry.summary || '',
        url: entry.url || '',
      }));
      if (iterationMemory.length) {
        researchMemory.push(...iterationMemory);
      }

      const reflection = buildResearchReflection(topic, researchMemory, seedQueries);
      if (reflection.nextQueries?.length) {
        reflection.nextQueries.forEach((nextQuery) => enqueueQuery(nextQuery));
      }
      if (modelForResearch && timeline.length) {
        try {
          const modelQueries = await generateQuerySuggestions({
            model: modelForResearch,
            topic,
            timeline,
            existingQueries: seedQueries,
            maxSuggestions: 2,
          });
          if (Array.isArray(modelQueries) && modelQueries.length) {
            modelQueries.forEach((candidate) => enqueueQuery(candidate));
            sendProgress({
              stage: 'iteration-reflection',
              message: `Model suggested new queries: ${modelQueries.join(', ')}`,
              suggestions: modelQueries,
              ...iterationLabel,
            });
          }
        } catch (suggestErr) {
          console.error('Model query suggestion failed:', suggestErr);
        }
      }
      if (reflection.summary) {
        if (timelineEntry) {
          timelineEntry.review = reflection.summary;
        }
        sendProgress({
          stage: 'iteration-reflection',
          message: reflection.summary,
          review: reflection.summary,
          suggestions: reflection.nextQueries,
          ...iterationLabel,
        });
      }

      if (modelForResearch && findings.length) {
        sendProgress({
          stage: 'model-draft',
          message: `Drafting answer from pass ${iteration} findings…`,
          ...iterationLabel,
        });

        try {
          const draft = await synthesizeDeepResearchDraft({
            model: modelForResearch,
            topic,
            findings: freshEntries,
            priorDraft: finalDraftAnswer,
            reflection: timelineEntry?.review || '',
          });

          if (draft) {
            timelineEntry.answer = draft;
            finalDraftAnswer = draft;
            sendProgress({
              stage: 'model-draft',
              message: `Draft ready from pass ${iteration}.`,
              answer: draft,
              ...iterationLabel,
            });

            sendProgress({
              stage: 'model-eval',
              message: `Reviewing draft from pass ${iteration}…`,
              answer: draft,
              ...iterationLabel,
            });

            const evaluation = await evaluateDeepResearchDraft({
              model: modelForResearch,
              topic,
              draft,
            });

            if (evaluation) {
              timelineEntry.verdict = evaluation.verdict;
              timelineEntry.reviewNotes = evaluation.critique || '';

              sendProgress({
                stage: 'model-eval',
                message:
                  evaluation.critique || (evaluation.accepted ? 'Draft approved.' : 'Needs refinement.'),
                verdict: evaluation.verdict,
                answer: draft,
                reviewNotes: evaluation.critique,
                ...iterationLabel,
              });

              if (evaluation.accepted) {
                satisfied = true;
                break;
              }
            }
          }
        } catch (draftErr) {
          console.error('Deep research drafting failed:', draftErr);
          sendProgress({
            stage: 'model-error',
            message: draftErr?.message || 'Unable to synthesize an answer from the findings.',
            ...iterationLabel,
          });
        }
      }

      queryCursor += 1;
      if (satisfied) {
        break;
      }
    }

    if (!finalDraftAnswer && timeline.length) {
      const lastWithAnswer = [...timeline].reverse().find((entry) => entry?.answer);
      if (lastWithAnswer?.answer) {
        finalDraftAnswer = lastWithAnswer.answer;
      }
    }

    const summaryPayload = buildDeepResearchSummary(topic, timeline, finalDraftAnswer);

    sendProgress({
      stage: 'complete',
      summary: summaryPayload.summary,
      sources: summaryPayload.sources,
      iterations: timeline.length,
      answer: summaryPayload.answer,
    });

    return {
      requestId,
      topic,
      iterations: timeline.length,
      summary: summaryPayload.summary,
      sources: summaryPayload.sources,
      answer: summaryPayload.answer,
      timeline,
    };
  } catch (err) {
    console.error('Deep research failed:', err);
    const message = err?.message || 'Deep research failed.';
    sendProgress({ stage: 'error', message });
    return { error: message };
  }
});

ipcMain.handle('ask-ollama', async (
  event,
  { chatId, model, prompt, requestId, userLinks = [], attachments = [], deepResearch = null }
) => {
  if (!prompt?.trim()) {
    return { chatId, error: 'Prompt is empty' };
  }

  await ensureChatsLoaded();
  await ensureSettingsLoaded();

  const controller = new AbortController();
  if (requestId) {
    activeRequests.set(requestId, controller);
  }

  const normalizedUserLinks = Array.from(new Set((userLinks || []).map((link) => String(link).trim()).filter(Boolean)));

  let chat = chatId ? chatsCache.find((item) => item.id === chatId) : null;
  if (!chat) {
    chat = createChatRecord(model || null);
    upsertChat(chat);
    await persistChats();
    chatId = chat.id;
  }

  chat.model = model;

  if (!chat.initialUserPrompt) {
    const firstUserMessage = chat.messages.find((message) => message.role === 'user' && message.content);
    chat.initialUserPrompt = firstUserMessage?.content || prompt;
  }

  const now = new Date().toISOString();
  const historyMessages = chat.messages.map(({ role, content }) => ({ role, content }));
  const initialGoal = chat.initialUserPrompt ? String(chat.initialUserPrompt).trim() : '';
  const assistantTurns = countAssistantTurns(chat);
  const webContextTurns = countWebContextTurns(chat);
  const shouldLimitWebContext = assistantTurns >= 2;
  const goalAligned = isPromptAlignedWithGoal(initialGoal, prompt);

  const effectiveSettings = getEffectiveSettings();
  const conversationAnalysis = analyzeConversationGrounding(chat, prompt);
  const searchPrompt = buildSearchPrompt(chat, prompt);
  const focusTerms = deriveFollowUpFocus(chat, prompt);
  const baseHasRecentContext = hasRecentWebContext(chat);
  const modelBaseUrl = normalizeOllamaEndpoint(effectiveSettings.ollamaEndpoint);
  const usingChatCompletionsApi = Boolean(effectiveSettings.useOpenAICompatibleEndpoint);
  const chatEndpointPath = usingChatCompletionsApi ? '/v1/chat/completions' : '/api/chat';
  const buildModelApiUrl = (suffix) => {
    const cleanPath = suffix && suffix.startsWith('/') ? suffix : `/${suffix || ''}`;
    return `${modelBaseUrl}${cleanPath}`;
  };
  const searchPlan = createSearchPlan(searchPrompt, effectiveSettings, prompt, {
    hasRecentContext: baseHasRecentContext,
    focusTerms,
    initialGoal,
    conversationConfidence: conversationAnalysis.confidence,
    conversationCoverage: conversationAnalysis.coverageRatio,
    missingTerms: conversationAnalysis.missingTerms,
    promptTokenCount: conversationAnalysis.promptTokens.length,
    longRunning: conversationAnalysis.longRunning,
    assistantTurns,
    webContextTurns,
    goalAligned,
  });

  if (!Array.isArray(searchPlan.queries) || !searchPlan.queries.length) {
    const fallbackQuery = searchPrompt || prompt;
    if (fallbackQuery && fallbackQuery.trim()) {
      searchPlan.queries = [fallbackQuery.trim()];
    }
  }
  searchPlan.disabled = false;
  searchPlan.shouldSearch = true;
  if (!searchPlan.message) {
    searchPlan.message = 'Gathering fresh web context for this request.';
  }

  const conversationFirst =
    !searchPlan.shouldSearch && !searchPlan.disabled && conversationAnalysis.confidence >= 0.65;

  let contextResult = {
    text: '',
    entries: [],
    queries: [],
    retrievedAt: null,
    userLinks: [],
    deepResearch: null,
  };
  let contextMessage = '';
  let contextQueries = [];
  let userLinksForContext = [...normalizedUserLinks];
  const attachmentsResult = sanitizeAttachmentsPayload(attachments);
  const uploadedFiles = attachmentsResult.entries;
  let attachmentsBlock = attachmentsResult.block;
  const tRequestStart = Date.now();
  let tFirstToken = null;
  let tStreamEnd = null;
  let totalChars = 0;
  let totalTokens = 0;

  let allowSearch = !searchPlan.disabled && searchPlan.queries.length > 0;
  let skippedForOffline = false;

  const normalizedDeepResearch = normalizeDeepResearchMeta(deepResearch);
  const deepResearchBlock = buildDeepResearchContextBlock(normalizedDeepResearch);
  const usedDeepResearch = Boolean(deepResearchBlock);
  if (usedDeepResearch) {
    allowSearch = false;
    contextResult.deepResearch = normalizedDeepResearch;
  }

  if (allowSearch) {
    const online = await hasNetworkConnectivity();
    if (!online) {
      allowSearch = false;
      skippedForOffline = true;
    }
  }

  if (allowSearch) {
    event.sender.send('ollama-thinking', {
      chatId,
      stage: 'search-plan',
      message: searchPlan.message,
      queries: searchPlan.queries,
    });

    contextResult = await performWebSearch(searchPlan.queries, {
      limit: effectiveSettings.searchResultLimit,
      timeoutMs: 6500,
      pageTimeoutMs: 5000,
    });

    if (contextResult.entries.length) {
      if (shouldLimitWebContext) {
        contextMessage = normalizedUserLinks.length
          ? 'Selective refresh of web context plus user-provided links to refine the original goal.'
          : 'Selective refresh of web context to refine the original goal.';
      } else {
        contextMessage = normalizedUserLinks.length
          ? 'Context gathered from the web along with user-provided links.'
          : 'Context gathered from the web.';
      }
    } else if (normalizedUserLinks.length) {
      contextMessage = 'No relevant web results found. Using user-provided links.';
    } else {
      contextMessage = 'No relevant web results found.';
    }
    contextQueries = contextResult.queries;
  } else {
    if (usedDeepResearch) {
      contextMessage = 'Using deep research findings gathered earlier.';
    } else if (!goalAligned) {
      contextMessage =
        'Staying focused on the original objective from the first user request. Invite the user to start a new chat for unrelated tasks.';
    } else if (skippedForOffline) {
      contextMessage = normalizedUserLinks.length
        ? 'No network connection detected. Using user-provided links.'
        : 'No network connection detected. Responding with model knowledge.';
    } else if (normalizedUserLinks.length) {
      contextMessage = 'Using user-provided links.';
    } else if (searchPlan.disabled) {
      contextMessage = searchPlan.message || 'Web search disabled in settings.';
    } else if (conversationFirst) {
      contextMessage = 'Relying on conversation memory from earlier responses.';
    } else if (shouldLimitWebContext && baseHasRecentContext) {
      contextMessage = 'Reusing earlier web findings instead of refreshing search results.';
    } else {
      contextMessage = 'Responding with model knowledge (no web search).';
    }
    contextQueries = [];
    userLinksForContext = normalizedUserLinks;
    contextResult.queries = [];
    contextResult.retrievedAt = null;
  }

  const contextSections = [];
  if (initialGoal) {
    const goalLines = ['Primary goal:', initialGoal];
    if (!goalAligned) {
      goalLines.push(
        '',
        'Reminder: The latest request may be unrelated. Reconfirm this goal before assisting with other tasks.'
      );
    }
    contextSections.push(goalLines.join('\n'));
  }

  if (usedDeepResearch && deepResearchBlock) {
    contextSections.push(deepResearchBlock);
  }

  let preparedContextText = '';
  if (contextResult.text && contextResult.text.trim()) {
    preparedContextText = shouldLimitWebContext
      ? limitContextForFollowUp(contextResult.text)
      : contextResult.text.trim();
    if (preparedContextText) {
      contextSections.push(preparedContextText);
    }
    if (
      shouldLimitWebContext &&
      Array.isArray(contextResult.entries) &&
      contextResult.entries.length > 2
    ) {
      contextResult.entries = contextResult.entries.slice(0, 2);
    }
    if (shouldLimitWebContext && Array.isArray(contextResult.queries) && contextResult.queries.length > 2) {
      contextResult.queries = contextResult.queries.slice(0, 2);
      contextQueries = contextResult.queries;
    }
  }

  if (userLinksForContext.length) {
    const linksBlock = ['User-provided links:', ...userLinksForContext.map((link) => `• ${link}`)].join('\n');
    contextSections.push(linksBlock);
  }

  if (attachmentsBlock && attachmentsBlock.trim()) {
    contextSections.push(attachmentsBlock.trim());
  }

  const finalContext = contextSections.join('\n\n').trim();
  contextResult.text = finalContext;
  contextResult.userLinks = userLinksForContext;
  contextResult.attachments = attachmentsResult.summary;

  if (!contextMessage) {
    if (!goalAligned) {
      contextMessage = 'Keeping the conversation focused on the original goal from the first message.';
    } else if (shouldLimitWebContext && baseHasRecentContext) {
      contextMessage = 'Reusing earlier web findings to stay on task.';
    } else if (userLinksForContext.length) {
      contextMessage = 'Using user-provided links.';
    } else if (conversationFirst) {
      contextMessage = 'Relying on conversation memory from earlier responses.';
    } else {
      contextMessage = 'Responding with model knowledge (no web search).';
    }
  }

  if (usedDeepResearch) {
    contextMessage = contextMessage
      ? `${contextMessage} Deep research findings gathered before responding have been included.`
      : 'Using deep research findings gathered before responding.';
  }

  if (uploadedFiles.length) {
    const lowercaseMessage = contextMessage.toLowerCase();
    if (lowercaseMessage.includes('no network')) {
      contextMessage = `${contextMessage} Uploaded files will be included.`;
    } else if (
      contextMessage.includes('web') &&
      (lowercaseMessage.includes('context gathered') || lowercaseMessage.includes('web context'))
    ) {
      contextMessage = 'Context gathered from the web and uploaded files.';
    } else if (lowercaseMessage.includes('links')) {
      contextMessage = 'Using user-provided links and uploaded files.';
    } else {
      contextMessage = 'Using uploaded files provided by the user.';
    }
  }

  event.sender.send('ollama-thinking', {
    chatId,
    stage: 'context',
    message: contextMessage,
    context: contextResult.text,
    queries: contextQueries,
    userLinks: userLinksForContext,
    retrievedAt: contextResult.retrievedAt,
    attachments: contextResult.attachments,
    attachmentWarnings: attachmentsResult.warnings,
    deepResearch: contextResult.deepResearch,
    goalAligned,
    primaryGoal: initialGoal || undefined,
    limitedWebContext: shouldLimitWebContext,
  });

  const baseSystemMessages = [{ role: 'system', content: buildBaseSystemPrompt() }];
  if (initialGoal) {
    baseSystemMessages.push({
      role: 'system',
      content: buildGoalInstruction(initialGoal, prompt),
    });
    baseSystemMessages.push({
      role: 'system',
      content: buildGoalGuardrailInstruction(initialGoal),
    });
    if (!goalAligned) {
      baseSystemMessages.push({
        role: 'system',
        content:
          'The latest user message appears to deviate from the primary goal. Before helping, remind them of the original objective and suggest starting a new chat for other work.',
      });
    }
  }

  const contextSystemMessages = [];
  const refreshContextSystemMessages = () => {
    contextSystemMessages.length = 0;
    if (contextResult.text) {
      contextSystemMessages.push({
        role: 'system',
        content: buildContextInstruction({
          context: contextResult.text,
          retrievedAt: contextResult.retrievedAt,
          genericFresh: searchPlan.genericFresh,
        }),
      });
    }
  };
  refreshContextSystemMessages();

  const buildMessagesForModel = () => [
    ...baseSystemMessages,
    ...historyMessages,
    ...contextSystemMessages,
    { role: 'user', content: prompt },
  ];

  const maxSearchRetries = 2;
  let searchRetries = 0;
  let assistantContent = '';
  let manualResponse = '';
  let reasoningTranscript = '';
  let reasoningSnapshot = '';
  let reasoningDetected = false;
  let timingInfo = null;
  let generationStageAnnounced = false;
  let modelStageAnnounced = false;

  const announceModelLoadingStage = () => {
    modelStageAnnounced = true;
    const loadingMessage =
      model && String(model).trim() ? `Loading ${model}…` : 'Loading model…';
    event.sender.send('ollama-thinking', {
      chatId,
      stage: 'model-loading',
      message: loadingMessage,
    });
  };

  const announceGenerationStage = (overrideMessage) => {
    if (generationStageAnnounced) {
      return;
    }
    generationStageAnnounced = true;
    event.sender.send('ollama-thinking', {
      chatId,
      stage: 'generating',
      message: overrideMessage || 'Generating response…',
    });
  };

  const noteFirstToken = (timestamp) => {
    if (!tFirstToken) {
      if (Number.isFinite(timestamp)) {
        tFirstToken = timestamp;
      } else {
        tFirstToken = Date.now();
      }
      announceGenerationStage();
    }
  };

  const registerReasoningDelta = (payload) => {
    const flattened = flattenReasoningPayload(payload);
    if (!flattened) {
      return '';
    }

    const normalized = typeof flattened === 'string' ? flattened : String(flattened);
    const trimmedNormalized = normalized.trim();
    if (!trimmedNormalized) {
      return '';
    }

    reasoningDetected = true;

    let candidate = trimmedNormalized;
    if (reasoningSnapshot && trimmedNormalized.startsWith(reasoningSnapshot)) {
      candidate = trimmedNormalized.slice(reasoningSnapshot.length);
    } else if (reasoningSnapshot) {
      const priorIndex = trimmedNormalized.indexOf(reasoningSnapshot);
      if (priorIndex !== -1) {
        candidate = trimmedNormalized.slice(priorIndex + reasoningSnapshot.length);
      }
    }

    reasoningSnapshot = trimmedNormalized;

    let delta = candidate.trimStart();
    if (!delta) {
      return '';
    }

    if (reasoningTranscript.endsWith(delta)) {
      return '';
    }

    const needsSeparator =
      reasoningTranscript && !reasoningTranscript.endsWith('\n') && !delta.startsWith('\n');

    reasoningTranscript += needsSeparator ? `\n${delta}` : delta;
    return delta;
  };

  const streamOnce = async (currentController) => {
    const messagesForModel = buildMessagesForModel();
    let assistantContentLocal = '';
    let directiveBuffer = '';
    let checkingDirective = true;
    let searchDirectiveQuery = null;
    let abortedForDirective = false;
    let streamCompleted = false;

    const response = await fetch(buildModelApiUrl(chatEndpointPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messagesForModel,
        stream: true,
      }),
      signal: currentController.signal,
    });

    if (!response.ok) {
      const sourceLabel = usingChatCompletionsApi ? 'ChatGPT-compatible API' : 'Ollama API';
      throw new Error(`${sourceLabel} error: HTTP ${response.status}`);
    }

    let buffer = '';
    const stream = response.body;
    const emitUpdate = ({ delta = '', done = false, force = false }) => {
      if (!force && !delta && !done && !reasoningDetected) {
        return;
      }
      event.sender.send('ollama-stream', {
        chatId,
        delta,
        full: assistantContentLocal,
        done,
        reasoning: reasoningTranscript || undefined,
      });
    };

    const flushDirectiveBuffer = () => {
      if (!directiveBuffer) {
        return;
      }
      assistantContentLocal += directiveBuffer;
      noteFirstToken();
      if (directiveBuffer) {
        totalChars += directiveBuffer.length;
        totalTokens += estimateTokenCount(directiveBuffer);
      }
      event.sender.send('ollama-stream', {
        chatId,
        delta: directiveBuffer,
        full: assistantContentLocal,
        done: false,
      });
      directiveBuffer = '';
    };

    const processParsed = (parsed) => {
      const reasoningPayload = parsed?.message?.reasoning ?? parsed?.reasoning ?? null;
      const reasoningDelta = registerReasoningDelta(reasoningPayload);
      const primaryChoice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;

      let chunkText = '';
      if (typeof parsed?.message?.content === 'string') {
        chunkText = parsed.message.content;
      } else if (typeof parsed?.response === 'string') {
        chunkText = parsed.response;
      } else if (usingChatCompletionsApi) {
        if (typeof primaryChoice?.delta?.content === 'string') {
          chunkText = primaryChoice.delta.content;
        } else if (typeof primaryChoice?.message?.content === 'string') {
          chunkText = primaryChoice.message.content;
        }
      }

      if (chunkText) {
        if (checkingDirective) {
          directiveBuffer += chunkText;
          const trimmed = directiveBuffer.trim();
          const directiveCandidate = trimmed.includes(']]') ? extractSearchDirective(trimmed) : null;

          if (directiveCandidate) {
            searchDirectiveQuery = directiveCandidate;
            abortedForDirective = true;
            currentController.abort();
            return;
          }

          const firstChar = trimmed.charAt(0);
          if ((firstChar && firstChar !== '[') || trimmed.includes(']]')) {
            checkingDirective = false;
            flushDirectiveBuffer();
          }
          return;
        }
        const directivePattern = /\[\[search:\s*([\s\S]+?)\s*\]\]/i;
        const directiveMatch = chunkText.match(directivePattern);

        if (directiveMatch) {
          const fullDirective = directiveMatch[0];
          const directiveIndex = chunkText.indexOf(fullDirective);
          const beforeDirective = chunkText.slice(0, directiveIndex);
          const afterDirective = chunkText.slice(directiveIndex + fullDirective.length);

          if (beforeDirective) {
            assistantContentLocal += beforeDirective;
            noteFirstToken();
            totalChars += beforeDirective.length;
            totalTokens += estimateTokenCount(beforeDirective);
            emitUpdate({ delta: beforeDirective, done: false, force: true });
          }

          if (afterDirective.trim()) {
            assistantContentLocal += afterDirective;
            noteFirstToken();
            totalChars += afterDirective.length;
            totalTokens += estimateTokenCount(afterDirective);
            emitUpdate({ delta: afterDirective, done: false, force: true });
          }

          const trimmedQuery = directiveMatch[1]?.trim();
          if (trimmedQuery) {
            searchDirectiveQuery = trimmedQuery;
            abortedForDirective = true;
            currentController.abort();
            return;
          }
        } else {
          assistantContentLocal += chunkText;
          noteFirstToken();
          if (chunkText) {
            totalChars += chunkText.length;
            totalTokens += estimateTokenCount(chunkText);
          }
          emitUpdate({ delta: chunkText, done: false, force: true });
        }
      } else if (reasoningDelta) {
        emitUpdate({ delta: '', done: false, force: true });
      }

      const finishReasonDetected =
        Boolean(parsed?.done) ||
        (Array.isArray(parsed?.choices) && parsed.choices.some((choice) => Boolean(choice?.finish_reason)));

      if (!streamCompleted && finishReasonDetected) {
        streamCompleted = true;
        flushDirectiveBuffer();
        tStreamEnd = Date.now();
        emitUpdate({ delta: '', done: true, force: true });
      }
    };

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let payload = trimmed;
      if (usingChatCompletionsApi) {
        if (payload.startsWith('data:')) {
          const dataPayload = payload.slice(5).trim();
          if (!dataPayload || dataPayload === '[DONE]') {
            processParsed({ done: true });
            return;
          }
          payload = dataPayload;
        } else if (payload === '[DONE]') {
          processParsed({ done: true });
          return;
        }
      }
      try {
        const parsed = JSON.parse(payload);
        processParsed(parsed);
      } catch (err) {
        console.error('Failed to parse stream chunk:', err);
      }
    };

    try {
      for await (const chunk of stream) {
        buffer += chunk.toString();
        let newlineIndex = buffer.indexOf('\n');

        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          processLine(line);
          if (searchDirectiveQuery) {
            break;
          }
          newlineIndex = buffer.indexOf('\n');
        }

        if (searchDirectiveQuery) {
          break;
        }
      }
    } catch (err) {
      if (abortedForDirective && err.name === 'AbortError') {
        return { type: 'directive', query: searchDirectiveQuery };
      }
      throw err;
    }

    if (!searchDirectiveQuery && buffer.trim()) {
      processLine(buffer);
    }

    if (searchDirectiveQuery) {
      return { type: 'directive', query: searchDirectiveQuery };
    }

    if (checkingDirective && directiveBuffer) {
      checkingDirective = false;
      flushDirectiveBuffer();
    }

    if (!tStreamEnd) {
      tStreamEnd = Date.now();
    }

    return { type: 'content', content: assistantContentLocal };
  };

  try {
    while (true) {
      if (!modelStageAnnounced) {
        announceModelLoadingStage();
      }
      const result = await streamOnce(controller);
      if (result.type === 'directive') {
        const query = result.query?.trim();
        if (!query) {
          manualResponse = 'I was unable to determine the search terms needed. Please provide more detail.';
          assistantContent = manualResponse;
          break;
        }

        if (searchRetries >= maxSearchRetries) {
          manualResponse =
            'I tried to fetch additional web context but reached the search limit. Please share any references you have.';
          assistantContent = manualResponse;
          break;
        }

        searchRetries += 1;

        const truncatedQuery = truncateForSearch(query, 140);
        event.sender.send('ollama-thinking', {
          chatId,
          stage: 'search-plan',
          message: `Assistant requested web search for "${truncatedQuery}".`,
          queries: [query],
        });

        const assistantHasNetwork = await hasNetworkConnectivity();
        if (!assistantHasNetwork) {
          const offlineMessage = 'Assistant requested web context, but no network connection is available.';
          contextMessage = offlineMessage;
          event.sender.send('ollama-thinking', {
            chatId,
            stage: 'context',
            message: offlineMessage,
            context: contextResult.text,
            queries: contextResult.queries,
            userLinks: userLinksForContext,
            retrievedAt: contextResult.retrievedAt,
          });

          controller = new AbortController();
          if (requestId) {
            activeRequests.set(requestId, controller);
          }
          modelStageAnnounced = false;
          generationStageAnnounced = false;
          continue;
        }

        const supplemental = await performWebSearch([query], {
          limit: effectiveSettings.searchResultLimit,
          timeoutMs: 6500,
          pageTimeoutMs: 5000,
        });

        const supplementalText = supplemental.entries.length
          ? formatSearchEntries(supplemental.entries, supplemental.retrievedAt, supplemental.queries)
          : '';

        contextResult.entries = [...(contextResult.entries || []), ...supplemental.entries];
        contextResult.queries = Array.from(new Set([...(contextResult.queries || []), ...supplemental.queries]));
        contextResult.retrievedAt = supplemental.retrievedAt || contextResult.retrievedAt;

        const descriptor = supplementalText
          ? `Assistant-requested search for "${query}".\n${supplementalText}`
          : `Assistant-requested search for "${query}".\nNo relevant web results found.`;

        contextResult.text = appendContextSection(contextResult.text, descriptor);
        refreshContextSystemMessages();
        contextMessage = supplemental.entries.length
          ? 'Assistant requested supplemental web context.'
          : 'Assistant requested web context, but nothing relevant was found.';

        event.sender.send('ollama-thinking', {
          chatId,
          stage: 'context',
          message: contextMessage,
          context: contextResult.text,
          queries: contextResult.queries,
          userLinks: userLinksForContext,
          retrievedAt: contextResult.retrievedAt,
        });

        controller = new AbortController();
        if (requestId) {
          activeRequests.set(requestId, controller);
        }
        modelStageAnnounced = false;
        generationStageAnnounced = false;
        continue;
      }

      assistantContent = result.content;
      break;
    }
  } catch (err) {
    if (requestId) {
      activeRequests.delete(requestId);
    }

    if (err.name === 'AbortError') {
      event.sender.send('ollama-stream', {
        chatId,
        aborted: true,
        done: true,
      });
      return { chatId, aborted: true };
    }

    console.error('Error querying model endpoint:', err);
    event.sender.send('ollama-stream', {
      chatId,
      error: err.message || 'Unknown error',
      done: true,
    });
    return { chatId, error: 'Error: Unable to get response' };
  }

  if (!tStreamEnd) {
    tStreamEnd = Date.now();
  }

  if (!generationStageAnnounced) {
    announceGenerationStage();
  }

  if (assistantContent && assistantContent.trim()) {
    noteFirstToken(tStreamEnd);
  }
  if (totalTokens === 0 && assistantContent && assistantContent.trim()) {
    totalTokens = estimateTokenCount(assistantContent);
  }
  if (totalChars === 0 && assistantContent) {
    totalChars = assistantContent.length;
  }

  const totalMs = Math.max(0, tStreamEnd - tRequestStart);
  const loadMs = tFirstToken ? Math.max(0, tFirstToken - tRequestStart) : totalMs;
  const generationMs = tFirstToken ? Math.max(0, tStreamEnd - tFirstToken) : 0;
  const tokensPerSecond = generationMs > 0 && totalTokens > 0
    ? Number((totalTokens / (generationMs / 1000)).toFixed(2))
    : null;

  timingInfo = {
    startedAt: new Date(tRequestStart).toISOString(),
    completedAt: new Date(tStreamEnd).toISOString(),
    totalMs,
    loadMs,
    generationMs,
    firstTokenMs: loadMs,
    streamMs: generationMs,
    tokens: totalTokens,
    chars: totalChars,
    tokensPerSecond,
  };

  event.sender.send('ollama-stream', {
    chatId,
    timing: timingInfo,
  });

  if (manualResponse) {
    event.sender.send('ollama-stream', {
      chatId,
      delta: manualResponse,
      full: manualResponse,
      done: false,
      reasoning: reasoningTranscript || undefined,
      timing: timingInfo,
    });
    event.sender.send('ollama-stream', {
      chatId,
      delta: '',
      full: manualResponse,
      done: true,
      reasoning: reasoningTranscript || undefined,
      timing: timingInfo,
    });
  }

  if (requestId) {
    activeRequests.delete(requestId);
  }

  const trimmedAnswer = assistantContent.trim();
  if (Array.isArray(contextResult.queries) && contextResult.queries.length) {
    contextQueries = contextResult.queries;
  } else if (!contextQueries.length) {
    contextQueries = searchPlan.disabled && Array.isArray(searchPlan.queries) ? searchPlan.queries : [];
  }
  const contextRetrievedAt = contextResult.retrievedAt || null;
  const usedWebSearch = Array.isArray(contextResult.entries) && contextResult.entries.length > 0;
  const reusedConversationMemory =
    !usedWebSearch && (conversationFirst || conversationAnalysis.confidence >= 0.65);
  const finalReasoning = reasoningTranscript.trim();

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
        usedWebSearch,
        reusedConversationMemory,
        conversationConfidence: conversationAnalysis.confidence,
        conversationCoverage: conversationAnalysis.coverageRatio,
        goalAligned,
        primaryGoal: initialGoal || undefined,
        assistantTurnsBefore: assistantTurns,
        webContextTurnsBefore: webContextTurns,
        limitedWebContext: shouldLimitWebContext,
        userLinks: contextResult.userLinks,
        assistantSearchRequests: searchRetries,
        reasoning: finalReasoning,
        supportsReasoning: reasoningDetected,
        attachments: contextResult.attachments,
        deepResearch: contextResult.deepResearch,
        timing: timingInfo,
      },
    }
  );

  chat.conversationDigest = buildConversationDigest(chat);

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
    userLinks: contextResult.userLinks,
    reusedConversationMemory,
    primaryGoal: initialGoal || undefined,
    goalAligned,
    limitedWebContext: shouldLimitWebContext,
    attachments: contextResult.attachments,
    attachmentWarnings: attachmentsResult.warnings,
    deepResearch: contextResult.deepResearch,
    timing: timingInfo,
    reasoning: finalReasoning,
    usedWebSearch,
    assistantSearchRequests: searchRetries,
    supportsReasoning: reasoningDetected,
  };
});

function initializeAutoUpdates() {
  if (autoUpdateInitialized || !app.isPackaged) {
    return;
  }

  autoUpdateInitialized = true;
  autoUpdater.autoDownload = true;

  autoUpdater.on('update-available', (info) => {
    sendAutoUpdateStatus('update-available', {
      version: info?.version,
      releaseDate: info?.releaseDate,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendAutoUpdateProgress({
      percent: progress?.percent,
      transferred: progress?.transferred,
      total: progress?.total,
      bytesPerSecond: progress?.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', () => {
    sendAutoUpdateStatus('update-downloaded');

    if (!mainWindow || mainWindow.isDestroyed()) {
      autoUpdater.quitAndInstall();
      return;
    }

    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['Install and Restart', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update Ready',
        message: 'A new version has been downloaded.',
        detail: 'Restart now to apply the latest update?',
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      })
      .catch((err) => {
        console.error('Failed to show update dialog:', err);
      });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto update error:', err);
    sendAutoUpdateStatus('error', { message: err?.message || 'Unknown error' });
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('Auto update check failed:', err);
  });
}

function sendAutoUpdateStatus(status, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('auto-update-status', { status, ...payload });
}

function sendAutoUpdateProgress(progress = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('auto-update-progress', progress);
}

function createChatRecord(model = null) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: 'New Chat',
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
    initialUserPrompt: '',
    attachments: [],
  };
}

function getDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

async function ensureSettingsLoaded() {
  if (settingsLoaded) {
    return;
  }

  const userDataPath = app.getPath('userData');
  settingsPath = path.join(userDataPath, SETTINGS_FILE);

  try {
    const contents = await fsPromises.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(contents);
    settings = sanitizeSettings(parsed);
  } catch (err) {
    if (err.code === 'ENOENT') {
      let migrated = false;
      for (const legacyFile of LEGACY_SETTINGS_FILES) {
        const legacyPath = path.join(userDataPath, legacyFile);
        try {
          const legacyContents = await fsPromises.readFile(legacyPath, 'utf8');
          const parsed = JSON.parse(legacyContents);
          settings = sanitizeSettings(parsed);
          migrated = true;
          try {
            await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
            await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
            await fsPromises.unlink(legacyPath).catch(() => {});
          } catch (persistErr) {
            console.warn('Failed to migrate legacy settings file:', persistErr);
          }
          break;
        } catch (legacyErr) {
          if (legacyErr.code !== 'ENOENT') {
            console.error('Failed to load legacy settings file:', legacyErr);
          }
        }
      }

      if (!migrated) {
        settings = getDefaultSettings();
      }
    } else {
      console.error('Failed to load settings:', err);
      settings = getDefaultSettings();
    }
  }

  settingsLoaded = true;
}

async function ensureChatsLoaded() {
  if (chatsLoaded) {
    return;
  }

  const userDataPath = app.getPath('userData');
  storagePath = path.join(userDataPath, STORE_FILE);

  try {
    const contents = await fsPromises.readFile(storagePath, 'utf8');
    const parsed = JSON.parse(contents);
    if (Array.isArray(parsed)) {
      chatsCache = parsed.map((chat) => ({
        ...chat,
        initialUserPrompt: typeof chat.initialUserPrompt === 'string' ? chat.initialUserPrompt : '',
        attachments: Array.isArray(chat.attachments) ? sanitizeStoredAttachments(chat.attachments) : [],
      }));
    } else {
      chatsCache = [];
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      let migrated = false;
      for (const legacyFile of LEGACY_STORE_FILES) {
        const legacyPath = path.join(userDataPath, legacyFile);
        try {
          const legacyContents = await fsPromises.readFile(legacyPath, 'utf8');
          const parsed = JSON.parse(legacyContents);
          chatsCache = Array.isArray(parsed)
            ? parsed.map((chat) => ({
                ...chat,
                initialUserPrompt: typeof chat.initialUserPrompt === 'string' ? chat.initialUserPrompt : '',
                attachments: Array.isArray(chat.attachments)
                  ? sanitizeStoredAttachments(chat.attachments)
                  : [],
              }))
            : [];
          migrated = true;
          try {
            await fsPromises.mkdir(path.dirname(storagePath), { recursive: true });
            await fsPromises.writeFile(storagePath, JSON.stringify(chatsCache, null, 2), 'utf8');
            await fsPromises.unlink(legacyPath).catch(() => {});
          } catch (persistErr) {
            console.warn('Failed to migrate legacy chats file:', persistErr);
          }
          break;
        } catch (legacyErr) {
          if (legacyErr.code !== 'ENOENT') {
            console.error('Failed to load legacy chats file:', legacyErr);
          }
        }
      }

      if (!migrated) {
        chatsCache = [];
      }
    } else {
      console.error('Failed to load chats:', err);
      chatsCache = [];
    }
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

function getRendererSafeSettings() {
  const safe = sanitizeSettings(settings);
  settings = safe;
  const { analyticsDeviceId, ...publicSettings } = safe || {};
  return publicSettings;
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

function buildChatMarkdown(chat) {
  const lines = [];
  lines.push(`# ${chat.title || 'Conversation'}`);
  lines.push('');
  lines.push(`- Model: ${chat.model || 'Unknown'}`);
  lines.push(`- Created: ${chat.createdAt ? formatReadableDate(chat.createdAt) : 'Unknown'}`);
  lines.push(`- Updated: ${chat.updatedAt ? formatReadableDate(chat.updatedAt) : 'Unknown'}`);
  lines.push('');
  (chat.messages || []).forEach((message) => {
    const roleLabel = message.role === 'assistant' ? 'Assistant' : 'User';
    lines.push(`## ${roleLabel}`);
    lines.push('');
    lines.push(message.content || '');
    lines.push('');
  });
  return lines.join('\n');
}

async function generatePdfFromMarkdown(markdown, title) {
  const html = createHtmlDocument(markdown, title);
  const exportWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
    },
  });

  try {
    await exportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdfBuffer = await exportWindow.webContents.printToPDF({
      printBackground: true,
      marginsType: 1,
    });
    return pdfBuffer;
  } finally {
    exportWindow.destroy();
  }
}

function createHtmlDocument(markdown, title) {
  const body = marked.parse(markdown ?? '');
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2.5rem; color: #1c1c1e; }
      h1, h2, h3, h4 { color: #0f0f10; }
      h2 { margin-top: 1.8rem; }
      ul { padding-left: 1.4rem; }
      pre { background: #f4f4f6; padding: 1rem; border-radius: 8px; overflow-x: auto; }
      code { font-family: 'SFMono-Regular', Menlo, Consolas, monaco, monospace; }
    </style>
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function slugify(value) {
  return String(value || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'conversation';
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

  if (partial.theme !== undefined) {
    next.theme = normalizeTheme(partial.theme);
  }

  if (partial.showTutorial !== undefined) {
    next.showTutorial = Boolean(partial.showTutorial);
  }

  if (partial.shareAnalytics !== undefined) {
    next.shareAnalytics = Boolean(partial.shareAnalytics);
  }

  if (partial.useOpenAICompatibleEndpoint !== undefined) {
    next.useOpenAICompatibleEndpoint = Boolean(partial.useOpenAICompatibleEndpoint);
  }

  if (partial.analyticsDeviceId !== undefined) {
    const value =
      typeof partial.analyticsDeviceId === 'string' && partial.analyticsDeviceId.trim()
        ? partial.analyticsDeviceId.trim()
        : null;
    if (value) {
      next.analyticsDeviceId = value;
    }
  }

  if (partial.ollamaEndpoint !== undefined) {
    const endpoint = normalizeOllamaEndpoint(partial.ollamaEndpoint);
    next.ollamaEndpoint = endpoint || DEFAULT_SETTINGS.ollamaEndpoint;
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

function normalizeTheme(theme) {
  const allowed = ['system', 'light', 'dark', 'cream'];
  if (allowed.includes(theme)) {
    return theme;
  }
  return DEFAULT_SETTINGS.theme;
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
  const searchTimeout = Number.isFinite(options?.timeoutMs)
    ? Math.max(1500, Number(options.timeoutMs))
    : 7000;
  const pageTimeout = Number.isFinite(options?.pageTimeoutMs)
    ? Math.max(1500, Number(options.pageTimeoutMs))
    : 6000;
  const retrievedAt = new Date().toISOString();

  try {
    /* eslint-disable no-await-in-loop */
    for (const query of uniqueQueries) {
      let results = [];
      try {
        results = await fetchDuckDuckGoResults(query, searchTimeout);
      } catch (err) {
        console.error(`DuckDuckGo search failed for "${query}":`, err?.message || err);
        continue;
      }

      if (!Array.isArray(results) || !results.length) {
        continue;
      }

      for (const result of results) {
        if (entries.length >= maxEntries) {
          break;
        }
        const normalizedUrl = typeof result.url === 'string' ? result.url.trim() : '';
        if (normalizedUrl && seenUrls.has(normalizedUrl)) {
          continue;
        }
        if (normalizedUrl) {
          seenUrls.add(normalizedUrl);
        }
        const snippet = result.snippet ? truncateSnippet(result.snippet) : '';
        entries.push({
          title: result.title || normalizedUrl || 'Result',
          snippet,
          summary: result.summary || result.snippet || '',
          url: normalizedUrl,
          queryUsed: query,
        });
      }

      if (entries.length >= maxEntries) {
        break;
      }
    }
    /* eslint-enable no-await-in-loop */

    if (!entries.length) {
      return { text: '', entries: [], queries: uniqueQueries, retrievedAt };
    }

    const enrichedEntries = await enrichEntriesWithPageContent(entries, {
      maxPages: Math.min(entries.length, Math.max(1, Math.min(4, maxEntries))),
      maxCharsPerEntry: 1400,
      timeoutMs: pageTimeout,
    });

    return {
      text: formatSearchEntries(enrichedEntries, retrievedAt, uniqueQueries),
      entries: enrichedEntries,
      queries: uniqueQueries,
      retrievedAt,
    };
  } catch (err) {
    console.error('Web search failed:', err);
    return { text: '', entries: [], queries: uniqueQueries, retrievedAt };
  }
}

async function fetchDuckDuckGoResults(query, timeoutMs) {
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  if (!trimmedQuery) {
    return [];
  }

  const attemptErrors = [];

  for (const variant of DUCKDUCKGO_SEARCH_VARIANTS) {
    const url = variant.buildUrl(trimmedQuery);
    if (!url) {
      continue;
    }

    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: variant.method || 'GET',
          headers: buildDuckDuckGoHeaders(variant.type, variant.headers),
          body: typeof variant.buildBody === 'function' ? variant.buildBody(trimmedQuery) : undefined,
        },
        timeoutMs
      );

      if (!response.ok) {
        attemptErrors.push(`${variant.name}: HTTP ${response.status}`);
        continue;
      }

      let parsed = [];
      if (variant.type === 'json') {
        parsed = parseDuckDuckGoInstantAnswer(await response.json());
      } else {
        const html = await response.text();
        parsed = parseDuckDuckGoHtml(html);
      }

      if (parsed.length) {
        return parsed;
      }

      attemptErrors.push(`${variant.name}: empty`);
    } catch (err) {
      attemptErrors.push(`${variant.name}: ${err?.message || err}`);
    }
  }

  if (attemptErrors.length) {
    console.warn(
      `DuckDuckGo search attempts failed for "${trimmedQuery}": ${attemptErrors.join('; ')}`
    );
  }
  return [];
}

function buildDuckDuckGoHeaders(type, extraHeaders = {}) {
  const baseHeaders = {
    'User-Agent': DUCKDUCKGO_USER_AGENT,
    Accept: type === 'json' ? DUCKDUCKGO_JSON_ACCEPT : DUCKDUCKGO_HTML_ACCEPT,
  };

  if (!extraHeaders || typeof extraHeaders !== 'object') {
    return baseHeaders;
  }

  return { ...baseHeaders, ...extraHeaders };
}

function parseDuckDuckGoHtml(html) {
  if (!html) {
    return [];
  }

  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  const pushResult = (title, snippet, href) => {
    const normalizedUrl = decodeDuckDuckGoUrl(href);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      return;
    }
    seen.add(normalizedUrl);
    const cleanTitle = title ? String(title).replace(/\s+/g, ' ').trim() : '';
    const cleanSnippet = snippet ? String(snippet).replace(/\s+/g, ' ').trim() : '';
    results.push({
      title: cleanTitle || normalizedUrl,
      snippet: cleanSnippet,
      summary: cleanSnippet,
      url: normalizedUrl,
    });
  };

  $('.result').each((_index, element) => {
    const node = $(element);
    const title =
      node.find('.result__a').text().trim() ||
      node.find('.result__title').text().trim();
    const snippet = node.find('.result__snippet').text().trim();
    const href = node.find('.result__a').attr('href');
    if (!title && !snippet) {
      return;
    }
    pushResult(title, snippet, href);
  });

  if (results.length) {
    return results;
  }

  $('td.result-link').each((_index, element) => {
    if (results.length >= 10) {
      return false;
    }
    const cell = $(element);
    const anchor = cell.find('a').first();
    const href = anchor.attr('href');
    if (!href) {
      return;
    }
    const title = anchor.text().trim();
    const snippetRow = cell.closest('tr').next('tr');
    const snippet =
      snippetRow.find('td.result-snippet').text().trim() || snippetRow.text().trim();
    pushResult(title, snippet, href);
  });

  if (results.length) {
    return results;
  }

  $('a.result__a').each((_index, element) => {
    if (results.length >= 10) {
      return false;
    }
    const anchor = $(element);
    const href = anchor.attr('href');
    if (!href) {
      return;
    }
    const title = anchor.text().trim();
    const snippet =
      anchor.closest('.links_main').find('.result__snippet').text().trim() || '';
    pushResult(title, snippet, href);
  });

  return results;
}

function parseDuckDuckGoInstantAnswer(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const entries = [];
  const seen = new Set();

  const pushResult = (title, snippet, href) => {
    if (!href) {
      return;
    }
    const normalizedUrl = decodeDuckDuckGoUrl(href);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      return;
    }
    seen.add(normalizedUrl);
    const cleanTitle = title ? String(title).trim() : '';
    const cleanSnippet = snippet ? String(snippet).trim() : '';
    entries.push({
      title: cleanTitle || normalizedUrl,
      snippet: cleanSnippet,
      summary: cleanSnippet,
      url: normalizedUrl,
    });
  };

  if (payload.AbstractURL && payload.AbstractText) {
    pushResult(payload.Heading || payload.AbstractText, payload.AbstractText, payload.AbstractURL);
  }

  const relatedTopics = Array.isArray(payload.RelatedTopics) ? payload.RelatedTopics : [];
  relatedTopics.forEach((topic) => {
    if (topic && Array.isArray(topic.Topics)) {
      topic.Topics.forEach((nested) => pushResult(nested?.Text, nested?.Text, nested?.FirstURL));
    } else {
      pushResult(topic?.Text, topic?.Text, topic?.FirstURL);
    }
  });

  return entries.slice(0, 8);
}

function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const { signal: externalSignal, ...rest } = options || {};
  let externalAbortHandler = null;

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      return Promise.reject(new Error('The operation was aborted.'));
    }

    externalAbortHandler = () => controller.abort();
    if (typeof externalSignal.addEventListener === 'function') {
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timeoutId);
    if (externalSignal && externalAbortHandler && typeof externalSignal.removeEventListener === 'function') {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  };

  return fetch(url, { ...rest, signal: controller.signal })
    .catch((err) => {
      if (err.name === 'AbortError') {
        const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      }
      throw err;
    })
    .finally(cleanup);
}

async function enrichEntriesWithPageContent(entries, options = {}) {
  const result = entries.map((entry) => ({ ...entry }));
  const maxPages = Math.max(
    1,
    Math.min(options?.maxPages ?? Math.min(3, result.length), result.length)
  );
  const maxChars = Math.max(400, options?.maxCharsPerEntry ?? 1400);
  const pageTimeout = Number.isFinite(options?.timeoutMs)
    ? Math.max(1500, Number(options.timeoutMs))
    : 6000;
  let fetchedCount = 0;

  /* eslint-disable no-await-in-loop */
  for (let index = 0; index < result.length; index += 1) {
    if (fetchedCount >= maxPages) {
      break;
    }

    const entry = result[index];
    if (!entry?.url) {
      continue;
    }

    try {
      const res = await fetchWithTimeout(entry.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      }, pageTimeout);

      if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) {
        continue;
      }

      const html = await res.text();
      const extracted = extractPageSummary(html, { maxChars });
      if (extracted) {
        entry.summary = extracted;
        fetchedCount += 1;
      }
    } catch (err) {
      console.error(`Failed to fetch page content for ${entry.url}:`, err.message || err);
    }
  }
  /* eslint-enable no-await-in-loop */

  return result;
}

function extractPageSummary(html, options = {}) {
  if (!html) {
    return '';
  }

  const maxChars = Math.max(400, options?.maxChars ?? 1400);
  const $ = cheerio.load(html);

  $('script, style, noscript, svg, iframe, footer, header, nav, form, picture, figure, video, audio').remove();

  const root =
    $('main').length > 0
      ? $('main')
      : $('article').length > 0
        ? $('article')
        : $('body');

  const paragraphs = [];
  root.find('p').each((_idx, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length >= 60) {
      paragraphs.push(text);
    }
  });

  if (!paragraphs.length) {
    return '';
  }

  const fullText = paragraphs.join(' ');
  const sentences = fullText.split(/(?<=[.!?])\s+/).filter(Boolean);
  const summaryParts = [];
  let totalChars = 0;

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }
    summaryParts.push(trimmed);
    totalChars += trimmed.length + 1;
    if (summaryParts.length >= 8 || totalChars >= maxChars) {
      break;
    }
  }

  return summaryParts.join(' ').trim();
}

function clampDeepResearchIterations(value) {
  const numeric = Number.isFinite(value) ? Number(value) : DEFAULT_DEEP_RESEARCH_ITERATIONS;
  return Math.max(
    MIN_DEEP_RESEARCH_ITERATIONS,
    Math.min(MAX_DEEP_RESEARCH_ITERATIONS, Math.round(numeric))
  );
}

function buildInitialResearchQueries(topic, extraQueries = []) {
  const queries = [];
  const normalizedTopic = typeof topic === 'string' ? topic.replace(/\s+/g, ' ').trim() : '';
  if (normalizedTopic) {
    const segments = normalizedTopic
      .split(/[?!.;]/)
      .map((segment) => segment.replace(/\s+/g, ' ').trim())
      .filter((segment) => segment.length >= 6);
    let expanded = [];
    segments.forEach((segment) => {
      expanded = expanded.concat(expandCompositeSegment(segment));
    });
    if (!expanded.length) {
      expanded = [normalizedTopic];
    }
    expanded.forEach((segment) => {
      if (segment && !queries.includes(segment)) {
        queries.push(segment);
      }
    });
  }

  if (Array.isArray(extraQueries)) {
    extraQueries.forEach((value) => {
      if (typeof value === 'string' && value.trim()) {
        const normalized = value.trim();
        if (!queries.includes(normalized)) {
          queries.push(normalized);
        }
      }
    });
  }

  return queries.slice(0, DEEP_RESEARCH_MAX_QUERY_POOL);
}

function expandCompositeSegment(segment) {
  const trimmed = (segment || '').trim();
  if (!trimmed) {
    return [];
  }

  const splitNeeded = /,\s+| and | & | plus | along with | as well as /i.test(trimmed);
  if (!splitNeeded) {
    return [trimmed];
  }

  const parts = trimmed
    .split(/\s*(?:,| and | & | plus | along with | as well as )\s*/i)
    .map((part) => part.replace(/^(?:and|or)\s+/i, '').trim().replace(/[.?!]+$/, ''))
    .filter((part) => part && part.length >= 3);

  if (parts.length <= 1) {
    return [trimmed];
  }

  const prefixMatch = trimmed.match(/^(.*?\b(?:on|about|regarding)\b)/i);
  return parts.map((part) => {
    const candidate = prefixMatch && !/^(?:what|who|where|when|why|how)/i.test(part)
      ? `${prefixMatch[1]} ${part}`.trim()
      : part;
    if (!/latest|current|recent|today|breaking/i.test(candidate) && !/^(?:who|what|where|when|why|how)/i.test(candidate)) {
      return `latest ${candidate}`.trim();
    }
    return candidate;
  });
}

function filterFreshEntries(entries, seenUrls, limit) {
  const result = [];
  if (!Array.isArray(entries)) {
    return result;
  }
  const max = Math.max(1, Number.isFinite(limit) ? Number(limit) : DEEP_RESEARCH_FINDINGS_PER_PASS);
  entries.forEach((entry) => {
    if (result.length >= max) {
      return;
    }
    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    if (!url) {
      return;
    }
    if (seenUrls.has(url)) {
      return;
    }
    seenUrls.add(url);
    result.push(entry);
  });
  return result;
}

function summarizeDeepResearchEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return [];
  }
  return entries.slice(0, DEEP_RESEARCH_FINDINGS_PER_PASS).map((entry) => ({
    title: entry.title || entry.url || 'Result',
    url: entry.url || '',
    summary: sanitizeFindingSummary(entry.summary || entry.snippet || ''),
  }));
}

function sanitizeFindingSummary(text, maxLength = 220) {
  if (!text) {
    return '';
  }
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return normalized;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function deriveFollowUpQueries(entries, topic, existingQueries = []) {
  if (!Array.isArray(entries) || !entries.length) {
    return [];
  }
  const keywordScores = new Map();
  const topicTokens = extractKeywordCandidates(topic);
  const topicTokenSet = new Set(topicTokens);
  const existingSet = new Set(
    (existingQueries || [])
      .map((value) => (typeof value === 'string' ? value.toLowerCase() : ''))
      .filter(Boolean)
  );

  entries.forEach((entry) => {
    const text = [entry.title, entry.summary, entry.snippet].filter(Boolean).join(' ');
    const tokens = extractKeywordCandidates(text);
    tokens.forEach((token) => {
      if (topicTokenSet.has(token)) {
        return;
      }
      keywordScores.set(token, (keywordScores.get(token) || 0) + 1);
    });
  });

  const sortedTokens = Array.from(keywordScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token);

  const suggestions = [];
  sortedTokens.forEach((token) => {
    if (suggestions.length >= 2) {
      return;
    }
    if (!token || token.length < 4) {
      return;
    }
    const candidate = `${topic} ${token}`;
    const normalized = candidate.toLowerCase();
    if (existingSet.has(normalized)) {
      return;
    }
    suggestions.push(candidate);
    existingSet.add(normalized);
  });

  return suggestions;
}

function extractKeywordCandidates(text) {
  if (!text) {
    return [];
  }
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 2 && !TOKEN_STOP_WORDS.has(token));
}

function buildDeepResearchSummary(topic, timeline = [], finalAnswer = '') {
  const sanitizedTopic = typeof topic === 'string' && topic.trim() ? topic.trim() : 'Unknown topic';
  const lines = [
    `Deep research topic: ${sanitizedTopic}`,
    `Passes completed: ${timeline.length}`,
  ];
  const trimmedAnswer = typeof finalAnswer === 'string' ? finalAnswer.trim() : '';
  const findingsLines = [];
  const sources = [];
  const seenSources = new Set();

  timeline.forEach((entry) => {
    const passHeader = `Pass ${entry.iteration || '?'} (${entry.query || 'untitled query'})`;
    if (!entry.findings?.length) {
      findingsLines.push(`${passHeader}: No new sources captured.`);
      if (entry.review) {
        findingsLines.push(`  Review: ${entry.review}`);
      }
      findingsLines.push('');
      return;
    }
    findingsLines.push(`${passHeader}:`);
    entry.findings.forEach((finding) => {
      const title = finding.title || finding.url || 'Source';
      findingsLines.push(`• ${title}`);
      if (finding.summary) {
        findingsLines.push(`  ${finding.summary}`);
      }
      if (finding.url) {
        findingsLines.push(`  Source: ${finding.url}`);
        if (!seenSources.has(finding.url)) {
          seenSources.add(finding.url);
          sources.push({ title, url: finding.url });
        }
      }
    });
    if (entry.review) {
      findingsLines.push(`  Review: ${entry.review}`);
    }
    findingsLines.push('');
  });

  if (!findingsLines.length) {
    findingsLines.push('No sources were discovered during this run.');
  }

  const combined = [...lines, '', ...findingsLines].join('\n').trim();
  const limitedSummary =
    combined.length > DEEP_RESEARCH_MAX_SUMMARY_CHARS
      ? `${combined.slice(0, DEEP_RESEARCH_MAX_SUMMARY_CHARS - 1)}…`
      : combined;

  return {
    summary: limitedSummary,
    sources,
    answer: trimmedAnswer,
  };
}

function buildResearchReflection(topic, memoryEntries = [], existingQueries = []) {
  if (!Array.isArray(memoryEntries) || !memoryEntries.length) {
    return { summary: '', nextQueries: [] };
  }

  const uniqueSources = new Set();
  const domainCounts = new Map();

  memoryEntries.forEach((entry) => {
    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    if (!url) {
      return;
    }
    uniqueSources.add(url);
    const host = resolveHostname(url);
    if (host) {
      domainCounts.set(host, (domainCounts.get(host) || 0) + 1);
    }
  });

  const topDomains = Array.from(domainCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([host, count]) => `${host} (${count})`);

  const suggestions = deriveFollowUpQueries(memoryEntries, topic, existingQueries);
  const reviewedCount = uniqueSources.size || memoryEntries.length;
  const summaryParts = [
    `Reviewed ${reviewedCount} unique source${reviewedCount === 1 ? '' : 's'} so far.`,
  ];
  if (topDomains.length) {
    summaryParts.push(`Top domains: ${topDomains.join(', ')}.`);
  }
  if (suggestions.length) {
    summaryParts.push(`Next angles: ${suggestions.join('; ')}.`);
  } else {
    summaryParts.push('Continuing to scan for fresh coverage.');
  }

  return {
    summary: summaryParts.join(' '),
    nextQueries: suggestions,
  };
}

async function generateQuerySuggestions({
  model,
  topic,
  timeline,
  existingQueries = [],
  maxSuggestions = 2,
}) {
  if (!model || !Array.isArray(timeline) || !timeline.length) {
    return [];
  }

  const latestFindings = timeline[timeline.length - 1]?.findings || [];
  const recapLines = [];
  timeline.forEach((entry) => {
    const parts = [];
    if (Number.isFinite(entry.iteration)) {
      parts.push(`Pass ${entry.iteration}`);
    }
    if (entry.query) {
      parts.push(`Query: ${entry.query}`);
    }
    if (Array.isArray(entry.findings) && entry.findings.length) {
      entry.findings.slice(0, 2).forEach((finding, index) => {
        parts.push(
          `Finding ${index + 1}: ${finding.title || finding.url || 'Source'}${
            finding.summary ? ` — ${finding.summary}` : ''
          }`
        );
      });
    } else if (entry.review) {
      parts.push(`Review: ${entry.review}`);
    }
    if (parts.length) {
      recapLines.push(parts.join('\n'));
    }
  });

  const messages = [
    {
      role: 'system',
      content:
        'You are a research strategist. Suggest short, precise web search queries that would unlock new information, given the findings so far. Reply ONLY with JSON: {"queries":["...","..."]}',
    },
    {
      role: 'user',
      content: [
        `Overall question: ${topic}`,
        '',
        'Findings so far:',
        recapLines.join('\n\n') || '(none)',
        '',
        `Latest findings (${latestFindings.length}):`,
        latestFindings
          .map(
            (finding, index) =>
              `${index + 1}. ${finding.title || finding.url || 'Source'}${
                finding.summary ? ` — ${finding.summary}` : ''
              }`
          )
          .join('\n') || '(none)',
        '',
        `Existing query set: ${existingQueries.join(', ') || '(none)'}`,
        '',
        `Suggest up to ${maxSuggestions} new queries that differ from the existing set and cover uncovered angles.`,
      ].join('\n'),
    },
  ];

  try {
    const response = await chatCompletion(model, messages, { timeoutMs: 20000 });
    const parsed = extractJsonObjectFromText(response.content);
    if (!parsed || !Array.isArray(parsed.queries)) {
      return [];
    }
    return parsed.queries
      .map((query) => (typeof query === 'string' ? query.trim() : ''))
      .filter((query) => query && !existingQueries.includes(query))
      .slice(0, maxSuggestions);
  } catch (err) {
    console.error('Failed to generate model-query suggestions:', err);
    return [];
  }
}

function createSearchPlan(prompt, prefs = getDefaultSettings(), userPrompt = '', options = {}) {
  const historyPrompt = typeof prompt === 'string' ? prompt : '';
  const trimmedHistory = historyPrompt.trim();
  const trimmedUserPrompt = typeof userPrompt === 'string' ? userPrompt.trim() : '';
  const analysisPrompt = trimmedUserPrompt || trimmedHistory;
  if (!analysisPrompt) {
    return {
      shouldSearch: false,
      queries: [],
      genericFresh: false,
      message: '',
      disabled: prefs?.autoWebSearch === false,
    };
  }

  const autoEnabled = prefs?.autoWebSearch !== false;
  const directiveInfo = extractDirectiveQuery(trimmedUserPrompt || trimmedHistory);
  const directiveQuery = directiveInfo.query;
  const directiveDetected = directiveInfo.detected;
  const hasRecentContext = Boolean(options?.hasRecentContext);
  const focusTerms = Array.isArray(options?.focusTerms)
    ? options.focusTerms.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];
  const conversationConfidence =
    typeof options?.conversationConfidence === 'number'
      ? Math.max(0, Math.min(1, options.conversationConfidence))
      : 0;
  const conversationCoverage =
    typeof options?.conversationCoverage === 'number'
      ? Math.max(0, Math.min(1, options.conversationCoverage))
      : 0;
  const missingTerms = Array.isArray(options?.missingTerms)
    ? options.missingTerms.map((token) => String(token || '').trim()).filter(Boolean)
    : [];
  const promptTokenCount = Number.isFinite(options?.promptTokenCount) ? options.promptTokenCount : null;
  const longRunning = Boolean(options?.longRunning);
  const goalAligned = options?.goalAligned !== false;
  const assistantTurns = Number.isFinite(options?.assistantTurns) ? options.assistantTurns : 0;
  const webContextTurns = Number.isFinite(options?.webContextTurns) ? options.webContextTurns : 0;

  if (directiveDetected && !directiveQuery) {
    return {
      shouldSearch: false,
      queries: [],
      genericFresh: false,
      message: 'Targeted request detected with no searchable title—using provided references only.',
      disabled: false,
    };
  }

  if (
    hasRecentContext &&
    !directiveDetected &&
    trimmedUserPrompt &&
    (isReferentialFollowUp(trimmedUserPrompt) || focusTerms.length === 0)
  ) {
    return {
      shouldSearch: false,
      queries: [],
      genericFresh: false,
      message: 'Clarifying follow-up detected – using existing web context.',
      disabled: false,
    };
  }

  const basePrompt = directiveQuery || analysisPrompt;

  const genericFresh = !directiveDetected && isGenericFreshInfoPrompt(basePrompt);
  const baseShouldSearch = shouldUseWebSearch(basePrompt);

  let queries;
  if (directiveQuery) {
    queries = [directiveQuery];
  } else if (focusTerms.length) {
    queries = buildQueriesFromFocusTerms(focusTerms, trimmedUserPrompt || basePrompt, options.initialGoal);
  } else {
    queries = generateSearchQueries(basePrompt);
  }
  if (options.initialGoal) {
    queries.push(options.initialGoal);
  }
  queries = Array.from(new Set(queries.filter(Boolean)));

  if (!autoEnabled) {
    return {
      shouldSearch: false,
      queries: queries.length ? queries : [basePrompt],
      genericFresh,
      message: 'Web search is disabled in settings.',
      disabled: true,
    };
  }

  const hasQueries = queries.length > 0;
  let shouldSearch = autoEnabled ? hasQueries || baseShouldSearch || genericFresh : baseShouldSearch || genericFresh;
  const minimalGaps =
    missingTerms.length === 0 ||
    (missingTerms.length === 1 && (promptTokenCount === null || promptTokenCount > 1));
  let overrideMessage = null;

  if (!directiveDetected) {
    const highConfidence = conversationConfidence >= 0.65;
    const veryHighConfidence = conversationConfidence >= 0.85;

    if (veryHighConfidence && !genericFresh) {
      shouldSearch = false;
    } else if (
      highConfidence &&
      !genericFresh &&
      minimalGaps &&
      (conversationCoverage >= 0.6 || !baseShouldSearch)
    ) {
      shouldSearch = false;
    } else if (highConfidence && longRunning && !genericFresh && conversationCoverage >= 0.55) {
      shouldSearch = false;
    }

    if (!goalAligned) {
      shouldSearch = false;
      overrideMessage = 'Staying on the original objective – skipping new web search.';
    } else if (assistantTurns >= 2) {
      if (webContextTurns >= 1) {
        shouldSearch = false;
        overrideMessage = 'Reusing earlier web findings instead of refreshing search results.';
      } else if (
        !genericFresh &&
        minimalGaps &&
        (conversationCoverage >= 0.3 || conversationConfidence >= 0.5)
      ) {
        shouldSearch = false;
        overrideMessage = 'Existing context covers this follow-up – no new web search required.';
      } else if (shouldSearch) {
        queries = queries.slice(0, Math.min(2, queries.length));
        overrideMessage = 'Focused refresh of web context to refine the original goal.';
      }
    }
  }

  const directiveSummary = directiveQuery ? truncateForSearch(directiveQuery, 120) : '';
  let message = directiveQuery
    ? `Targeted request detected – gathering information for "${directiveSummary}".`
    : genericFresh
      ? 'Broad request detected – gathering current headlines.'
      : autoEnabled
        ? 'Automatic web search is enabled – gathering supporting snippets.'
        : 'Collecting supporting information from the web.';

  if (!directiveDetected && !genericFresh && !shouldSearch && conversationConfidence >= 0.65) {
    message = 'Leaning on conversation memory – no new web search required.';
  }
  if (overrideMessage) {
    message = overrideMessage;
  }

  return {
    shouldSearch,
    queries: queries.length ? queries : [basePrompt],
    genericFresh,
    message,
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

function extractDirectiveQuery(prompt) {
  const result = { detected: false, query: '' };

  if (!prompt || typeof prompt !== 'string') {
    return result;
  }

  const directivePattern =
    /(fetch|get)\s+(?:me\s+)?(?:this|that|the)?\s*(?:page|information|article|details|story|resource|data)(?:\s+(?:about|on|regarding)\s+)?(.*)/i;
  const triggerPattern =
    /(fetch|get)\s+(?:me\s+)?(?:this|that|the)?\s*(?:page|information|article|details|story|resource|data)/i;

  if (!triggerPattern.test(prompt.toLowerCase())) {
    return result;
  }

  result.detected = true;

  const lines = prompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!triggerPattern.test(line.toLowerCase())) {
      continue;
    }

    let candidate = '';

    const colonIndex = line.lastIndexOf(':');
    if (colonIndex !== -1 && colonIndex < line.length - 1) {
      candidate = line.slice(colonIndex + 1).trim();
    }

    if (!candidate) {
      const match = line.match(directivePattern);
      if (match && match[2]) {
        candidate = match[2].trim();
      }
    }

    if (!candidate) {
      const quoted = line.match(/["“'‘](.+?)["”'’]$/);
      if (quoted && quoted[1]) {
        candidate = quoted[1].trim();
      }
    }

    if (!candidate && i + 1 < lines.length) {
      candidate = lines[i + 1];
    }

    if (!candidate && i > 0) {
      candidate = lines[i - 1];
    }

    const cleaned = cleanDirectiveQuery(candidate);
    if (cleaned) {
      return { detected: true, query: cleaned };
    }
  }

  const fallbackMatch = prompt.match(directivePattern);
  if (fallbackMatch && fallbackMatch[2]) {
    const cleaned = cleanDirectiveQuery(fallbackMatch[2]);
    if (cleaned) {
      return { detected: true, query: cleaned };
    }
  }

  return result;
}

function cleanDirectiveQuery(raw) {
  if (!raw || typeof raw !== 'string') {
    return '';
  }

  let value = raw.trim();
  if (!value) {
    return '';
  }

  if (/^https?:\/\//i.test(value)) {
    return '';
  }

  value = value
    .replace(/^(?:fetch|get)\s+(?:me\s+)?(?:this|that|the)?\s*(?:page|information|article|details|story|resource|data)/i, '')
    .replace(/^[:\-–—\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!value || value.length < 3) {
    return '';
  }

  return value;
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
    'You are a precise assistant that values factual accuracy and depth.',
    'Use the conversation history and supplied context to craft comprehensive, user-facing answers.',
    'Prioritize the existing conversation memory over new web searches; rely on dialogue unless essential details are missing.',
    'Never assume the user can open a website—surface the key facts directly in your reply.',
    'Cite the source domain in parentheses when you use supplied context.',
    'If the provided context does not answer the question, say you do not know.',
    'When you truly require fresh web information, reply with exactly [[search: your query]] and nothing else, then wait for new context before answering.',
    'Do not emit the [[search: …]] directive unless the conversation and provided context cannot answer the request.',
  ].join(' ');
}

function buildGoalInstruction(initialGoal, latestPrompt) {
  const lines = [
    'Conversation objective:',
    initialGoal,
    '',
    'Every answer must drive progress on this objective. Use follow-up questions to refine or extend the same goal, not to replace it.',
    'If the user attempts to pivot away from this goal, remind them of the original objective and suggest starting a new chat for the new topic before offering assistance.',
  ];

  if (latestPrompt && latestPrompt.trim() && latestPrompt.length < 240) {
    lines.push('', 'Latest user request:', latestPrompt.trim());
  }

  return lines.join('\n');
}

function buildGoalGuardrailInstruction(initialGoal) {
  return [
    'Guardrail:',
    'Do not switch tasks during this chat.',
    `If the user asks for something unrelated, restate that the active goal is: ${initialGoal}`,
    'Politely offer to begin a new chat for any unrelated requests and steer the conversation back to the original objective.',
  ].join('\n');
}

function buildContextInstruction({ context, retrievedAt, genericFresh }) {
  const lines = [
    'Incorporate the verified facts from the context below when answering.',
    'Never invent information that is not supported by the context or prior conversation.',
    'If the web context directly answers the question, use it; otherwise fall back to the prior conversation.',
    'Give precedence to user-provided links when they are relevant to the question.',
    'Refer to uploaded files using the notation (uploaded: filename) when you cite them.',
    'Provide a thorough, well-structured answer that explains key details and the implications of those facts.',
    'Draw connections between sources when helpful and end with clear takeaways or next steps when appropriate.',
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

function resolveHostname(url) {
  if (!url || typeof url !== 'string') {
    return '';
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (err) {
    return '';
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
      if (entry.summary) {
        lines.push(entry.summary);
      } else if (entry.snippet) {
        lines.push(entry.snippet);
      }
      if (entry.url) {
        const host = resolveHostname(entry.url);
        lines.push(host ? `Source: ${host} (${entry.url})` : `Source: ${entry.url}`);
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

  const raw = String(href).trim();
  if (!raw || raw === '#') {
    return '';
  }

  const ensureAbsolute = (value) => {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    if (value.startsWith('//')) {
      return `https:${value}`;
    }
    const needsSlash = value.startsWith('/') ? '' : '/';
    return `https://duckduckgo.com${needsSlash}${value}`;
  };

  try {
    const absolute = ensureAbsolute(raw);
    const url = new URL(absolute);

    if (url.hostname.includes('duckduckgo.com')) {
      const target =
        url.searchParams.get('uddg') ||
        url.searchParams.get('u') ||
        url.searchParams.get('rut');
      if (target) {
        try {
          return decodeURIComponent(target);
        } catch (err) {
          return target;
        }
      }
    }

    return absolute;
  } catch (err) {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return raw;
    }
    if (raw.startsWith('//')) {
      return `https:${raw}`;
    }
    return '';
  }
}

function truncateSnippet(snippet) {
  if (snippet.length <= 320) {
    return snippet;
  }
  return `${snippet.slice(0, 317)}…`;
}


function hasNetworkConnectivity(timeoutMs = 2500, cacheMs = 5000) {
  if (!dnsPromises || typeof dnsPromises.lookup !== 'function') {
    return Promise.resolve(true);
  }

  const now = Date.now();
  if (now - lastConnectivityCheck < cacheMs) {
    return Promise.resolve(lastConnectivityStatus);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finalize = (status) => {
      if (settled) {
        return;
      }
      settled = true;
      lastConnectivityCheck = Date.now();
      lastConnectivityStatus = status;
      resolve(status);
    };

    const timer = setTimeout(() => finalize(false), timeoutMs);

    dnsPromises
      .lookup('duckduckgo.com')
      .then(() => {
        clearTimeout(timer);
        finalize(true);
      })
      .catch(() => {
        clearTimeout(timer);
        finalize(false);
      });
  });
}


function sanitizeAttachmentsPayload(rawAttachments = []) {
  if (!Array.isArray(rawAttachments) || !rawAttachments.length) {
    return { entries: [], summary: [], block: '', warnings: [] };
  }

  const limited = rawAttachments.slice(0, MAX_ATTACHMENTS_PER_PROMPT);
  const entries = [];
  const summary = [];
  const warnings = [];
  let totalBytes = 0;

  for (const attachment of limited) {
    if (!attachment || typeof attachment !== 'object') {
      continue;
    }

    const name = String(attachment.name || '').trim() || 'attachment.txt';
    const size = Number.isFinite(attachment.size) ? Math.max(0, Number(attachment.size)) : 0;
    let content = typeof attachment.content === 'string' ? attachment.content : '';
    if (!content.trim()) {
      continue;
    }

    let sanitized = truncateContentToBytes(content, MAX_ATTACHMENT_BYTES);
    let sanitizedBytes = Buffer.byteLength(sanitized, 'utf8');
    let truncated = sanitized.length < content.length;

    if (sanitized.length > MAX_ATTACHMENT_CHARS) {
      const sliced = sanitized.slice(0, MAX_ATTACHMENT_CHARS);
      sanitized = `${sliced}\n… [truncated]`;
      sanitized = truncateContentToBytes(sanitized, MAX_ATTACHMENT_BYTES);
      sanitizedBytes = Buffer.byteLength(sanitized, 'utf8');
      truncated = true;
      warnings.push(`Trimmed ${name} to ${MAX_ATTACHMENT_CHARS.toLocaleString()} characters to keep it manageable.`);
    }

    if (totalBytes + sanitizedBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      const remaining = MAX_ATTACHMENT_TOTAL_BYTES - totalBytes;
      if (remaining <= 0) {
        warnings.push(`Skipping ${name} because it exceeds the total attachment limit.`);
        break;
      }
      const clipped = truncateContentToBytes(sanitized, remaining);
      if (!clipped.trim()) {
        warnings.push(`Skipping ${name} because it exceeds the total attachment limit.`);
        break;
      }
      sanitized = clipped;
      sanitizedBytes = Buffer.byteLength(sanitized, 'utf8');
      truncated = true;
      warnings.push(`Trimmed ${name} to stay within the total attachment limit (${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}).`);
    }

    totalBytes += sanitizedBytes;

    entries.push({
      name,
      size,
      bytes: sanitizedBytes,
      truncated,
      content: sanitized,
    });
    summary.push({
      name,
      size,
      truncated,
    });
  }

  const block = buildAttachmentsContext(entries);

  return { entries, summary, block, warnings };
}

function normalizeDeepResearchMeta(rawDeepResearch) {
  if (!rawDeepResearch || typeof rawDeepResearch !== 'object') {
    return null;
  }
  const summary =
    typeof rawDeepResearch.summary === 'string' && rawDeepResearch.summary.trim()
      ? rawDeepResearch.summary.trim()
      : '';
  const answer =
    typeof rawDeepResearch.answer === 'string' && rawDeepResearch.answer.trim()
      ? rawDeepResearch.answer.trim()
      : '';
  const sources = Array.isArray(rawDeepResearch.sources)
    ? rawDeepResearch.sources
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }
          const title = typeof entry.title === 'string' ? entry.title.trim() : '';
          const url = typeof entry.url === 'string' ? entry.url.trim() : '';
          if (!title && !url) {
            return null;
          }
          return {
            title: title || null,
            url: url || null,
          };
        })
        .filter(Boolean)
        .slice(0, 5)
    : [];

  if (!summary && !sources.length && !answer) {
    return null;
  }

  return { summary, sources, answer };
}

function buildDeepResearchContextBlock(meta) {
  if (!meta) {
    return '';
  }

  const lines = [];
  if (meta.answer) {
    lines.push('Preliminary deep research response:');
    lines.push(meta.answer);
    lines.push('');
  }
  lines.push('These findings were gathered specifically for this request; do not reference prior research or earlier chats unless the user explicitly mentions them.');
  lines.push('');
  if (meta.summary) {
    lines.push('Deep research findings:');
    lines.push(meta.summary);
  }

  if (Array.isArray(meta.sources) && meta.sources.length) {
    if (lines.length) {
      lines.push('');
    }
    lines.push('Deep research sources:');
    meta.sources.forEach((source, index) => {
      const label = source.title || `Source ${index + 1}`;
      const link = source.url ? ` — ${source.url}` : '';
      lines.push(`• ${label}${link}`);
    });
  }

  return lines.join('\n').trim();
}

function sanitizeStoredAttachments(rawAttachments = []) {
  if (!Array.isArray(rawAttachments) || !rawAttachments.length) {
    return [];
  }

  const limited = rawAttachments.slice(0, MAX_ATTACHMENTS_PER_PROMPT);
  const sanitized = [];
  let totalBytes = 0;

  for (const attachment of limited) {
    if (!attachment || typeof attachment !== 'object') {
      continue;
    }

    const name = String(attachment.name || '').trim() || 'attachment.txt';
    const size = Number.isFinite(attachment.size) ? Math.max(0, Number(attachment.size)) : 0;
    const displaySize =
      typeof attachment.displaySize === 'string' && attachment.displaySize.trim()
        ? attachment.displaySize.trim()
        : formatBytes(size);
    const rawContent = typeof attachment.content === 'string' ? attachment.content : '';
    if (!rawContent.trim()) {
      continue;
    }

    let content = truncateContentToBytes(rawContent, MAX_ATTACHMENT_BYTES);
    let bytes = Buffer.byteLength(content, 'utf8');
    let truncated = Boolean(attachment.truncated) || content.length < rawContent.length;

    if (content.length > MAX_ATTACHMENT_CHARS) {
      const sliced = content.slice(0, MAX_ATTACHMENT_CHARS);
      content = `${sliced}\n… [truncated]`;
      content = truncateContentToBytes(content, MAX_ATTACHMENT_BYTES);
      bytes = Buffer.byteLength(content, 'utf8');
      truncated = true;
    }

    if (totalBytes + bytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      const remaining = MAX_ATTACHMENT_TOTAL_BYTES - totalBytes;
      if (remaining <= 0) {
        break;
      }
      const clipped = truncateContentToBytes(content, remaining);
      if (!clipped.trim()) {
        break;
      }
      content = clipped;
      bytes = Buffer.byteLength(content, 'utf8');
      truncated = true;
    }

    totalBytes += bytes;

    sanitized.push({
      id: typeof attachment.id === 'string' && attachment.id ? attachment.id : randomUUID(),
      name,
      size,
      displaySize,
      bytes,
      truncated,
      content,
    });
  }

  return sanitized;
}

function resolveChatInitialGoal(chat) {
  if (!chat) {
    return '';
  }
  if (typeof chat.initialUserPrompt === 'string' && chat.initialUserPrompt.trim()) {
    return chat.initialUserPrompt.trim();
  }
  const firstUser = Array.isArray(chat.messages)
    ? chat.messages.find((message) => message?.role === 'user' && typeof message.content === 'string' && message.content.trim())
    : null;
  return firstUser?.content?.trim() || '';
}

function buildPrimaryAlignedTopic(primaryGoal, latestPrompt) {
  const goal = typeof primaryGoal === 'string' ? primaryGoal.trim() : '';
  const latest = typeof latestPrompt === 'string' ? latestPrompt.trim() : '';
  if (goal && latest) {
    if (latest.toLowerCase().includes(goal.toLowerCase())) {
      return latest;
    }
    return `${goal}\nFollow-up focus: ${latest}`;
  }
  return goal || latest;
}

function buildAttachmentsContext(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return '';
  }

  const lines = ['Uploaded files provided by the user:'];

  entries.forEach((entry, index) => {
    const headerParts = [`File ${index + 1}: ${entry.name}`];
    if (Number.isFinite(entry.size) && entry.size > 0) {
      headerParts.push(`(${formatBytes(entry.size)})`);
    }
    if (entry.truncated) {
      headerParts.push(`[First ${MAX_ATTACHMENT_CHARS.toLocaleString()} characters shown]`);
    }
    lines.push('', headerParts.join(' '));
    lines.push(entry.content.trim());
  });

  return lines.join('\n');
}


function buildSearchPrompt(chat, currentPrompt) {
  const contextParts = [];

  if (chat?.conversationDigest) {
    contextParts.push(`Conversation digest:\n${truncateForSearch(chat.conversationDigest, 1200)}`);
  }

  const userMessages = (chat.messages || []).filter((msg) => msg.role === 'user');
  if (!userMessages.length) {
    return `New question: ${currentPrompt}`;
  }

  const firstUser = userMessages[0];
  const initialGoal = chat.initialUserPrompt || firstUser?.content;
  if (initialGoal) {
    contextParts.push(`Primary goal: ${initialGoal}`);
  }

  const lastAssistant = [...(chat.messages || [])].reverse().find((msg) => msg.role === 'assistant');
  if (lastAssistant?.meta?.context) {
    const contextExcerpt = truncateForSearch(lastAssistant.meta.context, 1200);
    if (contextExcerpt) {
      contextParts.push(`Previously gathered context:\n${contextExcerpt}`);
    }
  }

  if (lastAssistant) {
    contextParts.push(`Most recent answer: ${lastAssistant.content}`);
  }

  const previousUser = userMessages[userMessages.length - 1];
  if (previousUser && previousUser !== firstUser) {
    contextParts.push(`Previous follow-up question: ${previousUser.content}`);
  }

  contextParts.push(`Current follow-up question: ${currentPrompt}`);

  return contextParts.join('\n\n');
}

function truncateForSearch(text, maxChars = 1200) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 1)}…`;
}

function hasRecentWebContext(chat) {
  if (!chat || !Array.isArray(chat.messages)) {
    return false;
  }

  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (!message || message.role !== 'assistant') {
      continue;
    }

    const meta = message.meta || {};
    if (meta.context && String(meta.context).trim()) {
      return true;
    }
    if (meta.usedWebSearch) {
      return true;
    }
  }

  return false;
}

function isReferentialFollowUp(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return false;
  }

  const normalized = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return false;
  }

  const meaningful = tokens.filter((token) => !REFERENTIAL_FOLLOW_UP_STOP_WORDS.has(token));

  if (!meaningful.length) {
    return true;
  }

  if (tokens.length <= 4 && meaningful.length === 1 && meaningful[0].length <= 3) {
    return true;
  }

  return false;
}

function deriveFollowUpFocus(chat, prompt) {
  if (!chat || !Array.isArray(chat.messages) || !prompt) {
    return [];
  }

  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return [];
  }

  const promptTokens = tokenizeForComparison(normalizedPrompt);
  if (!promptTokens.length) {
    return [];
  }

  const coverageTokens = new Set();

  if (chat.initialUserPrompt) {
    tokenizeForComparison(chat.initialUserPrompt).forEach((token) => coverageTokens.add(token));
  }

  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (!message || message.role !== 'assistant') {
      continue;
    }

    const meta = message.meta || {};
    if (message.content) {
      tokenizeForComparison(message.content).forEach((token) => coverageTokens.add(token));
    }
    if (meta.context) {
      tokenizeForComparison(meta.context).forEach((token) => coverageTokens.add(token));
    }

    break;
  }

  const focus = promptTokens.filter((token) => !coverageTokens.has(token));
  return Array.from(new Set(focus)).slice(0, 8);
}

function countAssistantTurns(chat) {
  if (!chat || !Array.isArray(chat.messages)) {
    return 0;
  }
  return chat.messages.reduce(
    (count, message) => (message?.role === 'assistant' ? count + 1 : count),
    0
  );
}

function countWebContextTurns(chat) {
  if (!chat || !Array.isArray(chat.messages)) {
    return 0;
  }

  return chat.messages.reduce((count, message) => {
    if (message?.role !== 'assistant') {
      return count;
    }
    const meta = message.meta || {};
    const usedContext =
      Boolean(meta.usedWebSearch) ||
      (typeof meta.context === 'string' && meta.context.trim().length > 0);
    return usedContext ? count + 1 : count;
  }, 0);
}

function isPromptAlignedWithGoal(initialGoal, prompt) {
  if (!initialGoal || !prompt) {
    return true;
  }

  const goalTokens = tokenizeForComparison(initialGoal);
  const promptTokens = tokenizeForComparison(prompt);

  if (!goalTokens.length || !promptTokens.length) {
    return true;
  }

  const goalSet = new Set(goalTokens);
  const overlap = promptTokens.filter((token) => goalSet.has(token));
  if (!overlap.length) {
    return promptTokens.length <= 1;
  }

  if (promptTokens.length <= 2) {
    return true;
  }

  const promptCoverage = overlap.length / promptTokens.length;
  const goalCoverage = overlap.length / goalSet.size;

  return (
    overlap.length >= 3 ||
    promptCoverage >= 0.4 ||
    goalCoverage >= 0.5 ||
    (promptTokens.length <= 4 && overlap.length >= 1)
  );
}

function limitContextForFollowUp(text, maxSegments = 2, maxChars = 1200) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  const segments = text
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) {
    return text.trim();
  }

  const limited = segments.slice(0, Math.max(1, maxSegments));
  let combined = limited.join('\n\n');
  if (combined.length > maxChars) {
    combined = `${combined.slice(0, maxChars - 1)}…`;
  }
  return combined;
}

function tokenizeForComparison(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && token.length > 2 && !TOKEN_STOP_WORDS.has(token))
    .slice(0, 20);
}

function estimateTokenCount(text) {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  return text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean).length;
}

function truncateContentToBytes(text, maxBytes) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return '';
  }

  let buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return text;
  }

  buffer = buffer.slice(0, maxBytes);
  let truncated = buffer.toString('utf8');

  // Handle potential partial multi-byte at the end.
  while (truncated.length && Buffer.byteLength(truncated, 'utf8') > maxBytes) {
    truncated = truncated.slice(0, -1);
  }

  return truncated;
}

function isLikelyBinary(text) {
  if (!text) {
    return false;
  }

  const length = Math.min(text.length, 1024);
  let suspicious = 0;
  for (let index = 0; index < length; index += 1) {
    const charCode = text.charCodeAt(index);
    if (charCode === 0) {
      return true;
    }
    if (charCode < 32 && charCode !== 9 && charCode !== 10 && charCode !== 13) {
      suspicious += 1;
      if (suspicious / length > 0.05) {
        return true;
      }
    }
  }

  return false;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function buildQueriesFromFocusTerms(terms, fallbackPrompt, initialGoal) {
  const unique = Array.from(new Set((terms || []).map((term) => term.trim()).filter(Boolean)));
  if (!unique.length) {
    const base = fallbackPrompt || initialGoal;
    return base ? [base] : [];
  }

  const queries = [];
  if (unique.length === 1) {
    queries.push(unique[0]);
  } else {
    queries.push(unique.join(' '));
    unique.slice(0, 3).forEach((term) => queries.push(term));
  }

  if (fallbackPrompt) {
    queries.push(fallbackPrompt);
  }

  if (initialGoal) {
    queries.push(initialGoal);
  }

  return queries.slice(0, 4);
}

function analyzeConversationGrounding(chat, prompt) {
  const empty = {
    confidence: 0,
    coverageRatio: 0,
    missingTerms: [],
    promptTokens: [],
    longRunning: false,
    assistantTurns: 0,
    hasStoredContext: false,
    lastContextAgeMinutes: null,
  };

  if (!chat || !Array.isArray(chat.messages) || !prompt) {
    return empty;
  }

  const promptTokens = tokenizeForComparison(prompt);
  if (!promptTokens.length) {
    return { ...empty, promptTokens };
  }

  const assistantMessages = chat.messages.filter((message) => message?.role === 'assistant');
  const assistantTurns = assistantMessages.length;
  const longRunning = assistantTurns >= 3 || (chat.messages || []).length >= 6;

  const coverageTokens = new Set();
  const lookbackWindow = Math.max(0, chat.messages.length - 12);

  for (let index = lookbackWindow; index < chat.messages.length; index += 1) {
    const message = chat.messages[index];
    if (!message || !message.content) {
      continue;
    }

    tokenizeForComparison(message.content).forEach((token) => coverageTokens.add(token));

    if (message.meta?.context) {
      tokenizeForComparison(message.meta.context).forEach((token) => coverageTokens.add(token));
    }
  }

  const missingTerms = promptTokens.filter((token) => !coverageTokens.has(token));
  const coverageRatio = promptTokens.length
    ? (promptTokens.length - missingTerms.length) / promptTokens.length
    : 0;

  const lastAssistant = [...assistantMessages].reverse().find(Boolean) || null;
  const hasStoredContext = Boolean(lastAssistant?.meta?.context && lastAssistant.meta.context.trim());
  const retrievedAt = lastAssistant?.meta?.contextRetrievedAt || null;
  let lastContextAgeMinutes = null;
  if (retrievedAt) {
    const retrievedTimestamp = new Date(retrievedAt).getTime();
    if (Number.isFinite(retrievedTimestamp)) {
      lastContextAgeMinutes = Math.max(
        0,
        Math.floor((Date.now() - retrievedTimestamp) / (1000 * 60))
      );
    }
  }

  let confidence = 0;
  if (longRunning) {
    confidence += 0.35;
  }
  if (assistantTurns >= 6) {
    confidence += 0.15;
  } else if (assistantTurns >= 3) {
    confidence += 0.1;
  }

  if (coverageRatio >= 0.8) {
    confidence += 0.4;
  } else if (coverageRatio >= 0.6) {
    confidence += 0.28;
  } else if (coverageRatio >= 0.45) {
    confidence += 0.15;
  }

  if (hasStoredContext) {
    confidence += 0.12;
  }

  if (lastContextAgeMinutes !== null) {
    if (lastContextAgeMinutes <= 30) {
      confidence += 0.05;
    } else if (lastContextAgeMinutes >= 240) {
      confidence -= 0.08;
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));

  return {
    confidence,
    coverageRatio,
    missingTerms,
    promptTokens,
    longRunning,
    assistantTurns,
    hasStoredContext,
    lastContextAgeMinutes,
  };
}

function appendContextSection(existing, addition) {
  const base = existing && existing.trim() ? existing.trim() : '';
  const extra = addition && addition.trim() ? addition.trim() : '';
  if (!base) {
    return extra;
  }
  if (!extra) {
    return base;
  }
  return `${base}\n\n---\n\n${extra}`;
}

function buildConversationDigest(chat, maxLength = 1400) {
  if (!chat || !Array.isArray(chat.messages) || !chat.messages.length) {
    return '';
  }

  const relevant = chat.messages
    .filter((message) => message?.content && (message.role === 'assistant' || message.role === 'user'))
    .slice(-10);

  if (!relevant.length) {
    return '';
  }

  const lines = relevant.map((message) => {
    const prefix = message.role === 'assistant' ? 'Assistant' : 'User';
    const normalized = message.content.replace(/\s+/g, ' ').trim();
    return `${prefix}: ${normalized}`;
  });

  let digest = lines.join('\n');
  if (digest.length > maxLength) {
    digest = digest.slice(digest.length - maxLength);
    const firstNewline = digest.indexOf('\n');
    if (firstNewline !== -1) {
      digest = digest.slice(firstNewline + 1);
    }
  }

  return digest.trim();
}

function extractSearchDirective(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) {
    return null;
  }

  const match = trimmed.match(/\[\[search:\s*(.+?)\s*\]\]/i);
  if (!match || !match[1]) {
    return null;
  }

  const before = trimmed.slice(0, match.index).trim();
  const after = trimmed.slice(match.index + match[0].length).trim();
  if (before || after) {
    return null;
  }

  return match[1].trim();
}

function flattenReasoningPayload(payload, seen = new Set()) {
  if (payload === null || payload === undefined) {
    return '';
  }

  if (typeof payload === 'string') {
    return payload;
  }

  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return String(payload);
  }

  if (Array.isArray(payload)) {
    return payload
      .map((item) => flattenReasoningPayload(item, seen))
      .filter(Boolean)
      .join('\n');
  }

  if (typeof payload === 'object') {
    if (seen.has(payload)) {
      return '';
    }
    seen.add(payload);

    const preferredKeys = ['text', 'thought', 'output', 'content', 'explanation'];
    for (const key of preferredKeys) {
      if (payload[key]) {
        const value = flattenReasoningPayload(payload[key], seen);
        if (value) {
          return value;
        }
      }
    }

    if (payload.reasoning && payload.reasoning !== payload) {
      const inner = flattenReasoningPayload(payload.reasoning, seen);
      if (inner) {
        return inner;
      }
    }

    const merged = Object.values(payload)
      .map((value) => flattenReasoningPayload(value, seen))
      .filter(Boolean)
      .join('\n');

    return merged;
  }

  return '';
}
