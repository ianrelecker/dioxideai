const modelSelect = document.getElementById('modelSelect');
const refreshModelsButton = document.getElementById('refreshModels');
const chatTitleEl = document.getElementById('chatTitle');
const chatListNav = document.getElementById('chatList');
const newChatButton = document.getElementById('newChatBtn');
const chatArea = document.getElementById('chatArea');
const promptInput = document.getElementById('promptInput');
const inputForm = document.getElementById('inputForm');
const sendButton = document.getElementById('sendBtn');

const state = {
  chats: [],
  currentChatId: null,
  currentChat: null,
  pendingAssistantByChat: new Map(),
  isStreaming: false,
};

window.addEventListener('DOMContentLoaded', async () => {
  registerStreamHandlers();
  registerUIListeners();
  updateInteractivity();
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

    if (data.stage === 'search-started') {
      entry.setSummary('Thoughts · Searching');
      entry.openThoughts();
      entry.setThought(data.message || 'Searching the web for context…');
    } else if (data.stage === 'context') {
      const summary = data.context ? 'Thoughts · Web context' : 'Thoughts · Model memory';
      entry.setSummary(summary);
      entry.openThoughts();
      entry.setThought(
        data.context?.trim()
          ? data.context.trim()
          : data.message || 'No additional context used.'
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

    assistantEntry.setSummary(result.context ? 'Thoughts · Web context' : 'Thoughts');
    assistantEntry.openThoughts();
    assistantEntry.setThought(
      result.context?.trim() ? result.context.trim() : 'No additional context used.'
    );

    recordAssistantMessage(result.answer, result.context, model);
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
      appendAssistantMessage(message.content, {
        open: false,
        thoughts: message.meta?.context
          ? message.meta.context
          : 'No additional context used.',
        summary: message.meta?.usedWebSearch ? 'Thoughts · Web context' : 'Thoughts',
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
  const { open = false, thoughts = '', summary = 'Thoughts' } = options;

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

function recordAssistantMessage(content, context, model) {
  if (!state.currentChat) {
    return;
  }
  state.currentChat.messages = state.currentChat.messages || [];
  const timestamp = new Date().toISOString();

  state.currentChat.messages.push({
    role: 'assistant',
    content,
    createdAt: timestamp,
    meta: {
      context,
      usedWebSearch: Boolean(context),
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
  if (state.isStreaming) {
    chatListNav.classList.add('disabled');
  } else {
    chatListNav.classList.remove('disabled');
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
