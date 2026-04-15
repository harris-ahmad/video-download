const defaultSettings = {
  defaultQuality: 'best',
  saveAs: true,
  autoDownload: false,
  minDuration: 0,
  minResolution: 0,
  theme: 'dark',
  maxConcurrent: 3,
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
  const settings = stored.settings || defaultSettings;

  document.getElementById('default-quality').value = settings.defaultQuality;
  document.getElementById('save-as').checked = settings.saveAs;
  document.getElementById('auto-download').checked = settings.autoDownload;
  document.getElementById('min-duration').value = settings.minDuration;
  document.getElementById('min-resolution').value = settings.minResolution;
  document.getElementById('theme').value = settings.theme;
  document.getElementById('max-concurrent').value = settings.maxConcurrent;
  document.getElementById('network-detection').checked = settings.networkDetection;
}

async function saveSettings() {
  const settings = {
    defaultQuality: document.getElementById('default-quality').value,
    saveAs: document.getElementById('save-as').checked,
    autoDownload: document.getElementById('auto-download').checked,
    minDuration: parseInt(document.getElementById('min-duration').value),
    minResolution: parseInt(document.getElementById('min-resolution').value),
    theme: document.getElementById('theme').value,
    maxConcurrent: parseInt(document.getElementById('max-concurrent').value),
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
