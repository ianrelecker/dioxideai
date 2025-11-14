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
let settingsButton;
let settingsOverlay;
let settingsPanel;
let settingsCloseButton;
let settingsForm;
let themeSelect;
let sidebarCollapseToggle;
let deleteAllChatsButton;
let tutorialOverlay;
let tutorialPanel;
let tutorialCloseButton;
let tutorialStartButton;
let tutorialDismissCheckbox;
let openTutorialButton;
let attachButton;
let attachmentListEl;
let attachmentNoticeEl;
let attachmentHintEl;
let composerEl;
let toastHost;
let shareAnalyticsToggle;
let tutorialAnalyticsCheckbox;
let ollamaEndpointInput;
let deepResearchShelf;
let deepResearchHeadline;
let deepResearchStageLabel;
let deepResearchTimeline;
let deepResearchSummaryCard;
let deepResearchSummaryText;
let deepResearchInsertButton;
let deepResearchCopyButton;
let deepResearchDismissButton;
let composerDeepResearchButton;
let deepResearchDetails;

const DEFAULT_SETTINGS = {
  autoWebSearch: true,
  openThoughtsByDefault: false,
  searchResultLimit: 10,
  theme: 'light',
  sidebarCollapsed: false,
  showTutorial: true,
  shareAnalytics: true,
  ollamaEndpoint: 'http://localhost:11434',
};

const ATTACHMENT_LIMIT = 1;
const ATTACHMENT_MAX_FILE_BYTES = 512 * 1024;
const ATTACHMENT_TOTAL_BYTES = 1024 * 1024;
const ATTACHMENT_CHAR_LIMIT = 4000;
const DEFAULT_DEEP_RESEARCH_ITERATIONS = 4;

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
  skipTutorialOnce: false,
  attachments: [],
  attachmentBytes: 0,
  attachmentWarnings: [],
  attachmentProcessingStartedAt: null,
  sidebarCollapsed: false,
  deepResearch: createDeepResearchState(),
};

const activeToasts = new Map();
let toastIdCounter = 0;
let dragDepth = 0;
let globalDropGuardsRegistered = false;
let attachmentStatusTimer = null;
const ATTACHMENT_STATUS_REFRESH_MS = 1000;
let analyticsInitialized = false;
let analyticsReady = false;

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

function createDeepResearchState() {
  return {
    enabled: false,
    running: false,
    requestId: null,
    chatId: null,
    topic: '',
    stage: '',
    message: '',
    iteration: 0,
    totalIterations: DEFAULT_DEEP_RESEARCH_ITERATIONS,
    timeline: [],
    summary: '',
    sources: [],
    error: null,
    lastUpdated: null,
    statusLine: '',
    answer: '',
    log: [],
    primaryGoal: '',
  };
}

function syncDeepResearchStatusLine() {
  if (!state.deepResearch.running) {
    return;
  }
  const status = state.deepResearch.statusLine?.trim();
  if (!status) {
    return;
  }
  const entry = state.activeAssistantEntry;
  if (entry?.setLoadingStatus) {
    entry.setLoadingStatus(status);
  }
}

function appendDeepResearchLog(log = [], payload = {}) {
  const line = describeDeepResearchProgress(payload);
  if (!line) {
    return Array.isArray(log) ? log : [];
  }
  const next = Array.isArray(log) ? [...log, line] : [line];
  return next.slice(-8);
}

function describeDeepResearchProgress(payload = {}) {
  const parts = [];
  if (Number.isFinite(payload.iteration) && payload.iteration > 0) {
    const total = Number.isFinite(payload.totalIterations) ? payload.totalIterations : null;
    parts.push(`Pass ${payload.iteration}${total ? `/${total}` : ''}`);
  } else if (payload.stage === 'planning') {
    parts.push('Planning');
  }

  if (payload.message) {
    parts.push(payload.message);
  } else {
    switch (payload.stage) {
      case 'iteration-start':
        parts.push('Searching for new sources…');
        break;
      case 'iteration-review':
        parts.push('Reviewing captured sources…');
        break;
      case 'iteration-reflection':
        parts.push('Analyzing coverage…');
        break;
      case 'model-draft':
        parts.push('Drafting answer from findings…');
        break;
      case 'model-eval':
        parts.push('Evaluating draft answer…');
        break;
      case 'model-error':
        parts.push('Draft synthesis failed.');
        break;
      case 'iteration-error':
        parts.push('Search failed.');
        break;
      default:
        break;
    }
  }

  return parts.filter(Boolean).join(' – ');
}

function buildDeepResearchProgressLabel(dr) {
  if (!dr?.running) {
    return '';
  }
  if (Number.isFinite(dr.iteration) && dr.iteration > 0) {
    const total = Number.isFinite(dr.totalIterations) ? dr.totalIterations : null;
    return `Deep research – Pass ${dr.iteration}${total ? `/${total}` : ''}`;
  }
  return 'Deep research – Preparing…';
}

function buildDeepResearchLogText(log, fallback) {
  if (Array.isArray(log) && log.length) {
    return log.join('\n');
  }
  return fallback || '';
}

function updateDeepResearchLiveOutput() {
  const entry = state.activeAssistantEntry;
  const dr = state.deepResearch;
  if (!entry || !dr?.running) {
    return;
  }
  const label = buildDeepResearchProgressLabel(dr);
  if (label) {
    entry.setSummary(label);
  }
  const status = dr.statusLine || dr.message || 'Running deep research…';
  entry.setLoadingStatus?.(status);
  const logText = buildDeepResearchLogText(dr.log, status);
  if (logText) {
    entry.setThought(logText);
    entry.openThoughts();
  }
}

function formatDeepResearchStatusLine(payload, snapshot = {}) {
  if (!payload) {
    return '';
  }
  const stage = payload.stage || snapshot.stage;
  if (stage === 'complete' || stage === 'error') {
    return '';
  }
  const totalIterations = Number.isFinite(snapshot.totalIterations)
    ? snapshot.totalIterations
    : DEFAULT_DEEP_RESEARCH_ITERATIONS;
  const parts = ['Deep research'];
  if (Number.isFinite(payload.iteration) && payload.iteration > 0) {
    parts.push(`Pass ${payload.iteration}/${totalIterations}`);
  }
  const base = parts.join(' · ');
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  return message ? `${base} – ${message}` : base;
}

function stopGeneration(requestId) {
  if (!requestId) {
    return Promise.resolve();
  }

  return window.api.cancelOllama({ requestId });
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let bytes = value;
  let unitIndex = 0;

  while (bytes >= 1024 && unitIndex < units.length - 1) {
    bytes /= 1024;
    unitIndex += 1;
  }

  const precision = bytes >= 10 || unitIndex === 0 ? 0 : 1;
  return `${bytes.toFixed(precision)} ${units[unitIndex]}`;
}

function isFileDrag(event) {
  const dt = event?.dataTransfer;
  if (!dt) {
    return false;
  }
  if (dt.types && !Array.from(dt.types).includes('Files')) {
    return false;
  }
  return true;
}

function showToast(message, { variant = 'info', duration = 6000, action } = {}) {
  if (!toastHost || !message) {
    return null;
  }

  toastIdCounter += 1;
  const id = `toast-${toastIdCounter}`;
  const toast = document.createElement('div');
  toast.classList.add('toast', variant);
  toast.setAttribute('role', 'status');
  toast.dataset.toastId = id;

  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  if (action && typeof action === 'object' && action.label && typeof action.onClick === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      try {
        action.onClick();
      } finally {
        dismissToast(id);
      }
    });
    toast.appendChild(button);
  }

  toastHost.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  const timeoutDuration = Number.isFinite(duration) ? Math.max(0, duration) : 6000;
  const timeoutId = timeoutDuration ? setTimeout(() => dismissToast(id), timeoutDuration) : null;

  activeToasts.set(id, { element: toast, timeoutId });
  return id;
}

function dismissToast(id) {
  const entry = id ? activeToasts.get(id) : null;
  if (!entry) {
    return;
  }

  const { element, timeoutId } = entry;
  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  element.classList.remove('visible');
  setTimeout(() => {
    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }
  }, 220);

  activeToasts.delete(id);
}

function notifyAttachmentWarnings(warnings) {
  const next = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
  state.attachmentWarnings = next;
  updateAttachmentNoticeText();
  if (!next.length) {
    return;
  }

  next.forEach((message) => {
    showToast(message, { variant: 'warning', duration: 7000 });
  });
}

function removeEmptyState() {
  if (!chatArea) {
    return;
  }
  const placeholder = chatArea.querySelector('.empty-state');
  if (placeholder && placeholder.parentElement === chatArea) {
    chatArea.removeChild(placeholder);
  }
}

function trackAnalyticsEvent(name, props = {}) {
  if (!analyticsReady || typeof window.api.trackAnalyticsEvent !== 'function' || !name) {
    return;
  }
  try {
    window.api.trackAnalyticsEvent(name, props);
  } catch (err) {
    console.error('Failed to track analytics event:', err);
  }
}

async function setShareAnalyticsPreference(enabled) {
  const share = Boolean(enabled);
  state.settings = state.settings || { ...DEFAULT_SETTINGS };
  state.settings.shareAnalytics = share;

  if (typeof window.api.initAnalytics !== 'function') {
    analyticsInitialized = false;
    analyticsReady = false;
    return analyticsReady;
  }

  try {
    const result = await window.api.initAnalytics({ optOut: !share });
    analyticsInitialized = Boolean(result?.initialized);
    analyticsReady = analyticsInitialized && !result?.optedOut;
  } catch (err) {
    analyticsInitialized = false;
    analyticsReady = false;
    console.error('Failed to initialize analytics:', err);
  }

  return analyticsReady;
}

function cloneAttachmentList(list) {
  return Array.isArray(list) ? list.map((file) => ({ ...file })) : [];
}

function formatTruncationWarning(name) {
  const label = typeof name === 'string' && name.trim() ? name.trim() : 'attachment';
  return `${label} was truncated to the first ${ATTACHMENT_CHAR_LIMIT.toLocaleString()} characters.`;
}

function computeTruncationWarnings(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  const messages = attachments
    .filter((file) => file && file.truncated)
    .map((file) => formatTruncationWarning(file.name));
  return messages.filter((value, index, arr) => value && arr.indexOf(value) === index);
}

function syncAttachmentsForCurrentChat({ persist = true } = {}) {
  const chatId = state.currentChatId;
  if (!chatId || !state.currentChat) {
    return;
  }

  state.currentChat.attachments = cloneAttachmentList(state.attachments);

  if (persist && typeof window.api.setChatAttachments === 'function') {
    const payload = cloneAttachmentList(state.attachments);
    window.api
      .setChatAttachments({ chatId, attachments: payload })
      .catch((err) => console.error('Failed to persist chat attachments:', err));
  }
}

function setCurrentChatAttachments(next, { persist = true, keepWarnings = false } = {}) {
  state.attachments = cloneAttachmentList(next);
  recalcAttachmentBytes();

  if (!keepWarnings) {
    notifyAttachmentWarnings([]);
  }

  renderAttachmentList();

  syncAttachmentsForCurrentChat({ persist });
}

function composeAttachmentStatusText() {
  const warnings = Array.isArray(state.attachmentWarnings) ? state.attachmentWarnings : [];

  if (!state.attachments.length) {
    return warnings.join(' ') || '';
  }

  const count = state.attachments.length;
  const countLabel = count === 1 ? '1 file' : `${count} files`;
  const totalBytes =
    state.attachmentBytes > 0
      ? state.attachmentBytes
      : state.attachments.reduce((sum, file) => {
          const size = Number(file.size) || 0;
          return sum + (Number.isFinite(size) ? size : 0);
        }, 0);
  const totalLabel = formatBytes(totalBytes);
  const infoParts = [];

  if (state.isStreaming) {
    const startedAt = typeof state.attachmentProcessingStartedAt === 'number' ? state.attachmentProcessingStartedAt : null;
    const elapsedMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
    const elapsedLabel = elapsedMs >= 1000 ? formatDuration(elapsedMs) : null;
    let line = `⏳ Processing ${countLabel} (${totalLabel})…`;
    if (elapsedLabel) {
      line += ` ${elapsedLabel} elapsed.`;
    }
    infoParts.push(line);
    infoParts.push('File-backed replies can take longer than text-only prompts.');
  } else {
    infoParts.push(`Ready to send ${countLabel} (${totalLabel}) with your next prompt.`);
  }

  const truncatedFiles = state.attachments.filter((file) => file.truncated);
  if (truncatedFiles.length) {
    const names = truncatedFiles.map((file) => file.name || 'attachment');
    const preview = names.slice(0, 3).join(', ');
    const remainder = names.length - Math.min(names.length, 3);
    const suffix = remainder > 0 ? `, and ${remainder} more` : '';
    infoParts.push(`Trimmed to ${ATTACHMENT_CHAR_LIMIT.toLocaleString()} characters: ${preview}${suffix}.`);
  }

  if (warnings.length) {
    infoParts.push(...warnings);
  }

  return infoParts.join(' ').trim();
}

function updateAttachmentNoticeText() {
  if (!attachmentNoticeEl) {
    return;
  }
  attachmentNoticeEl.textContent = composeAttachmentStatusText();
}

function startAttachmentStatusTimer() {
  if (attachmentStatusTimer) {
    return;
  }
  attachmentStatusTimer = setInterval(() => {
    if (!state.isStreaming || !state.attachments.length) {
      stopAttachmentStatusTimer();
      updateAttachmentNoticeText();
      return;
    }
    updateAttachmentNoticeText();
  }, ATTACHMENT_STATUS_REFRESH_MS);
}

function stopAttachmentStatusTimer() {
  if (attachmentStatusTimer) {
    clearInterval(attachmentStatusTimer);
    attachmentStatusTimer = null;
  }
  state.attachmentProcessingStartedAt = null;
  updateAttachmentNoticeText();
}

function setComposerDragState(active) {
  if (!composerEl) {
    return;
  }
  if (active) {
    composerEl.classList.add('drag-active');
  } else {
    composerEl.classList.remove('drag-active');
  }
}

function registerGlobalDropGuards() {
  if (globalDropGuardsRegistered) {
    return;
  }

  const guard = (event) => {
    if (isFileDrag(event)) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    }
  };

  const guardDrop = (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    if (composerEl && composerEl.contains(event.target)) {
      return;
    }
    event.preventDefault();
  };

  window.addEventListener('dragover', guard);
  window.addEventListener('drop', guardDrop);

  globalDropGuardsRegistered = true;
}

function registerComposerDropZone() {
  if (!composerEl) {
    return;
  }

  const handleDragEnter = (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    dragDepth += 1;
    event.preventDefault();
    setComposerDragState(true);
  };

  const handleDragOver = (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDragLeave = (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      setComposerDragState(false);
    }
  };

  const handleDrop = async (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    setComposerDragState(false);

    if (state.isStreaming) {
      showToast('Wait for the current reply to finish before adding files.', { variant: 'warning', duration: 5000 });
      return;
    }

    const files = Array.from(event.dataTransfer?.files || []);
    const paths = files
      .map((file) => (file && typeof file.path === 'string' ? file.path : null))
      .filter(Boolean);

    if (!paths.length) {
      showToast('Only local files can be attached at the moment.', { variant: 'warning', duration: 5000 });
      return;
    }

    const uniquePaths = Array.from(new Set(paths));
    await requestAttachmentLoad({ droppedPaths: uniquePaths });
  };

  composerEl.addEventListener('dragenter', handleDragEnter);
  composerEl.addEventListener('dragover', handleDragOver);
  composerEl.addEventListener('dragleave', handleDragLeave);
  composerEl.addEventListener('drop', handleDrop);
}

function recalcAttachmentBytes() {
  state.attachmentBytes = state.attachments.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
}

function updateAttachmentHint() {
  if (!attachmentHintEl) {
    return;
  }
  const count = state.attachments.length;
  const total = state.attachmentBytes;
  const base = `Up to ${ATTACHMENT_LIMIT} files • ${formatBytes(ATTACHMENT_MAX_FILE_BYTES)} each (max ${formatBytes(ATTACHMENT_TOTAL_BYTES)} total, ${ATTACHMENT_CHAR_LIMIT.toLocaleString()} chars/file)`;
  if (!count) {
    attachmentHintEl.textContent = base;
    return;
  }
  attachmentHintEl.textContent = `${base} (${count} selected • ${formatBytes(total)} total)`;
}

function renderAttachmentList() {
  if (!attachmentListEl) {
    return;
  }

  attachmentListEl.innerHTML = '';

  if (!state.attachments.length) {
    attachmentListEl.classList.add('hidden');
    updateAttachmentNoticeText();
    updateAttachmentHint();
    return;
  }

  attachmentListEl.classList.remove('hidden');

  state.attachments.forEach((file) => {
    const li = document.createElement('li');
    li.dataset.id = file.id;

    const name = document.createElement('span');
    name.classList.add('attachment-name');
    name.textContent = file.name || 'attachment.txt';
    li.appendChild(name);

    const meta = document.createElement('span');
    meta.classList.add('attachment-meta');
    const sizeLabel = file.displaySize || formatBytes(file.size || file.bytes || 0);
    meta.textContent = file.truncated ? `${sizeLabel} • truncated` : sizeLabel;
    li.appendChild(meta);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.classList.add('attachment-remove');
    removeBtn.setAttribute('aria-label', `Remove ${file.name}`);
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeAttachment(file.id));
    li.appendChild(removeBtn);

    attachmentListEl.appendChild(li);
  });

  updateAttachmentNoticeText();
  updateAttachmentHint();
}

function removeAttachment(id) {
  const index = state.attachments.findIndex((file) => file.id === id);
  if (index === -1) {
    return;
  }

  const removed = state.attachments[index];
  const next = state.attachments.filter((file) => file.id !== id);
  const nextWarnings = computeTruncationWarnings(next);
  notifyAttachmentWarnings(nextWarnings);
  setCurrentChatAttachments(next, { persist: true, keepWarnings: true });

  if (removed) {
    if (!next.length) {
      stopAttachmentStatusTimer();
    }
    trackAnalyticsEvent('attachment_removed', {
      total: next.length,
    });
    offerAttachmentUndo(removed);
  }
}

async function handleAttachmentPick() {
  if (state.isStreaming) {
    return;
  }
  await requestAttachmentLoad();
}

function offerAttachmentUndo(file) {
  if (!file) {
    return;
  }
  showToast(`${file.name} removed from this prompt.`, {
    variant: 'info',
    duration: 7000,
    action: {
      label: 'Undo',
      onClick: () => restoreAttachment(file),
    },
  });
}

function restoreAttachment(file) {
  if (!file) {
    return;
  }

  if (state.attachments.some((item) => item.id === file.id)) {
    return;
  }

  const next = [...state.attachments, { ...file }];
  const warnings = computeTruncationWarnings(next);
  notifyAttachmentWarnings(warnings);
  setCurrentChatAttachments(next, { persist: true, keepWarnings: true });
  trackAnalyticsEvent('attachment_restored', {
    total: next.length,
  });
}

async function requestAttachmentLoad(extraOptions = {}) {
  if (typeof window.api.pickLocalFiles !== 'function') {
    return;
  }

  try {
    const result = await window.api.pickLocalFiles({
      existingCount: state.attachments.length,
      existingBytes: state.attachmentBytes,
      ...extraOptions,
    });

    applyAttachmentSelection(result);
  } catch (err) {
    const fallbackWarning = `Unable to attach files: ${err?.message || 'Unknown error.'}`;
    notifyAttachmentWarnings([fallbackWarning]);
    renderAttachmentList();
  }
}

function applyAttachmentSelection(result) {
  if (!result || result.canceled) {
    return;
  }

  const warnings = [];
  const appendWarnings = (items) => {
    if (!Array.isArray(items)) {
      return;
    }
    items.forEach((item) => {
      if (!item) {
        return;
      }
      if (typeof item === 'string') {
        warnings.push(item);
      } else if (item.reason) {
        warnings.push(item.reason);
      }
    });
  };

  appendWarnings(result.rejected);

  const nextAttachments = [...state.attachments];

  if (Array.isArray(result.files) && result.files.length) {
    result.files.forEach((file) => {
      const record = {
        id: file.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        size: file.size,
        bytes: file.bytes,
        displaySize: file.displaySize,
        truncated: Boolean(file.truncated),
        content: file.content,
      };
      nextAttachments.push(record);
      if (record.truncated) {
        warnings.push(formatTruncationWarning(record.name));
      }
    });
  }

  appendWarnings(result.warnings);

  if (nextAttachments.length >= ATTACHMENT_LIMIT) {
    warnings.push('Attachment limit reached.');
  }

  const uniqueWarnings = warnings.filter((value, index, arr) => value && arr.indexOf(value) === index);
  notifyAttachmentWarnings(uniqueWarnings);
  setCurrentChatAttachments(nextAttachments, { persist: true, keepWarnings: true });
  if (Array.isArray(result.files) && result.files.length) {
    trackAnalyticsEvent('attachments_added', {
      added: result.files.length,
      total: nextAttachments.length,
    });
  }
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
  settingsButton = document.getElementById('settingsBtn');
  settingsOverlay = document.getElementById('settingsOverlay');
  settingsPanel = document.getElementById('settingsPanel');
  settingsCloseButton = document.getElementById('settingsCloseBtn');
  settingsForm = document.getElementById('settingsForm');
  themeSelect = document.getElementById('themeSelect');
  sidebarCollapseToggle = document.getElementById('sidebarCollapseToggle');
  deleteAllChatsButton = document.getElementById('deleteAllChatsBtn');
  tutorialOverlay = document.getElementById('tutorialOverlay');
  tutorialPanel = document.getElementById('tutorialPanel');
  tutorialCloseButton = document.getElementById('tutorialCloseBtn');
  tutorialStartButton = document.getElementById('tutorialStartBtn');
  tutorialDismissCheckbox = document.getElementById('tutorialDismissCheckbox');
  openTutorialButton = document.getElementById('openTutorialBtn');
  attachButton = document.getElementById('attachBtn');
  attachmentListEl = document.getElementById('attachmentList');
  attachmentNoticeEl = document.getElementById('attachmentNotice');
  attachmentHintEl = document.getElementById('attachmentHint');
  composerEl = document.getElementById('composer');
  toastHost = document.getElementById('toastHost');
  shareAnalyticsToggle = document.getElementById('shareAnalyticsToggle');
  tutorialAnalyticsCheckbox = document.getElementById('tutorialAnalyticsCheckbox');
  ollamaEndpointInput = document.getElementById('ollamaEndpointInput');
  composerDeepResearchButton = document.getElementById('composerDeepResearchBtn');
  deepResearchShelf = document.getElementById('deepResearchShelf');
  deepResearchHeadline = document.getElementById('deepResearchHeadline');
  deepResearchStageLabel = document.getElementById('deepResearchStage');
  deepResearchTimeline = document.getElementById('deepResearchTimeline');
  deepResearchSummaryCard = document.getElementById('deepResearchSummaryCard');
  deepResearchSummaryText = document.getElementById('deepResearchSummaryText');
  deepResearchInsertButton = document.getElementById('deepResearchInsertBtn');
  deepResearchCopyButton = document.getElementById('deepResearchCopyBtn');
  deepResearchDismissButton = document.getElementById('deepResearchDismissBtn');
  deepResearchDetails = document.getElementById('deepResearchDetails');

  registerGlobalDropGuards();

  try {
    registerStreamHandlers();
    registerUIListeners();
    registerComposerDropZone();
    renderAttachmentList();
    updateInteractivity();
    await loadSettings();
    await populateModels();
    await initializeChats();
    promptInput.focus();
    updateDeepResearchShelf();
    updateDeepResearchButtons();
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

  trackAnalyticsEvent('app_opened', {
    chat_count: state.chats.length,
    has_existing_chat: state.chats.length > 0,
  });
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

  attachButton?.addEventListener('click', async () => {
    if (state.isStreaming) {
      return;
    }
    await handleAttachmentPick();
  });

  composerDeepResearchButton?.addEventListener('click', toggleDeepResearchEnabled);
  composerDeepResearchButton?.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || event.shiftKey || state.isStreaming) {
      return;
    }
    event.preventDefault();
    await handlePromptSubmit();
  });
  deepResearchInsertButton?.addEventListener('click', handleDeepResearchInsert);
  deepResearchCopyButton?.addEventListener('click', handleDeepResearchCopy);
  deepResearchDismissButton?.addEventListener('click', dismissDeepResearchShelf);

  sidebarToggleBtn?.addEventListener('click', () => {
    const nextValue = !state.sidebarCollapsed;
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
  shareAnalyticsToggle?.addEventListener('change', async () => {
    const enabled = shareAnalyticsToggle.checked;
    const wasReady = analyticsReady;
    if (!enabled && wasReady) {
      trackAnalyticsEvent('analytics_disabled', { source: 'settings' });
    }
    await setShareAnalyticsPreference(enabled);
    applySettingsUpdate({ shareAnalytics: enabled });
    if (enabled) {
      trackAnalyticsEvent('analytics_enabled', { source: 'settings' });
    }
  });
  tutorialAnalyticsCheckbox?.addEventListener('change', async () => {
    const enabled = tutorialAnalyticsCheckbox.checked;
    const wasReady = analyticsReady;
    if (!enabled && wasReady) {
      trackAnalyticsEvent('analytics_disabled', { source: 'tutorial' });
    }
    await setShareAnalyticsPreference(enabled);
    applySettingsUpdate({ shareAnalytics: enabled });
    if (enabled) {
      trackAnalyticsEvent('analytics_enabled', { source: 'tutorial' });
    }
  });
  ollamaEndpointInput?.addEventListener('change', async () => {
    const value = typeof ollamaEndpointInput.value === 'string' ? ollamaEndpointInput.value.trim() : '';
    await applySettingsUpdate({ ollamaEndpoint: value });
    await populateModels();
  });

  deleteAllChatsButton?.addEventListener('click', handleDeleteAllChats);
  openTutorialButton?.addEventListener('click', () => {
    if (tutorialDismissCheckbox) {
      tutorialDismissCheckbox.checked = Boolean(state.settings?.showTutorial ?? true);
    }
    if (tutorialAnalyticsCheckbox) {
      tutorialAnalyticsCheckbox.checked = Boolean(state.settings?.shareAnalytics !== false);
    }
    openTutorial();
  });
  tutorialOverlay?.addEventListener('click', (event) => {
    if (event.target === tutorialOverlay) {
      dismissTutorial();
    }
  });
  tutorialPanel?.addEventListener('click', (event) => event.stopPropagation());
  tutorialCloseButton?.addEventListener('click', dismissTutorial);
  tutorialStartButton?.addEventListener('click', async () => {
    dismissTutorial();
    promptInput?.focus();
  });
  tutorialDismissCheckbox?.addEventListener('change', () => {
    const shouldShow = tutorialDismissCheckbox.checked;
    applySettingsUpdate({ showTutorial: shouldShow });
  });




  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.settingsPanelOpen) {
        closeSettingsPanel();
      }
      if (!tutorialOverlay?.classList.contains('hidden')) {
        dismissTutorial();
      }
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

  const enforced = {};
  if (state.settings.autoWebSearch !== DEFAULT_SETTINGS.autoWebSearch) {
    state.settings.autoWebSearch = DEFAULT_SETTINGS.autoWebSearch;
    enforced.autoWebSearch = DEFAULT_SETTINGS.autoWebSearch;
  }
  if (state.settings.searchResultLimit !== DEFAULT_SETTINGS.searchResultLimit) {
    state.settings.searchResultLimit = DEFAULT_SETTINGS.searchResultLimit;
    enforced.searchResultLimit = DEFAULT_SETTINGS.searchResultLimit;
  }
  if (Object.keys(enforced).length) {
    await applySettingsUpdate(enforced);
  }

  await setShareAnalyticsPreference(state.settings.shareAnalytics !== false);
  applySettingsToUI();
}

function applySettingsToUI() {
  const prefs = state.settings || DEFAULT_SETTINGS;

  if (shareAnalyticsToggle) {
    shareAnalyticsToggle.checked = prefs.shareAnalytics !== false;
  }
  if (tutorialAnalyticsCheckbox) {
    tutorialAnalyticsCheckbox.checked = prefs.shareAnalytics !== false;
  }
  if (ollamaEndpointInput) {
    ollamaEndpointInput.value = prefs.ollamaEndpoint || DEFAULT_SETTINGS.ollamaEndpoint;
  }

  if (themeSelect) {
    themeSelect.value = prefs.theme || 'system';
  }

  if (sidebarCollapseToggle) {
    sidebarCollapseToggle.checked = Boolean(prefs.sidebarCollapsed);
  }

  updateSidebarState(Boolean(prefs.sidebarCollapsed));
  applyTheme(prefs.theme || DEFAULT_SETTINGS.theme);

  if (tutorialDismissCheckbox) {
    tutorialDismissCheckbox.checked = prefs.showTutorial !== false;
  }

  if (prefs.showTutorial !== false) {
    if (state.skipTutorialOnce) {
      state.skipTutorialOnce = false;
    } else {
      openTutorial();
    }
  } else {
    dismissTutorial(false);
  }
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
    if (partial && Object.prototype.hasOwnProperty.call(partial, 'shareAnalytics')) {
      await setShareAnalyticsPreference(state.settings.shareAnalytics !== false);
    }
    applySettingsToUI();
  } catch (err) {
    console.error('Failed to update settings:', err);
  }
}

function openTutorial() {
  if (!tutorialOverlay || !tutorialPanel) {
    return;
  }
  if (tutorialDismissCheckbox) {
    tutorialDismissCheckbox.checked = state.settings?.showTutorial !== false;
  }
  if (tutorialAnalyticsCheckbox) {
    tutorialAnalyticsCheckbox.checked = state.settings?.shareAnalytics !== false;
  }
  tutorialOverlay.classList.remove('hidden');
  tutorialOverlay.setAttribute('aria-hidden', 'false');
  tutorialPanel.setAttribute('tabindex', '-1');
  tutorialPanel.focus();
  document.body.classList.add('tutorial-open');
}

function dismissTutorial(shouldPersist = true) {
  if (!tutorialOverlay) {
    return;
  }
  if (shouldPersist && tutorialDismissCheckbox) {
    const shouldShow = tutorialDismissCheckbox.checked;
    state.skipTutorialOnce = shouldShow;
    applySettingsUpdate({ showTutorial: shouldShow });
  } else if (shouldPersist) {
    state.skipTutorialOnce = false;
  } else {
    state.skipTutorialOnce = false;
  }
  tutorialOverlay.classList.add('hidden');
  tutorialOverlay.setAttribute('aria-hidden', 'true');
  tutorialPanel?.setAttribute('tabindex', '');
  document.body.classList.remove('tutorial-open');
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
      stopAttachmentStatusTimer();
      return;
    }

    if (data.aborted) {
      entry.clearActions();
      entry.stopLoading?.();
      state.pendingAssistantByChat.delete(data.chatId);
      state.isStreaming = false;
      state.activeRequestId = null;
      state.activeAssistantEntry = null;
      updateInteractivity();
      stopAttachmentStatusTimer();
      return;
    }

    if (typeof data.full === 'string') {
      entry.setContent(data.full);
    }

    if (typeof data.reasoning === 'string') {
      const trimmed = data.reasoning.trim();
      entry.setReasoning(data.reasoning);
      if (trimmed && !entry.__autoOpenedReasoning) {
        entry.openThoughts();
        entry.__autoOpenedReasoning = true;
      }
    }

    if (data.timing) {
      const summary = formatTimingSummary(data.timing);
      if (summary) {
        entry.setTiming(summary);
      }
    }

    if (data.done) {
      entry.stopLoading?.();
      entry.clearActions();
      entry.setSummary('');
      state.pendingAssistantByChat.delete(data.chatId);
      state.isStreaming = false;
      state.activeRequestId = null;
      state.activeAssistantEntry = null;
      updateInteractivity();
      stopAttachmentStatusTimer();
    }
  });

  window.api.onThinking((data) => {
    const entry = state.pendingAssistantByChat.get(data.chatId);
    if (!entry) {
      return;
    }

    const deriveStatus = (fallback) =>
      (typeof data.message === 'string' && data.message.trim()) || fallback;

    switch (data.stage) {
      case 'model-loading': {
        const status = deriveStatus('Loading model…');
        entry.setSummary(status);
        entry.setLoadingStatus?.(status);
        break;
      }
      case 'generating': {
        const status = deriveStatus('Generating response…');
        entry.setSummary(status);
        entry.setLoadingStatus?.(status);
        break;
      }
      case 'search-plan':
      case 'search-started': {
        const status = deriveStatus('Searching the web…');
        entry.setSummary(status);
        entry.setLoadingStatus?.(status);
        entry.setThought(
          formatSearchPlanThought({
            message: data.message || 'Preparing web search queries.',
            queries: data.queries,
          })
        );
        break;
      }
      case 'context': {
        const hasContext =
          Boolean(data.context?.trim()) ||
          (Array.isArray(data.attachments) && data.attachments.length > 0);
        const status = deriveStatus(
          hasContext ? 'Reviewing gathered context…' : 'No additional context used.'
        );
        const hasDeepResearch =
          data.deepResearch &&
          (data.deepResearch.summary ||
            data.deepResearch.answer ||
            (Array.isArray(data.deepResearch.sources) && data.deepResearch.sources.length > 0));
        entry.setSummary(hasDeepResearch ? 'Deep research notes & timing' : status);
        entry.setLoadingStatus?.(status);
        entry.setThought(
          formatContextThought({
            message: data.context?.trim()
              ? data.message || 'Context gathered from the web.'
              : data.message || 'No additional context used.',
            context: data.context,
            queries: data.queries,
            retrievedAt: data.retrievedAt,
            attachments: data.attachments,
            warnings: data.attachmentWarnings,
          })
        );
        const thoughtState = entry.getThoughtState ? entry.getThoughtState() : null;
        const hasReasoning = Boolean(thoughtState?.reasoning);
        if (hasReasoning || (state.settings?.openThoughtsByDefault ?? false)) {
          entry.openThoughts();
        } else if (!hasContext) {
          entry.closeThoughts();
        } else {
          entry.closeThoughts();
        }
        break;
      }
      default:
        break;
    }
  });

  window.api.onDeepResearchProgress((payload) => {
    handleDeepResearchProgress(payload);
  });
}

function toggleDeepResearchEnabled() {
  if (state.isStreaming || state.deepResearch.running) {
    showToast('Finish the current response before changing deep research.', { variant: 'info' });
    return;
  }

  const nextEnabled = !state.deepResearch.enabled;
  state.deepResearch = {
    ...state.deepResearch,
    enabled: nextEnabled,
    chatId: state.currentChatId || state.deepResearch.chatId,
  };
  updateDeepResearchButtons();

}

async function runDeepResearchSequence(topicSource, model) {
  const topicInput = typeof topicSource === 'string' ? topicSource.trim() : '';
  const topic = topicInput || resolveDeepResearchTopic(topicInput);
  if (!topic) {
    return null;
  }

  const requestId = createRequestId();
  const primaryGoal = resolveChatPrimaryGoal();
  state.deepResearch = {
    ...state.deepResearch,
    running: true,
    requestId,
    chatId: state.currentChatId,
    topic,
    stage: 'planning',
    message: 'Planning multi-pass web research…',
    summary: '',
    sources: [],
    timeline: [],
    iteration: 0,
    totalIterations: DEFAULT_DEEP_RESEARCH_ITERATIONS,
    error: null,
    statusLine: '',
    answer: '',
    log: [],
    primaryGoal,
  };
  updateDeepResearchShelf();
  updateDeepResearchButtons();
  updateInteractivity();
  updateDeepResearchLiveOutput();

  trackAnalyticsEvent('deep_research_started', {
    chat_id: state.currentChatId,
    topic_chars: topic.length,
    iterations: DEFAULT_DEEP_RESEARCH_ITERATIONS,
    mode: 'pre-send-toggle',
  });

  try {
    const response = await window.api.deepResearch({
      chatId: state.currentChatId,
      topic,
      requestId,
      iterations: DEFAULT_DEEP_RESEARCH_ITERATIONS,
      model,
      initialGoal: primaryGoal,
    });

    if (response?.error) {
      throw new Error(response.error);
    }

    const normalized = {
      summary: response.summary || '',
      sources: Array.isArray(response.sources) ? response.sources : [],
      timeline: Array.isArray(response.timeline) ? response.timeline : [],
      iterations: Number(response.iterations) || DEFAULT_DEEP_RESEARCH_ITERATIONS,
      answer: typeof response.answer === 'string' ? response.answer.trim() : '',
    };

    state.deepResearch = {
      ...state.deepResearch,
      running: false,
      requestId: null,
      stage: 'complete',
      message: 'Deep research ready to review.',
      summary: normalized.summary,
      sources: normalized.sources,
    timeline: normalized.timeline.map((entry) => ({
      ...entry,
      status: entry.status || 'complete',
    })),
    error: null,
    answer: normalized.answer,
    statusLine: '',
    log: [],
    primaryGoal,
  };
    updateDeepResearchShelf();
    trackAnalyticsEvent('deep_research_completed', {
      chat_id: state.currentChatId,
      iterations: normalized.iterations,
      sources: normalized.sources.length,
      mode: 'pre-send-toggle',
    });
    return normalized;
  } catch (err) {
    console.error('Deep research failed:', err);
    const message = err?.message || 'Unable to complete deep research right now.';
    state.deepResearch = {
      ...state.deepResearch,
      running: false,
      requestId: null,
      error: message,
      message,
      statusLine: '',
      log: [],
      answer: '',
      primaryGoal,
    };
    updateDeepResearchShelf();
    showToast(message, { variant: 'warning' });
    trackAnalyticsEvent('deep_research_failed', {
      chat_id: state.currentChatId,
      reason: String(message).slice(0, 120),
      mode: 'pre-send-toggle',
    });
    return null;
  } finally {
    updateInteractivity();
  }
}

function resolveDeepResearchTopic(fallbackPrompt) {
  const candidate =
    typeof fallbackPrompt === 'string' && fallbackPrompt.trim()
      ? fallbackPrompt.trim()
      : typeof promptInput?.value === 'string'
        ? promptInput.value.trim()
        : '';
  const typed = candidate;
  if (typed) {
    return typed;
  }
  const messages = Array.isArray(state.currentChat?.messages) ? state.currentChat.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }
  }
  return '';
}

function resolveChatPrimaryGoal() {
  if (state.currentChat?.initialUserPrompt && state.currentChat.initialUserPrompt.trim()) {
    return state.currentChat.initialUserPrompt.trim();
  }
  const messages = Array.isArray(state.currentChat?.messages) ? state.currentChat.messages : [];
  const firstUser = messages.find(
    (message) => message?.role === 'user' && typeof message.content === 'string' && message.content.trim()
  );
  return firstUser ? firstUser.content.trim() : '';
}

function handleDeepResearchProgress(payload) {
  if (!payload || !payload.requestId) {
    return;
  }
  if (payload.requestId !== state.deepResearch.requestId) {
    return;
  }

  const next = {
    ...state.deepResearch,
    stage: payload.stage || state.deepResearch.stage,
    message: payload.message || state.deepResearch.message,
    iteration:
      Number.isFinite(payload.iteration) && payload.iteration > 0
        ? Number(payload.iteration)
        : state.deepResearch.iteration,
    totalIterations:
      Number.isFinite(payload.totalIterations) && payload.totalIterations > 0
        ? Number(payload.totalIterations)
        : state.deepResearch.totalIterations,
    lastUpdated: Date.now(),
    log: appendDeepResearchLog(state.deepResearch.log, payload),
  };
  if (typeof payload.answer === 'string' && payload.answer.trim()) {
    next.answer = payload.answer.trim();
  }

  if (
    payload.stage === 'iteration-start' ||
    payload.stage === 'iteration-review' ||
    payload.stage === 'iteration-error' ||
    payload.stage === 'iteration-reflection' ||
    payload.stage === 'model-draft' ||
    payload.stage === 'model-eval' ||
    payload.stage === 'model-error' ||
    (Array.isArray(payload.findings) && payload.findings.length)
  ) {
    next.timeline = upsertDeepResearchTimelineEntry(next.timeline, {
      iteration: Number(payload.iteration),
      query: payload.query,
      findings: Array.isArray(payload.findings) ? payload.findings : undefined,
      statusStage: payload.stage,
      message: payload.message,
      review: payload.review,
      answer: payload.answer,
      verdict: payload.verdict,
      reviewNotes: payload.reviewNotes,
    });
  }

  if (payload.stage === 'complete') {
    next.running = false;
    next.error = null;
    if (payload.summary) {
      next.summary = payload.summary;
    }
    if (Array.isArray(payload.sources)) {
      next.sources = payload.sources;
    }
  } else if (payload.stage === 'error') {
    next.running = false;
    next.error = payload.message || 'Deep research failed.';
  }

  next.statusLine = next.running ? formatDeepResearchStatusLine(payload, next) : '';

  state.deepResearch = next;
  updateDeepResearchShelf();
  updateInteractivity();
  updateDeepResearchLiveOutput();
  syncDeepResearchStatusLine();
}

function upsertDeepResearchTimelineEntry(timeline = [], update = {}) {
  if (!Number.isFinite(update.iteration)) {
    return Array.isArray(timeline) ? timeline : [];
  }
  const list = Array.isArray(timeline) ? [...timeline] : [];
  const iteration = Number(update.iteration);
  const index = list.findIndex((entry) => entry.iteration === iteration);
  const existing = index >= 0 ? list[index] : null;

  const preserveMessage = update.statusStage === 'iteration-reflection';
  const entry = {
    iteration,
    query: update.query || existing?.query || '',
    findings: Array.isArray(update.findings)
      ? update.findings.slice(0, 3)
      : existing?.findings || [],
    status: mapDeepResearchStageToStatus(update.statusStage, existing?.status),
    message: preserveMessage ? existing?.message || '' : update.message || existing?.message || '',
    review: existing?.review || '',
    answer: existing?.answer || '',
    verdict: existing?.verdict || '',
    reviewNotes: existing?.reviewNotes || '',
  };

  if (typeof update.review === 'string' && update.review.trim()) {
    entry.review = update.review.trim();
  }
  if (typeof update.answer === 'string' && update.answer.trim()) {
    entry.answer = update.answer.trim();
  }
  if (typeof update.verdict === 'string' && update.verdict.trim()) {
    entry.verdict = update.verdict.trim();
  }
  if (typeof update.reviewNotes === 'string' && update.reviewNotes.trim()) {
    entry.reviewNotes = update.reviewNotes.trim();
  }

  if (index >= 0) {
    list[index] = entry;
  } else {
    list.push(entry);
  }

  list.sort((a, b) => a.iteration - b.iteration);
  return list;
}

function mapDeepResearchStageToStatus(stage, fallback = 'pending') {
  switch (stage) {
    case 'iteration-start':
      return 'active';
    case 'iteration-review':
    case 'iteration-reflection':
    case 'model-eval':
      return 'complete';
    case 'iteration-error':
    case 'model-error':
      return 'error';
    case 'model-draft':
      return 'active';
    default:
      return fallback || 'pending';
  }
}

function updateDeepResearchShelf() {
  if (!deepResearchShelf) {
    return;
  }

  const hasContent =
    state.deepResearch.running ||
    Boolean(state.deepResearch.summary) ||
    Boolean(state.deepResearch.error) ||
    (Array.isArray(state.deepResearch.timeline) && state.deepResearch.timeline.length > 0);

  if (!hasContent) {
    deepResearchShelf.classList.add('hidden');
    renderDeepResearchTimeline();
    renderDeepResearchSummary();
    updateDeepResearchButtons();
    updateDeepResearchDetailsVisibility();
    return;
  }

  deepResearchShelf.classList.remove('hidden');
  if (deepResearchHeadline) {
    deepResearchHeadline.textContent = state.deepResearch.running
      ? formatDeepResearchHeadline(state.deepResearch.topic)
      : 'Deep research ready';
  }
  if (deepResearchStageLabel) {
    if (state.deepResearch.error) {
      deepResearchStageLabel.textContent = state.deepResearch.error;
    } else if (state.deepResearch.message) {
      deepResearchStageLabel.textContent = state.deepResearch.message;
    } else if (state.deepResearch.running) {
      deepResearchStageLabel.textContent = 'Gathering multi-source evidence…';
    } else {
      deepResearchStageLabel.textContent = 'Review findings before sending.';
    }
  }

  renderDeepResearchTimeline();
  renderDeepResearchSummary();
  updateDeepResearchButtons();
}

function renderDeepResearchTimeline() {
  if (!deepResearchTimeline) {
    return;
  }
  deepResearchTimeline.innerHTML = '';
  const entries = Array.isArray(state.deepResearch.timeline) ? state.deepResearch.timeline : [];
  if (!entries.length) {
    deepResearchTimeline.classList.add('hidden');
    updateDeepResearchDetailsVisibility();
    return;
  }
  deepResearchTimeline.classList.remove('hidden');
  entries.forEach((entry) => {
    const item = document.createElement('li');
    item.classList.add(entry.status || 'pending');

    const title = document.createElement('strong');
    const iterationLabel = Number.isFinite(entry.iteration) ? entry.iteration : '–';
    title.textContent = `Pass ${iterationLabel}`;
    item.appendChild(title);

    const meta = document.createElement('small');
    const messageParts = [];
    if (entry.query) {
      messageParts.push(`Query: ${entry.query}`);
    }
    if (entry.message) {
      messageParts.push(entry.message);
    }
    meta.textContent = messageParts.join(' • ');
    item.appendChild(meta);

    if (Array.isArray(entry.findings) && entry.findings.length) {
      const list = document.createElement('ul');
      list.classList.add('deep-research-findings');
      entry.findings.slice(0, 2).forEach((finding) => {
        const li = document.createElement('li');
        const label = finding.title || finding.summary || finding.url || 'Source';
        li.textContent = label;
        list.appendChild(li);
      });
      item.appendChild(list);
    }

    if (entry.review) {
      const review = document.createElement('p');
      review.classList.add('deep-research-review');
      review.textContent = entry.review;
      item.appendChild(review);
    }

    if (entry.answer) {
      const draft = document.createElement('p');
      draft.classList.add('deep-research-draft');
      draft.textContent =
        entry.answer.length > 320 ? `${entry.answer.slice(0, 317)}…` : entry.answer;
      item.appendChild(draft);
    }

    if (entry.verdict || entry.reviewNotes) {
      const verdict = document.createElement('p');
      verdict.classList.add('deep-research-verdict');
      if (entry.verdict === 'good') {
        verdict.classList.add('approved');
      } else if (entry.verdict) {
        verdict.classList.add('needs-work');
      }
      verdict.textContent = entry.reviewNotes
        ? `Reviewer: ${entry.reviewNotes}`
        : entry.verdict
          ? `Reviewer verdict: ${entry.verdict}`
          : 'Reviewer feedback recorded.';
      item.appendChild(verdict);
    }

    deepResearchTimeline.appendChild(item);
  });
  if (deepResearchDetails && state.deepResearch.running) {
    deepResearchDetails.open = true;
  }
  updateDeepResearchDetailsVisibility();
}

function renderDeepResearchSummary() {
  if (!deepResearchSummaryCard || !deepResearchSummaryText) {
    return;
  }
  const summaryText = buildDeepResearchSummaryDisplay();
  const hasSummary = Boolean(summaryText);
  if (!hasSummary) {
    deepResearchSummaryCard.classList.add('hidden');
    deepResearchSummaryText.textContent = '';
    if (deepResearchInsertButton) {
      deepResearchInsertButton.disabled = true;
    }
    if (deepResearchCopyButton) {
      deepResearchCopyButton.disabled = true;
    }
    updateDeepResearchDetailsVisibility();
    return;
  }

  deepResearchSummaryCard.classList.remove('hidden');
  deepResearchSummaryText.textContent = summaryText;
  if (deepResearchInsertButton) {
    deepResearchInsertButton.disabled = false;
  }
  if (deepResearchCopyButton) {
    deepResearchCopyButton.disabled = false;
  }
  updateDeepResearchDetailsVisibility();
}

function updateDeepResearchDetailsVisibility() {
  if (!deepResearchDetails) {
    return;
  }
  const timelineVisible = deepResearchTimeline && !deepResearchTimeline.classList.contains('hidden');
  const summaryVisible = deepResearchSummaryCard && !deepResearchSummaryCard.classList.contains('hidden');
  const shouldShow = timelineVisible || summaryVisible;
  if (!shouldShow) {
    deepResearchDetails.classList.add('hidden');
    deepResearchDetails.open = false;
  } else {
    deepResearchDetails.classList.remove('hidden');
  }
}

function updateDeepResearchButtons() {
  const isActive = Boolean(state.deepResearch.enabled);
  const buttons = [composerDeepResearchButton];
  buttons.forEach((btn) => {
    if (!btn) {
      return;
    }
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function formatDeepResearchHeadline(topic) {
  const trimmed = typeof topic === 'string' ? topic.trim() : '';
  if (!trimmed) {
    return 'Deep research';
  }
  if (trimmed.length <= 52) {
    return `Deep research on "${trimmed}"`;
  }
  return `Deep research on "${trimmed.slice(0, 49)}..."`;
}

async function handleDeepResearchCopy() {
  const summary = buildDeepResearchSummaryDisplay();
  if (!summary) {
    return;
  }
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(summary);
    } else {
      throw new Error('Clipboard API unavailable');
    }
    showToast('Deep research summary copied.', { variant: 'info' });
  } catch (err) {
    try {
      const fallback = document.createElement('textarea');
      fallback.value = summary;
      fallback.setAttribute('readonly', '');
      fallback.style.position = 'absolute';
      fallback.style.left = '-9999px';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      document.body.removeChild(fallback);
      showToast('Deep research summary copied.', { variant: 'info' });
    } catch (copyError) {
      console.error('Failed to copy deep research summary:', copyError);
      showToast('Copy failed. Select the findings text manually.', { variant: 'warning' });
    }
  }
}

function handleDeepResearchInsert() {
  const payload = buildDeepResearchSummaryDisplay();
  if (!promptInput || !payload) {
    return;
  }
  const block = `[Deep Research Findings]\n${payload}`;
  const existing = typeof promptInput.value === 'string' ? promptInput.value.trimEnd() : '';
  promptInput.value = existing ? `${existing}\n\n${block}\n` : `${block}\n`;
  promptInput.dispatchEvent(new Event('input', { bubbles: true }));
  promptInput.focus();
  showToast('Inserted deep research findings into the prompt.', { variant: 'info' });
}

function buildDeepResearchSummaryDisplay() {
  const parts = [];
  if (state.deepResearch.answer && state.deepResearch.answer.trim()) {
    parts.push(`Preliminary response:\n${state.deepResearch.answer.trim()}`);
  }
  if (state.deepResearch.summary && state.deepResearch.summary.trim()) {
    parts.push(state.deepResearch.summary.trim());
  }
  return parts.join('\n\n').trim();
}

function dismissDeepResearchShelf() {
  if (state.deepResearch.running) {
    return;
  }
  const enabled = Boolean(state.deepResearch.enabled);
  const chatId = state.deepResearch.chatId || null;
  state.deepResearch = { ...createDeepResearchState(), enabled, chatId };
  updateDeepResearchShelf();
  updateDeepResearchButtons();
  updateInteractivity();
}

function maybeResetDeepResearchForChat(chatId) {
  if (!chatId) {
    return;
  }
  if (state.deepResearch.chatId === chatId) {
    return;
  }
  state.deepResearch = { ...createDeepResearchState(), chatId };
  updateDeepResearchButtons();
  updateDeepResearchShelf();
}

async function populateModels() {
  setModelControlsDisabled(true);
  const endpoint = state.settings?.ollamaEndpoint || DEFAULT_SETTINGS.ollamaEndpoint;

  try {
    const models = await window.api.getModels();
    modelSelect.innerHTML = '';

    if (!models.length) {
      const option = document.createElement('option');
      option.textContent = `No models detected at ${endpoint}`;
      option.value = '';
      option.disabled = true;
      option.selected = true;
      modelSelect.appendChild(option);
      showToast(`No Ollama models detected at ${endpoint}. Start Ollama and refresh.`, {
        variant: 'warning',
        duration: 8000,
      });
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
    option.textContent = `Unable to reach Ollama at ${endpoint}`;
    option.value = '';
    option.disabled = true;
    option.selected = true;
    modelSelect.appendChild(option);
    showToast(`Unable to reach Ollama at ${endpoint}. Ensure it is running and click refresh.`, {
      variant: 'warning',
      duration: 8000,
    });
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

  const attachmentsPayload = state.attachments.map((file) => ({
    id: file.id,
    name: file.name,
    size: file.size,
    bytes: file.bytes,
    truncated: Boolean(file.truncated),
    content: file.content,
  }));

  trackAnalyticsEvent('prompt_submitted', {
    chat_id: chatId,
    model,
    prompt_chars: prompt.length,
    attachments: state.attachments.length,
    deep_research_enabled: Boolean(state.deepResearch.enabled),
  });

  state.isStreaming = true;
  updateInteractivity();
  const hasAttachments = state.attachments.length > 0;
  stopAttachmentStatusTimer();
  if (hasAttachments) {
    state.attachmentProcessingStartedAt = Date.now();
    startAttachmentStatusTimer();
  }
  renderAttachmentList();

  const requestId = createRequestId();
  const userLinks = extractLinks(prompt);

  const assistantEntry = appendAssistantMessage('', {
    open: false,
    thoughts: '',
    summary: 'Loading model…',
    loading: true,
    loadingStatus: 'Loading model…',
  });
  let cancelRequested = false;

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
    cancelRequested = true;
    stopGeneration(requestId).catch((err) => {
      console.error('Failed to cancel generation:', err);
      stopButton.disabled = false;
      stopButton.textContent = 'Stop';
    });
  });
  assistantEntry.addActionButton(stopButton);
  assistantEntry.__autoOpenedReasoning = false;

  state.pendingAssistantByChat.set(chatId, assistantEntry);
  state.activeRequestId = requestId;
  state.activeAssistantEntry = assistantEntry;

  try {
    let deepResearchPayload = null;
    if (state.deepResearch.enabled) {
      deepResearchPayload = await runDeepResearchSequence(prompt, model);
    }

    if (cancelRequested) {
      assistantEntry.clearActions();
      assistantEntry.stopLoading?.();
      assistantEntry.setSummary('Canceled');
      state.pendingAssistantByChat.delete(chatId);
      state.isStreaming = false;
      state.activeRequestId = null;
      state.activeAssistantEntry = null;
      updateInteractivity();
      stopAttachmentStatusTimer();
      renderAttachmentList();
      return;
    }

    const result = await window.api.askOllama({
      chatId,
      model,
      prompt,
      requestId,
      userLinks,
      attachments: attachmentsPayload,
      deepResearch: deepResearchPayload,
    });

    assistantEntry.clearActions();
    state.activeRequestId = null;
    state.activeAssistantEntry = null;

    if (result?.aborted) {
      assistantEntry.stopLoading?.();
      state.pendingAssistantByChat.delete(chatId);
      state.isStreaming = false;
      updateInteractivity();
      stopAttachmentStatusTimer();
      renderAttachmentList();
      return;
    }

    if (result?.error) {
      assistantEntry.clearActions();
      assistantEntry.stopLoading?.();
      assistantEntry.setContent(result.error);
      assistantEntry.setSummary('Error');
      assistantEntry.openThoughts();
      assistantEntry.setThought(result.error);
      state.pendingAssistantByChat.delete(chatId);
      state.isStreaming = false;
      updateInteractivity();
      stopAttachmentStatusTimer();
      renderAttachmentList();
      trackAnalyticsEvent('response_error', {
        type: 'model_error',
        message: String(result.error || '').slice(0, 120),
      });
      return;
    }

    const reasoningText = result.reasoning?.trim() || '';
    const hasContext = Boolean(result.context);
    const usesDeepResearch =
      result.deepResearch &&
      (result.deepResearch.summary ||
        result.deepResearch.answer ||
        (Array.isArray(result.deepResearch.sources) && result.deepResearch.sources.length > 0));
    const contextSummary = usesDeepResearch ? 'Deep research notes & timing' : hasContext ? 'Web Context' : 'Context';

    assistantEntry.setSummary(contextSummary);
    if (reasoningText) {
      assistantEntry.setReasoning(reasoningText);
    }
    const contextMessage = usesDeepResearch
      ? 'Deep research findings captured before this response.'
      : result.usedWebSearch
        ? 'Web search context applied to compose the answer.'
        : result.reusedConversationMemory
          ? 'Relied on earlier conversation and cached context.'
          : result.context
            ? 'Included user-provided references.'
            : 'No additional context used.';
    assistantEntry.setThought(
      formatContextThought({
        message: contextMessage,
        context: result.context,
        queries: result.contextQueries,
        retrievedAt: result.contextRetrievedAt,
        attachments: result.attachments,
        warnings: result.attachmentWarnings,
      })
    );
    assistantEntry.setTiming(formatTimingSummary(result.timing));

    if (reasoningText) {
      assistantEntry.openThoughts();
    } else if (state.settings?.openThoughtsByDefault ?? false) {
      assistantEntry.openThoughts();
    } else if (!hasContext) {
      assistantEntry.closeThoughts();
    } else {
      assistantEntry.closeThoughts();
    }

    recordAssistantMessage(
      result.answer,
      {
        context: result.context,
        queries: result.contextQueries,
        retrievedAt: result.contextRetrievedAt,
        links: result.userLinks,
        reasoning: reasoningText,
        usedWebSearch: result.usedWebSearch,
        reusedConversationMemory: result.reusedConversationMemory,
        assistantSearchRequests: result.assistantSearchRequests,
        attachments: result.attachments,
        attachmentWarnings: result.attachmentWarnings,
        timing: result.timing,
        supportsReasoning: result.supportsReasoning,
        deepResearch: result.deepResearch,
      },
      model
    );
    state.pendingAssistantByChat.delete(chatId);
    state.isStreaming = false;
    updateInteractivity();
    stopAttachmentStatusTimer();
    renderAttachmentList();
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
    stopAttachmentStatusTimer();
    renderAttachmentList();
    trackAnalyticsEvent('response_error', {
      type: 'exception',
      message: String(err?.message || err || 'Unknown error').slice(0, 120),
    });
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
    initialUserPrompt: chat.initialUserPrompt || '',
  });
  renderChatList(chat.id);
  stopAttachmentStatusTimer();
  setCurrentChatAttachments(chat.attachments || [], { persist: false });
  renderChat(chat);
  maybeResetDeepResearchForChat(chat.id);
  promptInput.focus();
  trackAnalyticsEvent('chat_created', {
    chat_count: state.chats.length,
    model: chat.model,
  });
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
  stopAttachmentStatusTimer();
  setCurrentChatAttachments(chat.attachments || [], { persist: false });
  renderChat(chat);
  maybeResetDeepResearchForChat(chat.id);
}

function renderChat(chat) {
  updateChatTitle();
  if (!chat.messages?.length) {
    chatArea.innerHTML = '';
    const empty = document.createElement('div');
    empty.classList.add('empty-state');
    empty.innerHTML = `
      <div class="empty-copy">
        <h2>Ready when you are</h2>
        <p>Select a model, drop in context, then ask anything. Your conversations stay on this device.</p>
      </div>
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
      const usedDeepResearch =
        message.meta?.deepResearch &&
        (message.meta.deepResearch.summary ||
          message.meta.deepResearch.answer ||
          (Array.isArray(message.meta.deepResearch.sources) && message.meta.deepResearch.sources.length > 0));
      const storedThought = formatStoredContext(message.meta || {});
      const entry = appendAssistantMessage(message.content, {
        open: state.settings?.openThoughtsByDefault ?? false,
        thoughts: storedThought.context,
        summary: usedDeepResearch ? 'Deep research notes & timing' : usedWeb ? 'Web Context' : 'Context',
      });
      if (storedThought.reasoning) {
        entry.setReasoning(storedThought.reasoning);
      }
      if (storedThought.timing) {
        entry.setTiming(storedThought.timing);
      }
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
  removeEmptyState();
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
  removeEmptyState();
  const openDefault = state.settings?.openThoughtsByDefault ?? false;
  const {
    open = openDefault,
    thoughts = '',
    summary = '',
    loading = false,
  } = options;

  const container = document.createElement('div');
  container.classList.add('message', 'bot');

  const text = document.createElement('div');
  text.classList.add('message-text');
  let loadingIndicator = null;
  let loadingStatusLabel = null;
  let loadingActive = Boolean(loading);
  const actionBar = document.createElement('div');
  actionBar.classList.add('message-actions');
  actionBar.style.display = 'none';

  if (loadingActive) {
    loadingIndicator = document.createElement('div');
    loadingIndicator.classList.add('message-loading');
    loadingIndicator.setAttribute('aria-hidden', 'true');
    const dotsWrapper = document.createElement('div');
    dotsWrapper.classList.add('message-loading-dots');
    for (let i = 0; i < 3; i += 1) {
      const dot = document.createElement('span');
      dotsWrapper.appendChild(dot);
    }
    loadingIndicator.appendChild(dotsWrapper);
    loadingStatusLabel = document.createElement('span');
    loadingStatusLabel.classList.add('message-loading-status');
    loadingStatusLabel.textContent =
      typeof options.loadingStatus === 'string' && options.loadingStatus.trim()
        ? options.loadingStatus.trim()
        : 'Preparing response…';
    loadingIndicator.appendChild(loadingStatusLabel);
    container.classList.add('loading');
    actionBar.appendChild(loadingIndicator);
  }

  setMessageContent(text, content);
  container.appendChild(text);
  container.appendChild(actionBar);

  const details = document.createElement('details');
  details.classList.add('thoughts');
  details.open = open;

  const summaryEl = document.createElement('summary');
  summaryEl.textContent = summary;
  details.appendChild(summaryEl);

  const thoughtsText = document.createElement('pre');
  thoughtsText.classList.add('thoughts-text');
  thoughtsText.textContent = 'No additional context used.';
  details.appendChild(thoughtsText);

  container.appendChild(details);

  chatArea.appendChild(container);
  chatArea.scrollTop = chatArea.scrollHeight;

  const defaultSummary = '';
  let manualSummary = summary && summary.trim() ? summary : '';
  const thoughtState = {
    context: typeof thoughts === 'string' ? thoughts.trim() : '',
    reasoning: '',
    timing: '',
  };

  const updateSummary = () => {
    const hasContext = Boolean(thoughtState.context);
    const hasReasoning = Boolean(thoughtState.reasoning);
    const hasTiming = Boolean(thoughtState.timing);
    let label = manualSummary || defaultSummary;

    if (hasReasoning && hasContext && hasTiming) {
      label = 'Reasoning, Context & Timing';
    } else if (hasReasoning && hasContext) {
      label = 'Reasoning & Context';
    } else if (hasReasoning && hasTiming) {
      label = 'Reasoning & Timing';
    } else if (hasContext && hasTiming) {
      label = 'Context & Timing';
    } else if (hasReasoning) {
      label = 'Reasoning';
    } else if (hasContext && !manualSummary) {
      label = 'Context';
    } else if (hasTiming && !manualSummary) {
      label = 'Timing';
    }

    summaryEl.textContent = label || '';
  };

  const updateThoughtText = () => {
    const segments = [];
    if (thoughtState.reasoning) {
      segments.push(`Reasoning:\n${thoughtState.reasoning}`);
    }
    if (thoughtState.timing) {
      segments.push(`Model timings: ${thoughtState.timing}`);
    }
    if (thoughtState.context) {
      segments.push(thoughtState.context);
    }
    const combined = segments.join('\n\n').trim();
    thoughtsText.textContent = combined || 'No additional context used.';
  };

  updateThoughtText();
  updateSummary();

  const clearLoading = () => {
    if (loadingIndicator) {
      loadingIndicator.remove();
      loadingIndicator = null;
    }
    loadingStatusLabel = null;
    container.classList.remove('loading');
    loadingActive = false;
    updateActionBarVisibility();
  };

  const updateActionBarVisibility = () => {
    const hasContent = Boolean(loadingIndicator) || actionBar.childElementCount > 0;
    actionBar.style.display = hasContent ? 'flex' : 'none';
  };

  updateActionBarVisibility();

  return {
    container,
    setContent: (value) => {
      if (loadingActive && value && value.trim()) {
        clearLoading();
      }
      setMessageContent(text, value);
    },
    setSummary: (value) => {
      manualSummary = value && value.trim() ? value.trim() : '';
      updateSummary();
    },
    setThought: (value) => {
      thoughtState.context = value?.trim() || '';
      updateThoughtText();
      updateSummary();
    },
    setTiming: (value) => {
      thoughtState.timing = value?.trim() || '';
      updateThoughtText();
      updateSummary();
    },
    setReasoning: (value) => {
      const trimmed = value?.trim() || '';
      if (thoughtState.reasoning === trimmed) {
        return;
      }
      thoughtState.reasoning = trimmed;
      updateThoughtText();
      updateSummary();
    },
    openThoughts: () => {
      details.open = true;
    },
    closeThoughts: () => {
      details.open = false;
    },
    addActionButton: (button) => {
      actionBar.appendChild(button);
      updateActionBarVisibility();
    },
    clearActions: () => {
      const buttons = actionBar.querySelectorAll('button');
      buttons.forEach((btn) => btn.remove());
      updateActionBarVisibility();
    },
    setLoadingStatus: (value) => {
      if (loadingStatusLabel && typeof value === 'string') {
        loadingStatusLabel.textContent = value.trim() || 'Preparing response…';
      }
    },
    stopLoading: clearLoading,
    getContent: () => text.textContent || '',
    getThoughtState: () => ({ ...thoughtState }),
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
  if (!state.currentChat.initialUserPrompt) {
    state.currentChat.initialUserPrompt = content;
    const summary = state.chats.find((chat) => chat.id === state.currentChatId);
    if (summary) {
      summary.initialUserPrompt = content;
    }
  }
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
  const reasoningText = contextData?.reasoning || '';
  const usedWebSearch =
    contextData?.usedWebSearch !== undefined ? Boolean(contextData.usedWebSearch) : Boolean(contextText);

  const meta = {
    context: contextText,
    contextQueries,
    contextRetrievedAt,
    usedWebSearch,
    userLinks: contextData?.links || [],
  };

  if (contextData?.reusedConversationMemory !== undefined) {
    meta.reusedConversationMemory = Boolean(contextData.reusedConversationMemory);
  }

  if (reasoningText) {
    meta.reasoning = reasoningText;
    meta.supportsReasoning = true;
  } else if (contextData?.supportsReasoning !== undefined) {
    meta.supportsReasoning = Boolean(contextData.supportsReasoning);
  }

  if (Number.isFinite(contextData?.assistantSearchRequests)) {
    meta.assistantSearchRequests = contextData.assistantSearchRequests;
  }

  if (contextData?.timing) {
    meta.timing = contextData.timing;
  }

  if (Array.isArray(contextData?.attachments) && contextData.attachments.length) {
    meta.attachments = contextData.attachments;
  }

  if (Array.isArray(contextData?.attachmentWarnings) && contextData.attachmentWarnings.length) {
    meta.attachmentWarnings = contextData.attachmentWarnings;
  }

  if (contextData?.deepResearch) {
    meta.deepResearch = contextData.deepResearch;
  }

  state.currentChat.messages.push({
    role: 'assistant',
    content,
    createdAt: timestamp,
    meta,
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
  if (sendButton) {
    sendButton.disabled = state.isStreaming;
  }
  if (newChatButton) {
    newChatButton.disabled = state.isStreaming;
  }
  if (attachButton) {
    attachButton.disabled = state.isStreaming;
  }
  if (sidebarToggleBtn) {
    sidebarToggleBtn.disabled = state.isStreaming;
  }
  if (!state.settingsPanelOpen) {
    settingsButton.disabled = state.isStreaming;
  }
  if (deleteAllChatsButton) {
    deleteAllChatsButton.disabled = state.isStreaming;
  }
  if (composerDeepResearchButton) {
    composerDeepResearchButton.disabled = state.isStreaming;
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

async function handleDeleteAllChats() {
  if (!deleteAllChatsButton || state.isStreaming) {
    return;
  }

  const confirmed = window.confirm(
    'Delete all chats permanently? This cannot be undone.'
  );
  if (!confirmed) {
    return;
  }

  const originalText = deleteAllChatsButton.textContent;
  deleteAllChatsButton.disabled = true;
  deleteAllChatsButton.textContent = 'Deleting…';

  try {
    const result = await window.api.deleteAllChats();
    if (result?.error) {
      throw new Error(result.error);
    }

    state.isStreaming = false;
    state.pendingAssistantByChat.clear();
    state.chats = [];
    state.currentChat = null;
    state.currentChatId = null;
    chatArea.innerHTML = '';
    chatListNav.innerHTML = '';

    await handleNewChat();
    updateInteractivity();
  } catch (err) {
    console.error('Failed to delete chats:', err);
    window.alert(err?.message || 'Unable to delete chats right now.');
  } finally {
    deleteAllChatsButton.textContent = originalText;
    deleteAllChatsButton.disabled = false;
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

function formatContextThought({ message, context, queries, retrievedAt, attachments, warnings }) {
  const lines = [];
  const rawContext = typeof context === 'string' ? context : '';
  const hasEmbeddedQueries =
    rawContext.toLowerCase().includes('queries used:');
  const hasEmbeddedTimestamp =
    rawContext.toLowerCase().includes('fresh context collected');
  let displayContext = rawContext;
  const attachmentsMarker = 'Uploaded files provided by the user:';
  const markerIndex = displayContext.indexOf(attachmentsMarker);
  if (markerIndex !== -1) {
    displayContext = displayContext.slice(0, markerIndex).trimEnd();
  }
  if (message) {
    lines.push(message);
  }
  if (retrievedAt && !hasEmbeddedTimestamp) {
    lines.push(`Retrieved: ${formatTimestamp(retrievedAt)}`);
  }
  if (displayContext?.trim()) {
    lines.push('', displayContext.trim());
  }
  if (queries?.length && !hasEmbeddedQueries) {
    lines.push('', 'Queries:');
    queries.forEach((query) => {
      lines.push(`• ${query}`);
    });
  }
  if (Array.isArray(attachments) && attachments.length) {
    lines.push('', 'Uploaded files:');
    attachments.forEach((file) => {
      const sizeLabel = formatBytes(file.size || 0);
      const suffix = file.truncated ? ' (truncated)' : '';
      lines.push(`• ${file.name || 'attachment'} — ${sizeLabel}${suffix}`);
    });
  }
  if (Array.isArray(warnings) && warnings.length) {
    lines.push('', 'Notes:');
    warnings.forEach((warning) => {
      lines.push(`• ${warning}`);
    });
  }
  return lines.join('\n').trim() || 'No additional context used.';
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  if (ms >= 1000) {
    const seconds = ms / 1000;
    const precision = seconds >= 10 ? 1 : 2;
    return `${seconds.toFixed(precision)}s`;
  }
  return `${Math.round(ms)}ms`;
}

function formatTimingSummary(timing) {
  if (!timing || typeof timing !== 'object') {
    return '';
  }

  const load = formatDuration(timing.loadMs ?? timing.firstTokenMs);
  const generation = formatDuration(timing.generationMs ?? timing.streamMs);
  const total = formatDuration(timing.totalMs);
  const tokens = Number.isFinite(timing.tokens) && timing.tokens > 0 ? `${timing.tokens} tokens` : '';
  const rate = Number.isFinite(timing.tokensPerSecond) && timing.tokensPerSecond > 0
    ? `${timing.tokensPerSecond} tok/s`
    : '';

  const parts = [];
  if (load) {
    parts.push(`Load ${load}`);
  }
  if (generation) {
    parts.push(`Generation ${generation}`);
  }
  if (!generation && total) {
    parts.push(`Total ${total}`);
  }
  if (tokens) {
    parts.push(tokens);
  }
  if (rate) {
    parts.push(rate);
  }

  return parts.join(' · ');
}

function formatStoredContext(meta = {}) {
  const hasQueries = Array.isArray(meta.contextQueries) && meta.contextQueries.length > 0;
  const hasLinks = Array.isArray(meta.userLinks) && meta.userLinks.length > 0;
  const usedDeepResearch =
    meta.deepResearch &&
    (meta.deepResearch.summary ||
      meta.deepResearch.answer ||
      (Array.isArray(meta.deepResearch.sources) && meta.deepResearch.sources.length > 0));
  let context = meta.context;

  if ((!context || !context.trim()) && hasLinks) {
    context = ['User-provided links:', ...meta.userLinks.map((link) => `• ${link}`)].join('\n');
  }

  const message = usedDeepResearch
    ? 'Deep research findings captured before this reply.'
    : meta.usedWebSearch
      ? 'Context used when drafting this reply.'
      : meta.reusedConversationMemory
        ? 'Relied on earlier conversation and stored context.'
      : hasLinks
        ? 'User-provided links supplied by the user.'
        : hasQueries
          ? 'Web search disabled (saved candidate queries).'
          : 'No additional context used.';

  const contextBlock = formatContextThought({
    message,
    context,
    queries: meta.contextQueries,
    retrievedAt: meta.contextRetrievedAt,
    attachments: meta.attachments,
    warnings: meta.attachmentWarnings,
  });

  const reasoning = typeof meta.reasoning === 'string' ? meta.reasoning.trim() : '';
  const timing = formatTimingSummary(meta.timing);

  return {
    context: contextBlock,
    reasoning,
    timing,
  };
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
  const next = Boolean(collapsed);
  state.sidebarCollapsed = next;
  document.body.classList.toggle('sidebar-collapsed', next);
  if (sidebarToggleBtn) {
    sidebarToggleBtn.setAttribute('aria-pressed', String(next));
    sidebarToggleBtn.textContent = next ? 'Show Chats' : 'Hide Chats';
  }
  if (sidebarCollapseToggle && sidebarCollapseToggle.checked !== next) {
    sidebarCollapseToggle.checked = next;
  }
}

function applyTheme(themeSetting) {
  document.body.classList.remove('theme-light', 'theme-dark', 'theme-cream');
}

function resolveTheme(themeSetting) {
  return 'light';
}
