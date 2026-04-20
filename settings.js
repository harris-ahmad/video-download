const defaultSettings = {
  defaultQuality: 'best',
  saveAs: true,
  autoDownload: false,
  minDuration: 0,
  minResolution: 0,
  theme: 'dark',
  maxConcurrent: 3,
  hlsConcurrency: 16,
  networkDetection: true
};

const saveBtn = document.getElementById('save-settings');
const resetBtn = document.getElementById('reset-settings');
const saveStatus = document.getElementById('save-status');

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  saveBtn.addEventListener('click', saveSettings);
  resetBtn.addEventListener('click', resetSettings);
});

async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  const settings = { ...defaultSettings, ...(stored.settings || {}) };

  document.getElementById('default-quality').value = settings.defaultQuality;
  document.getElementById('save-as').checked = settings.saveAs;
  document.getElementById('auto-download').checked = settings.autoDownload;
  document.getElementById('min-duration').value = settings.minDuration;
  document.getElementById('min-resolution').value = settings.minResolution;
  document.getElementById('theme').value = settings.theme;
  document.getElementById('max-concurrent').value = clampNumber(settings.maxConcurrent, 1, 10, 3);
  document.getElementById('hls-concurrency').value = clampNumber(settings.hlsConcurrency, 1, 32, 16);
  document.getElementById('network-detection').checked = settings.networkDetection;
}

async function saveSettings() {
  const maxConcurrent = clampNumber(document.getElementById('max-concurrent').value, 1, 10, 3);
  const hlsConcurrency = clampNumber(document.getElementById('hls-concurrency').value, 1, 32, 16);

  const settings = {
    defaultQuality: document.getElementById('default-quality').value,
    saveAs: document.getElementById('save-as').checked,
    autoDownload: document.getElementById('auto-download').checked,
    minDuration: Math.max(0, parseInt(document.getElementById('min-duration').value, 10) || 0),
    minResolution: Math.max(0, parseInt(document.getElementById('min-resolution').value, 10) || 0),
    theme: document.getElementById('theme').value,
    maxConcurrent: maxConcurrent,
    hlsConcurrency: hlsConcurrency,
    networkDetection: document.getElementById('network-detection').checked
  };

  try {
    await chrome.storage.sync.set({ settings });
    showStatus('Settings saved successfully!', 'success');
  } catch (error) {
    showStatus('Failed to save settings', 'error');
  }
}

async function resetSettings() {
  try {
    await chrome.storage.sync.set({ settings: defaultSettings });
    loadSettings();
    showStatus('Settings reset to defaults', 'success');
  } catch (error) {
    showStatus('Failed to reset settings', 'error');
  }
}

function showStatus(message, type) {
  saveStatus.textContent = message;
  saveStatus.className = `save-status ${type}`;
  saveStatus.classList.remove('hidden');

  setTimeout(() => {
    saveStatus.classList.add('hidden');
  }, 3000);
}

function clampNumber(value, min, max, fallback) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}
