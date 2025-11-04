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
  sidebarCollapsed: false,
  showTutorial: true,
  shareAnalytics: true,
  ollamaEndpoint: 'http://localhost:11434',
  analyticsDeviceId: null,
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

const MAX_ATTACHMENTS_PER_PROMPT = 4;
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
    const res = await fetch(buildOllamaUrl('/api/tags'));
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
          reason: `Only ${MAX_ATTACHMENTS_PER_PROMPT} files are allowed per prompt. Remove an attachment before adding more.`,
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
          reason: `Only ${MAX_ATTACHMENTS_PER_PROMPT} files are allowed per prompt. Remove an attachment before adding more.`,
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

ipcMain.handle('ask-ollama', async (event, { chatId, model, prompt, requestId, userLinks = [], attachments = [] }) => {
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
  const ollamaBaseUrl = normalizeOllamaEndpoint(effectiveSettings.ollamaEndpoint);
  const buildOllamaApiUrl = (suffix) => {
    const cleanPath = suffix && suffix.startsWith('/') ? suffix : `/${suffix || ''}`;
    return `${ollamaBaseUrl}${cleanPath}`;
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

  if (!searchPlan.disabled) {
    if (!Array.isArray(searchPlan.queries) || !searchPlan.queries.length) {
      const fallbackQuery = searchPrompt || prompt;
      if (fallbackQuery && fallbackQuery.trim()) {
        searchPlan.queries = [fallbackQuery.trim()];
      }
    }
    searchPlan.shouldSearch = true;
    if (!searchPlan.message) {
      searchPlan.message = 'Gathering fresh web context for this request.';
    }
  }

  const conversationFirst =
    !searchPlan.shouldSearch && !searchPlan.disabled && conversationAnalysis.confidence >= 0.65;

  let contextResult = { text: '', entries: [], queries: [], retrievedAt: null, userLinks: [] };
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

  let allowSearch = !searchPlan.disabled && searchPlan.queries.length > 0 && goalAligned;
  let skippedForOffline = false;

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
    if (!goalAligned) {
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

    const response = await fetch(buildOllamaApiUrl('/api/chat'), {
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
      throw new Error(`Ollama API error: HTTP ${response.status}`);
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

      if (parsed?.message?.content) {
        let chunkText = parsed.message.content;
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

    if (parsed?.done) {
      flushDirectiveBuffer();
      tStreamEnd = Date.now();
      emitUpdate({ delta: '', done: true, force: true });
    }
  };

    const processLine = (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const parsed = JSON.parse(line);
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

    console.error('Error querying Ollama:', err);
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

  if (partial.sidebarCollapsed !== undefined) {
    next.sidebarCollapsed = Boolean(partial.sidebarCollapsed);
  }

  if (partial.showTutorial !== undefined) {
    next.showTutorial = Boolean(partial.showTutorial);
  }

  if (partial.shareAnalytics !== undefined) {
    next.shareAnalytics = Boolean(partial.shareAnalytics);
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
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&ia=web`;
      const res = await fetchWithTimeout(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
        },
      }, searchTimeout);

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
