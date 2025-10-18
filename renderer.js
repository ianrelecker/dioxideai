const urlRegex = /https?:\/\/[^\s]+/gi;

let modelSelect;
let refreshModelsButton;
let chatTitleEl;
let chatListNav;
let newChatButton;
let chatArea;
let promptInput;
let inputForm;
let sendButton;
let sidebarToggleBtn;
let webSearchToggleBtn;
let settingsButton;
let settingsOverlay;
let settingsPanel;
let settingsCloseButton;
let settingsForm;
let autoWebSearchToggle;
let openThoughtsToggle;
let searchResultLimitInput;
let searchResultValue;
let themeSelect;
let sidebarCollapseToggle;

const DEFAULT_SETTINGS = {
  autoWebSearch: true,
  openThoughtsByDefault: false,
  searchResultLimit: 6,
  theme: 'system',
  sidebarCollapsed: false,
};

const state = {
  chats: [],
  currentChatId: null,
  currentChat: null,
  pendingAssistantByChat: new Map(),
  isStreaming: false,
  settings: { ...DEFAULT_SETTINGS },
  settingsPanelOpen: false,
  activeRequestId: null,
  activeAssistantEntry: null,
};

const prefersDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

const createRequestId = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function extractLinks(input) {
  if (!input) {
    return [];
  }

  const matches = input.match(urlRegex) || [];
  const unique = new Set(matches.map((link) => link.trim()));
  return Array.from(unique);
}

function stopGeneration(requestId) {
  if (!requestId) {
    return Promise.resolve();
  }

  return window.api.cancelOllama({ requestId });
}

window.addEventListener('DOMContentLoaded', async () => {

  modelSelect = document.getElementById('modelSelect');
  refreshModelsButton = document.getElementById('refreshModels');
  chatTitleEl = document.getElementById('chatTitle');
  chatListNav = document.getElementById('chatList');
  newChatButton = document.getElementById('newChatBtn');
  chatArea = document.getElementById('chatArea');
  promptInput = document.getElementById('promptInput');
  inputForm = document.getElementById('inputForm');
  sendButton = document.getElementById('sendBtn');
  sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
  webSearchToggleBtn = document.getElementById('webSearchToggleBtn');
  settingsButton = document.getElementById('settingsBtn');
  settingsOverlay = document.getElementById('settingsOverlay');
  settingsPanel = document.getElementById('settingsPanel');
  settingsCloseButton = document.getElementById('settingsCloseBtn');
  settingsForm = document.getElementById('settingsForm');
  autoWebSearchToggle = document.getElementById('autoWebSearchToggle');
  openThoughtsToggle = document.getElementById('openThoughtsToggle');
  searchResultLimitInput = document.getElementById('searchResultLimit');
  searchResultValue = document.getElementById('searchResultValue');
  themeSelect = document.getElementById('themeSelect');
  sidebarCollapseToggle = document.getElementById('sidebarCollapseToggle');


  try {
    registerStreamHandlers();
    registerUIListeners();
    updateInteractivity();
    await loadSettings();
    await populateModels();
    await initializeChats();
    promptInput.focus();
  } catch (error) {
    console.error('Initialization failed:', error);
  }
});

async function initializeChats() {
  await refreshChatList();

  if (state.chats.length) {
    await selectChat(state.chats[0].id);
  } else {
    await handleNewChat();
  }
}

function registerUIListeners() {
  refreshModelsButton.addEventListener('click', populateModels);

  newChatButton.addEventListener('click', async () => {
    if (state.isStreaming) {
      return;
    }
    await handleNewChat();
  });

  inputForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await handlePromptSubmit();
  });

  promptInput.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    if (!state.isStreaming) {
      await handlePromptSubmit();
    }
  });

  sidebarToggleBtn?.addEventListener('click', () => {
    const nextValue = !(state.settings?.sidebarCollapsed ?? false);
    updateSidebarState(nextValue);
    applySettingsUpdate({ sidebarCollapsed: nextValue });
  });

  settingsButton?.addEventListener('click', openSettingsPanel);
  settingsCloseButton?.addEventListener('click', closeSettingsPanel);
  settingsOverlay?.addEventListener('click', (event) => {
    if (
      event.target === settingsOverlay ||
      (event.target.classList && event.target.classList.contains('settings-backdrop'))
    ) {
      closeSettingsPanel();
    }
  });
  settingsPanel?.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  settingsForm?.addEventListener('submit', (event) => event.preventDefault());
  autoWebSearchToggle?.addEventListener('change', () =>
    applySettingsUpdate({ autoWebSearch: autoWebSearchToggle.checked })
  );
  webSearchToggleBtn?.addEventListener('click', handleQuickWebSearchToggle);
  openThoughtsToggle?.addEventListener('change', () =>
    applySettingsUpdate({ openThoughtsByDefault: openThoughtsToggle.checked })
  );
  themeSelect?.addEventListener('change', () => {
    const nextTheme = themeSelect.value;
    applyTheme(nextTheme);
    applySettingsUpdate({ theme: nextTheme });
  });
  sidebarCollapseToggle?.addEventListener('change', () => {
    const next = sidebarCollapseToggle.checked;
    updateSidebarState(next);
    applySettingsUpdate({ sidebarCollapsed: next });
  });
  searchResultLimitInput?.addEventListener('input', () =>
    updateSearchResultLabel(Number(searchResultLimitInput.value))
  );
  searchResultLimitInput?.addEventListener('change', () =>
    applySettingsUpdate({ searchResultLimit: Number(searchResultLimitInput.value) })
  );




  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.settingsPanelOpen) {
      closeSettingsPanel();
    }
  });
}

async function loadSettings() {
  try {
    const prefs = await window.api.getSettings();
    state.settings = { ...DEFAULT_SETTINGS, ...prefs };
  } catch (err) {
    console.error('Failed to load settings:', err);
    state.settings = state.settings || { ...DEFAULT_SETTINGS };
  }

  applySettingsToUI();
}

function applySettingsToUI() {
  const prefs = state.settings || DEFAULT_SETTINGS;

  if (autoWebSearchToggle) {
    autoWebSearchToggle.checked = Boolean(prefs.autoWebSearch);
  }
  updateWebSearchButton(Boolean(prefs.autoWebSearch));

  if (openThoughtsToggle) {
    openThoughtsToggle.checked = Boolean(prefs.openThoughtsByDefault);
  }

  const limit = clampSearchLimitForUI(prefs.searchResultLimit);
  if (searchResultLimitInput) {
    searchResultLimitInput.value = String(limit);
  }
  updateSearchResultLabel(limit);

  if (themeSelect) {
    themeSelect.value = prefs.theme || 'system';
  }

  if (sidebarCollapseToggle) {
    sidebarCollapseToggle.checked = Boolean(prefs.sidebarCollapsed);
  }

  updateSidebarState(Boolean(prefs.sidebarCollapsed));
  applyTheme(prefs.theme || DEFAULT_SETTINGS.theme);
}

function openSettingsPanel() {
  applySettingsToUI();
  settingsOverlay.classList.remove('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('settings-open');
  state.settingsPanelOpen = true;
  settingsButton.setAttribute('aria-expanded', 'true');
  if (settingsPanel) {
    settingsPanel.setAttribute('tabindex', '-1');
    settingsPanel.focus();
  }
}

function closeSettingsPanel() {
  settingsOverlay.classList.add('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('settings-open');
  state.settingsPanelOpen = false;
  settingsButton.setAttribute('aria-expanded', 'false');
  if (typeof settingsButton.focus === 'function') {
    settingsButton.focus();
  }
  updateInteractivity();
}

async function applySettingsUpdate(partial) {
  try {
    const updated = await window.api.updateSettings(partial);
    state.settings = { ...DEFAULT_SETTINGS, ...updated };
    applySettingsToUI();
  } catch (err) {
    console.error('Failed to update settings:', err);
  }
}

function handleQuickWebSearchToggle() {
  const nextValue = !(state.settings?.autoWebSearch ?? true);
  updateWebSearchButton(nextValue);
  applySettingsUpdate({ autoWebSearch: nextValue });
}

function updateWebSearchButton(enabled) {
  if (!webSearchToggleBtn) {
    return;
  }
  webSearchToggleBtn.setAttribute('aria-pressed', String(Boolean(enabled)));
  webSearchToggleBtn.textContent = enabled ? 'Web Search: On' : 'Web Search: Off';
  webSearchToggleBtn.classList.toggle('off', !enabled);
}

function updateSearchResultLabel(value) {
  if (!searchResultValue) {
    return;
  }
  searchResultValue.textContent = String(clampSearchLimitForUI(value));
}

function clampSearchLimitForUI(value) {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : DEFAULT_SETTINGS.searchResultLimit;
  return Math.max(1, Math.min(12, Math.round(numeric)));
}

function registerStreamHandlers() {
  window.api.onStream((data) => {
    const entry = state.pendingAssistantByChat.get(data.chatId);
    if (!entry) {
      return;
    }

    if (data.error) {
      entry.clearActions();
      entry.setContent(data.error);
      entry.setSummary('Error');
      entry.setThought(data.error);
      entry.openThoughts();
      state.pendingAssistantByChat.delete(data.chatId);
      state.isStreaming = false;
      state.activeRequestId = null;
      state.activeAssistantEntry = null;
      updateInteractivity();
      return;
    }

    if (data.aborted) {
      entry.clearActions();
      entry.setContent('Generation stopped.');
      entry.setSummary('Notes');
      entry.openThoughts();
      entry.setThought('Generation canceled by user.');
      state.pendingAssistantByChat.delete(data.chatId);
      state.isStreaming = false;
      state.activeRequestId = null;
      state.activeAssistantEntry = null;
      updateInteractivity();
      return;
    }

    if (typeof data.full === 'string') {
      entry.setContent(data.full);
    }

    if (data.done) {
      entry.clearActions();
      state.pendingAssistantByChat.delete(data.chatId);
      state.isStreaming = false;
      state.activeRequestId = null;
      state.activeAssistantEntry = null;
      updateInteractivity();
    }
  });

  window.api.onThinking((data) => {
    const entry = state.pendingAssistantByChat.get(data.chatId);
    if (!entry) {
      return;
    }

    if (data.stage === 'search-plan' || data.stage === 'search-started') {
      entry.setSummary('Notes');
      entry.setThought(
        formatSearchPlanThought({
          message: data.message || 'Preparing web search queries.',
          queries: data.queries,
        })
      );
    } else if (data.stage === 'context') {
      const hasContext = Boolean(data.context?.trim());
      entry.setSummary(hasContext ? 'Web Context' : 'Notes');
      entry.setThought(
        formatContextThought({
          message: data.context?.trim()
            ? data.message || 'Context gathered from the web.'
            : data.message || 'No additional context used.',
          context: data.context,
          queries: data.queries,
          retrievedAt: data.retrievedAt,
        })
      );
      entry.closeThoughts();
    }
  });
}

async function populateModels() {
  setModelControlsDisabled(true);

  try {
    const models = await window.api.getModels();
    modelSelect.innerHTML = '';

    if (!models.length) {
      const option = document.createElement('option');
      option.textContent = 'No models found';
      option.value = '';
      option.disabled = true;
      option.selected = true;
      modelSelect.appendChild(option);
      return;
    }

    models.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      modelSelect.appendChild(option);
    });
  } catch (err) {
    console.error(err);
    modelSelect.innerHTML = '';
    const option = document.createElement('option');
    option.textContent = 'Failed to load models';
    option.value = '';
    option.disabled = true;
    option.selected = true;
    modelSelect.appendChild(option);
  } finally {
    setModelControlsDisabled(false);
  }
}

async function handlePromptSubmit() {
  if (state.isStreaming) {
    return;
  }

  const prompt = promptInput.value.trim();
  if (!prompt) {
    return;
  }

  if (!state.currentChatId) {
    await handleNewChat();
  }

  const chatId = state.currentChatId;
  const model = modelSelect.value;

  if (!model) {
    modelSelect.classList.add('attention');
    modelSelect.focus();
    setTimeout(() => modelSelect.classList.remove('attention'), 800);
    return;
  }

  appendUserMessage(prompt);
  recordUserMessage(prompt);

  promptInput.value = '';
  promptInput.focus();

  state.isStreaming = true;
  updateInteractivity();

  const requestId = createRequestId();
  const userLinks = extractLinks(prompt);

  const assistantEntry = appendAssistantMessage('Thinking…', {
    open: false,
    thoughts: 'Preparing response…',
    summary: 'Notes',
  });

  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.classList.add('stop-generation-btn');
  stopButton.textContent = 'Stop';
  stopButton.setAttribute('aria-label', 'Stop generating response');
  stopButton.addEventListener('click', () => {
    if (stopButton.disabled) {
      return;
    }
    stopButton.disabled = true;
    stopButton.textContent = 'Stopping…';
    stopGeneration(requestId).catch((err) => {
      console.error('Failed to cancel generation:', err);
      stopButton.disabled = false;
      stopButton.textContent = 'Stop';
    });
  });
  assistantEntry.addActionButton(stopButton);

  state.pendingAssistantByChat.set(chatId, assistantEntry);
  state.activeRequestId = requestId;
  state.activeAssistantEntry = assistantEntry;

  try {
    const result = await window.api.askOllama({
      chatId,
      model,
      prompt,
      requestId,
      userLinks,
    });

    assistantEntry.clearActions();
    state.activeRequestId = null;
    state.activeAssistantEntry = null;

    if (result?.aborted) {
      assistantEntry.setContent('Generation stopped.');
      assistantEntry.setSummary('Notes');
      assistantEntry.openThoughts();
      assistantEntry.setThought('Generation canceled by user.');
      state.pendingAssistantByChat.delete(chatId);
      state.isStreaming = false;
      updateInteractivity();
      return;
    }

    if (result?.error) {
      assistantEntry.clearActions();
      assistantEntry.setContent(result.error);
      assistantEntry.setSummary('Error');
      assistantEntry.openThoughts();
      assistantEntry.setThought(result.error);
      state.pendingAssistantByChat.delete(chatId);
      state.isStreaming = false;
      updateInteractivity();
      return;
    }

    const hasContext = Boolean(result.context);
    const contextSummary = hasContext ? 'Web Context' : 'Notes';
    assistantEntry.setSummary(contextSummary);
    assistantEntry.setThought(
      formatContextThought({
        message: result.context
          ? 'Context applied to compose the answer.'
          : 'No additional context used.',
        context: result.context,
        queries: result.contextQueries,
        retrievedAt: result.contextRetrievedAt,
      })
    );
    if (hasContext) {
      assistantEntry.closeThoughts();
    }

    recordAssistantMessage(
      result.answer,
      {
        context: result.context,
        queries: result.contextQueries,
        retrievedAt: result.contextRetrievedAt,
        links: result.userLinks,
      },
      model
    );
    state.pendingAssistantByChat.delete(chatId);
    state.isStreaming = false;
    updateInteractivity();
    await refreshChatList(chatId);
    updateChatTitle();
  } catch (err) {
    console.error(err);
    assistantEntry.clearActions();
    assistantEntry.setContent('Error: Unable to get response');
    assistantEntry.setSummary('Error');
    assistantEntry.openThoughts();
    assistantEntry.setThought(err.message || 'Unknown error');
    state.pendingAssistantByChat.delete(chatId);
    state.isStreaming = false;
    state.activeRequestId = null;
    state.activeAssistantEntry = null;
    updateInteractivity();
  }
}

async function refreshChatList(selectedId = state.currentChatId) {
  state.chats = await window.api.listChats();
  renderChatList(selectedId);
}

async function handleNewChat() {
  const model = modelSelect.value || null;
  const chat = await window.api.createChat(model);
  state.currentChat = chat;
  state.currentChatId = chat.id;
  state.chats.unshift({
    id: chat.id,
    title: chat.title,
    model: chat.model,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  });
  renderChatList(chat.id);
  renderChat(chat);
  promptInput.focus();
}

async function selectChat(chatId) {
  if (state.isStreaming) {
    return;
  }

  if (state.currentChatId === chatId) {
    return;
  }

  const chat = await window.api.getChat(chatId);
  if (!chat) {
    return;
  }

  state.currentChatId = chat.id;
  state.currentChat = chat;
  renderChatList(chatId);
  renderChat(chat);
}

function renderChat(chat) {
  updateChatTitle();
  if (!chat.messages?.length) {
    chatArea.innerHTML = '';
    const empty = document.createElement('div');
    empty.classList.add('empty-state');
    empty.innerHTML = `
      <p>Start a conversation by selecting a model and asking a question.</p>
      <small>Your chats are saved locally and appear here.</small>
    `;
    chatArea.appendChild(empty);
    return;
  }

  chatArea.innerHTML = '';
  chat.messages.forEach((message) => {
    if (message.role === 'user') {
      appendUserMessage(message.content);
    } else {
      const usedWeb = Boolean(message.meta?.usedWebSearch);
      appendAssistantMessage(message.content, {
        open: false,
        thoughts: formatStoredContext(message.meta),
        summary: usedWeb ? 'Web Context' : 'Notes',
      });
    }
  });
}

function renderChatList(activeId) {
  chatListNav.innerHTML = '';

  if (!state.chats.length) {
    const empty = document.createElement('div');
    empty.classList.add('chat-item');
    empty.textContent = 'No chats yet.';
    empty.style.opacity = '0.6';
    chatListNav.appendChild(empty);
    return;
  }

  state.chats.forEach((chat) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.classList.add('chat-item');
    if (chat.id === activeId) {
      item.classList.add('active');
    }

    const title = document.createElement('div');
    title.classList.add('chat-item-title');
    title.textContent = chat.title || 'New Chat';

    const meta = document.createElement('div');
    meta.classList.add('chat-item-meta');
    meta.textContent = formatChatMeta(chat);

    item.appendChild(title);
    item.appendChild(meta);
    item.addEventListener('click', () => selectChat(chat.id));
    chatListNav.appendChild(item);
  });
}

function appendUserMessage(content) {
  const container = document.createElement('div');
  container.classList.add('message', 'user');

  const text = document.createElement('div');
  text.classList.add('message-text');
  text.textContent = content;

  container.appendChild(text);
  chatArea.appendChild(container);
  chatArea.scrollTop = chatArea.scrollHeight;
  return container;
}

function appendAssistantMessage(content, options = {}) {
  const openDefault = state.settings?.openThoughtsByDefault ?? false;
  const {
    open = openDefault,
    thoughts = '',
    summary = 'Notes',
  } = options;

  const container = document.createElement('div');
  container.classList.add('message', 'bot');

  const text = document.createElement('div');
  text.classList.add('message-text');
  setMessageContent(text, content);
  container.appendChild(text);

  const actions = document.createElement('div');
  actions.classList.add('message-actions');
  actions.style.display = 'none';
  container.appendChild(actions);

  const details = document.createElement('details');
  details.classList.add('thoughts');
  details.open = open;

  const summaryEl = document.createElement('summary');
  summaryEl.textContent = summary;
  details.appendChild(summaryEl);

  const thoughtsText = document.createElement('pre');
  thoughtsText.classList.add('thoughts-text');
  thoughtsText.textContent = thoughts || 'No additional context used.';
  details.appendChild(thoughtsText);

  container.appendChild(details);

  chatArea.appendChild(container);
  chatArea.scrollTop = chatArea.scrollHeight;

  return {
    container,
    setContent: (value) => {
      setMessageContent(text, value);
    },
    setSummary: (value) => {
      summaryEl.textContent = value || 'Notes';
    },
    setThought: (value) => {
      thoughtsText.textContent = value?.trim()
        ? value.trim()
        : 'No additional context used.';
    },
    openThoughts: () => {
      details.open = true;
    },
    closeThoughts: () => {
      details.open = false;
    },
    addActionButton: (button) => {
      actions.style.display = 'flex';
      actions.appendChild(button);
    },
    clearActions: () => {
      actions.innerHTML = '';
      actions.style.display = 'none';
    },
  };
}

function recordUserMessage(content) {
  if (!state.currentChat) {
    return;
  }
  state.currentChat.messages = state.currentChat.messages || [];
  state.currentChat.messages.push({
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  });
  if (!state.currentChat.title || state.currentChat.title === 'New Chat') {
    state.currentChat.title = truncate(content, 60);
    const summary = state.chats.find((chat) => chat.id === state.currentChatId);
    if (summary) {
      summary.title = state.currentChat.title;
    }
    renderChatList(state.currentChatId);
    updateChatTitle();
  }
}

function recordAssistantMessage(content, contextData, model) {
  if (!state.currentChat) {
    return;
  }
  state.currentChat.messages = state.currentChat.messages || [];
  const timestamp = new Date().toISOString();
  const contextText = contextData?.context || '';
  const contextQueries = contextData?.queries || [];
  const contextRetrievedAt = contextData?.retrievedAt || null;

  state.currentChat.messages.push({
    role: 'assistant',
    content,
    createdAt: timestamp,
    meta: {
      context: contextText,
      contextQueries,
      contextRetrievedAt,
      usedWebSearch: Boolean(contextText),
      userLinks: contextData?.links || [],
    },
  });
  state.currentChat.model = model;
  state.currentChat.updatedAt = timestamp;

  const summary = state.chats.find((chat) => chat.id === state.currentChatId);
  if (summary) {
    summary.model = model;
    summary.updatedAt = timestamp;
  }
}

function updateChatTitle() {
  if (!state.currentChat) {
    chatTitleEl.textContent = '';
    return;
  }

  const title = state.currentChat.title || 'New Chat';
  const model = state.currentChat.model || modelSelect.value || 'Select a model';
  chatTitleEl.textContent = `${title} • ${model}`;
}

function setModelControlsDisabled(disabled) {
  modelSelect.disabled = disabled;
  refreshModelsButton.disabled = disabled;
}

function updateInteractivity() {
  promptInput.disabled = state.isStreaming;
  sendButton.disabled = state.isStreaming;
  newChatButton.disabled = state.isStreaming;
  if (webSearchToggleBtn) {
    webSearchToggleBtn.disabled = state.isStreaming;
  }
  if (sidebarToggleBtn) {
    sidebarToggleBtn.disabled = state.isStreaming;
  }
  if (!state.settingsPanelOpen) {
    settingsButton.disabled = state.isStreaming;
  }
  if (state.isStreaming) {
    chatListNav.classList.add('disabled');
  } else {
    chatListNav.classList.remove('disabled');
    if (!state.settingsPanelOpen) {
      settingsButton.disabled = false;
    }
    if (sidebarToggleBtn) {
      sidebarToggleBtn.disabled = false;
    }
  }
}

function formatSearchPlanThought({ message, queries }) {
  const lines = [];
  if (message) {
    lines.push(message);
  }
  if (queries?.length) {
    lines.push('', 'Queries:');
    queries.forEach((query) => {
      lines.push(`• ${query}`);
    });
  }
  return lines.join('\n').trim() || 'Preparing web search queries.';
}

function formatContextThought({ message, context, queries, retrievedAt }) {
  const lines = [];
  const hasEmbeddedQueries =
    typeof context === 'string' && context.toLowerCase().includes('queries used:');
  const hasEmbeddedTimestamp =
    typeof context === 'string' && context.toLowerCase().includes('fresh context collected');
  if (message) {
    lines.push(message);
  }
  if (retrievedAt && !hasEmbeddedTimestamp) {
    lines.push(`Retrieved: ${formatTimestamp(retrievedAt)}`);
  }
  if (context?.trim()) {
    lines.push('', context.trim());
  }
  if (queries?.length && !hasEmbeddedQueries) {
    lines.push('', 'Queries:');
    queries.forEach((query) => {
      lines.push(`• ${query}`);
    });
  }
  return lines.join('\n').trim() || 'No additional context used.';
}

function formatStoredContext(meta = {}) {
  const hasQueries = Array.isArray(meta.contextQueries) && meta.contextQueries.length > 0;
  const hasLinks = Array.isArray(meta.userLinks) && meta.userLinks.length > 0;
  let context = meta.context;

  if ((!context || !context.trim()) && hasLinks) {
    context = ['User-provided links:', ...meta.userLinks.map((link) => `• ${link}`)].join('\n');
  }

  return formatContextThought({
    message: meta.usedWebSearch
      ? 'Context used when drafting this reply.'
      : hasLinks
        ? 'User-provided links supplied by the user.'
        : hasQueries
          ? 'Web search disabled (saved candidate queries).'
          : 'No additional context used.',
    context,
    queries: meta.contextQueries,
    retrievedAt: meta.contextRetrievedAt,
  });
}

function formatTimestamp(isoString) {
  if (!isoString) {
    return '';
  }
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch (err) {
    return isoString;
  }
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

function formatChatMeta(chat) {
  const updated = chat.updatedAt ? new Date(chat.updatedAt) : null;
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const when = updated ? formatter.format(updated) : '';
  const model = chat.model || 'No model';
  return `${model} • ${when}`;
}

function setMessageContent(element, value) {
  const content = value ?? '';
  try {
    const maybeRendered = window.api.renderMarkdown
      ? window.api.renderMarkdown(content)
      : content;

    if (maybeRendered && typeof maybeRendered.then === 'function') {
      maybeRendered
        .then((rendered) => applyRenderedContent(element, rendered))
        .catch((err) => {
          console.error('Failed to render markdown:', err);
          element.textContent = content;
        });
    } else {
      applyRenderedContent(element, maybeRendered);
    }
  } catch (err) {
    console.error('Failed to render markdown:', err);
    element.textContent = content;
  }
}

function applyRenderedContent(element, rendered) {
  const content = rendered != null ? String(rendered) : '';
  const containsHtml = /<\/?[a-z][\s\S]*>/i.test(content.trim());

  if (containsHtml) {
    element.innerHTML = content;
    pruneMarkdownWhitespace(element);
  } else {
    element.textContent = content;
  }

  element.querySelectorAll('a').forEach((anchor) => {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  });
}

function pruneMarkdownWhitespace(root) {
  if (!root || !root.childNodes) {
    return;
  }

  const nodesToRemove = [];
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue || '';
      const parentName = node.parentNode?.nodeName;
      if ((parentName === 'PRE' || parentName === 'CODE')) {
        return;
      }
      if (!value.trim() && /\n/.test(value)) {
        nodesToRemove.push(node);
      }
    } else if (
      node.nodeType === Node.ELEMENT_NODE &&
      node.firstChild &&
      node.nodeName !== 'PRE' &&
      node.nodeName !== 'CODE'
    ) {
      pruneMarkdownWhitespace(node);
    }
  });

  nodesToRemove.forEach((node) => {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
  });
}

function updateSidebarState(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  if (sidebarToggleBtn) {
    sidebarToggleBtn.setAttribute('aria-pressed', String(Boolean(collapsed)));
    sidebarToggleBtn.textContent = collapsed ? 'Show Chats' : 'Hide Chats';
  }
}

function applyTheme(themeSetting) {
  const resolved = resolveTheme(themeSetting);
  const themeClasses = ['theme-light', 'theme-dark', 'theme-cream'];
  themeClasses.forEach((className) => {
    const suffix = className.replace('theme-', '');
    document.body.classList.toggle(className, resolved === suffix);
  });
}

function resolveTheme(themeSetting) {
  if (themeSetting === 'system') {
    return prefersDark && prefersDark.matches ? 'dark' : 'light';
  }
  const allowed = ['light', 'dark', 'cream'];
  return allowed.includes(themeSetting) ? themeSetting : 'light';
}





if (prefersDark) {
  const systemThemeListener = () => applyTheme(state.settings?.theme || DEFAULT_SETTINGS.theme);
  if (typeof prefersDark.addEventListener === 'function') {
    prefersDark.addEventListener('change', systemThemeListener);
  } else if (typeof prefersDark.addListener === 'function') {
    prefersDark.addListener(systemThemeListener);
  }
}
