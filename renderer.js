const modelSelect = document.getElementById('modelSelect');
const refreshModelsButton = document.getElementById('refreshModels');
const chatTitleEl = document.getElementById('chatTitle');
const chatListNav = document.getElementById('chatList');
const newChatButton = document.getElementById('newChatBtn');
const chatArea = document.getElementById('chatArea');
const promptInput = document.getElementById('promptInput');
const inputForm = document.getElementById('inputForm');
const sendButton = document.getElementById('sendBtn');
const webSearchToggleBtn = document.getElementById('webSearchToggleBtn');
const settingsButton = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsPanel = document.getElementById('settingsPanel');
const settingsCloseButton = document.getElementById('settingsCloseBtn');
const settingsForm = document.getElementById('settingsForm');
const autoWebSearchToggle = document.getElementById('autoWebSearchToggle');
const openThoughtsToggle = document.getElementById('openThoughtsToggle');
const searchResultLimitInput = document.getElementById('searchResultLimit');
const searchResultValue = document.getElementById('searchResultValue');

const DEFAULT_SETTINGS = {
  autoWebSearch: true,
  openThoughtsByDefault: false,
  searchResultLimit: 6,
};

const state = {
  chats: [],
  currentChatId: null,
  currentChat: null,
  pendingAssistantByChat: new Map(),
  isStreaming: false,
  settings: { ...DEFAULT_SETTINGS },
  settingsPanelOpen: false,
};

window.addEventListener('DOMContentLoaded', async () => {
  registerStreamHandlers();
  registerUIListeners();
  updateInteractivity();
  await loadSettings();
  await populateModels();
  await initializeChats();
  promptInput.focus();
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
      entry.setContent(data.error);
      entry.setSummary('Error');
      entry.openThoughts();
      entry.setThought(data.error);
      state.pendingAssistantByChat.delete(data.chatId);
      state.isStreaming = false;
      updateInteractivity();
      return;
    }

    if (typeof data.full === 'string') {
      entry.setContent(data.full);
    }

    if (data.done) {
      state.pendingAssistantByChat.delete(data.chatId);
      state.isStreaming = false;
      updateInteractivity();
    }
  });

  window.api.onThinking((data) => {
    const entry = state.pendingAssistantByChat.get(data.chatId);
    if (!entry) {
      return;
    }

    if (data.stage === 'search-plan' || data.stage === 'search-started') {
      entry.setSummary('Thoughts · Planning search');
      entry.openThoughts();
      entry.setThought(
        formatSearchPlanThought({
          message: data.message || 'Preparing web search queries.',
          queries: data.queries,
        })
      );
    } else if (data.stage === 'context') {
      const summary = data.context ? 'Thoughts · Web context' : 'Thoughts · Model memory';
      entry.setSummary(summary);
      entry.openThoughts();
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

  const assistantEntry = appendAssistantMessage('Thinking…', {
    open: true,
    thoughts: 'Preparing response…',
    summary: 'Thoughts · Working',
  });

  state.pendingAssistantByChat.set(chatId, assistantEntry);

  try {
    const result = await window.api.askOllama({
      chatId,
      model,
      prompt,
    });

    if (result?.error) {
      assistantEntry.setContent(result.error);
      assistantEntry.setSummary('Error');
      assistantEntry.openThoughts();
      assistantEntry.setThought(result.error);
      state.pendingAssistantByChat.delete(chatId);
      state.isStreaming = false;
      updateInteractivity();
      return;
    }

    const contextSummary = result.context ? 'Thoughts · Web context' : 'Thoughts';
    assistantEntry.setSummary(contextSummary);
    assistantEntry.openThoughts();
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

    recordAssistantMessage(
      result.answer,
      {
        context: result.context,
        queries: result.contextQueries,
        retrievedAt: result.contextRetrievedAt,
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
    assistantEntry.setContent('Error: Unable to get response');
    assistantEntry.setSummary('Error');
    assistantEntry.openThoughts();
    assistantEntry.setThought(err.message || 'Unknown error');
    state.pendingAssistantByChat.delete(chatId);
    state.isStreaming = false;
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
        summary: usedWeb ? 'Thoughts · Web context' : 'Thoughts',
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
    summary = 'Thoughts',
  } = options;

  const container = document.createElement('div');
  container.classList.add('message', 'bot');

  const text = document.createElement('div');
  text.classList.add('message-text');
  text.textContent = content;
  container.appendChild(text);

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
      text.textContent = value;
    },
    setSummary: (value) => {
      summaryEl.textContent = value || 'Thoughts';
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
  return formatContextThought({
    message: meta.usedWebSearch
      ? 'Context used when drafting this reply.'
      : hasQueries
        ? 'Web search disabled (saved candidate queries).'
        : 'No additional context used.',
    context: meta.context,
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
