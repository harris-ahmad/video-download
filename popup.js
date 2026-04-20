const loadingEl = document.getElementById('loading');
const emptyStateEl = document.getElementById('empty-state');
const errorStateEl = document.getElementById('error-state');
const videoListEl = document.getElementById('video-list');
const refreshBtn = document.getElementById('refresh-btn');
const qualityModal = document.getElementById('quality-modal');
const qualityOptionsEl = document.getElementById('quality-options');
const modalClose = document.querySelector('.modal-close');
const downloadQueueEl = document.getElementById('download-queue');
const queueItemsEl = document.getElementById('queue-items');
const clearQueueBtn = document.getElementById('clear-queue');
const convertTsBtn = document.getElementById('convert-ts-btn');

const tabButtons = document.querySelectorAll('.tab-btn');
const networkListEl = document.getElementById('network-list');
const networkEmptyEl = document.getElementById('network-empty');
const clearNetworkBtn = document.getElementById('clear-network');
const networkFilterEl = document.getElementById('network-filter');
const sizeFilterEl = document.getElementById('size-filter');
const videosBadgeEl = document.getElementById('videos-badge');
const networkBadgeEl = document.getElementById('network-badge');

let networkRefreshInterval = null;
let networkHidden = false;

// Batch download state
const selectedVideos = new Set();
let allVideos = [];

let settings = {
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

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  scanForVideos();
  updateQueueDisplay();
  setInterval(updateQueueDisplay, 1000);

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  refreshBtn.addEventListener('click', () => {
    const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
    if (activeTab === 'videos') {
      scanForVideos();
    } else {
      networkHidden = false;
      loadNetworkMonitor();
    }
  });

  modalClose.addEventListener('click', () => {
    qualityModal.classList.add('hidden');
  });

  qualityModal.addEventListener('click', (e) => {
    if (e.target === qualityModal) {
      qualityModal.classList.add('hidden');
    }
  });

  clearQueueBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearQueue' }, () => {
      queueItemsEl.innerHTML = '';
      downloadQueueEl.classList.add('hidden');
    });
  });

  if (convertTsBtn) {
    convertTsBtn.addEventListener('click', convertLatestTsToMp4);
  }

  clearNetworkBtn.addEventListener('click', () => {
    networkHidden = true;
    networkListEl.innerHTML = '';
    networkListEl.classList.add('hidden');
    networkEmptyEl.classList.remove('hidden');
    networkBadgeEl.classList.add('hidden');
  });

  networkFilterEl.addEventListener('change', () => {
    networkHidden = false;
    loadNetworkMonitor();
  });

  sizeFilterEl.addEventListener('change', () => {
    networkHidden = false;
    loadNetworkMonitor();
  });

  // Batch download controls
  document.getElementById('select-all-btn').addEventListener('click', selectAllVideos);
  document.getElementById('deselect-all-btn').addEventListener('click', deselectAllVideos);
  document.getElementById('download-selected-btn').addEventListener('click', downloadSelectedVideos);
});

async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  settings = { ...settings, ...(stored.settings || {}) };
}

async function convertLatestTsToMp4(options = {}) {
  if (!convertTsBtn) return;

  const silent = options.silent === true;

  const originalText = convertTsBtn.textContent;
  convertTsBtn.disabled = true;
  convertTsBtn.textContent = 'Converting...';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'convertLatestTsToMp4' });

    if (!response?.success) {
      const reason = response?.error || 'Unknown conversion error';
      throw new Error(reason);
    }

    if (!silent) {
      alert(`MP4 conversion completed successfully.\n\nOutput:\n${response.outputPath}`);
    }
  } catch (error) {
    const message = String(error?.message || error);

    if (message.includes('Specified native messaging host not found')) {
      if (!silent) {
        alert(
          'Native helper is not installed yet.\n\n' +
          'Install it once, then conversion is one-click:\n' +
          '1) Open project terminal\n' +
          '2) Run: npm run native:install:macos -- <your-extension-id>\n\n' +
          'Find extension ID at chrome://extensions (Developer mode).'
        );
      }
      return;
    }

    if (message.includes('Native host has exited')) {
      if (!silent) {
        alert(
          'Native helper started but exited before responding.\n\n' +
          'Please reinstall the helper launcher and reload the extension:\n' +
          '1) npm run native:install:macos -- <your-extension-id>\n' +
          '2) Reload extension in chrome://extensions\n\n' +
          'Also ensure ffmpeg is installed and node is available.'
        );
      }
      return;
    }

    if (!silent) {
      alert(`TS→MP4 conversion failed:\n\n${message}`);
    }
  } finally {
    convertTsBtn.disabled = false;
    convertTsBtn.textContent = originalText;
  }
}

async function startHLSDownloadInPage(variantUrl, manifestUrl, hlsOptions) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found for persistent HLS download');
  }

  const taskId = `hls-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  console.log('[startHLSDownloadInPage] Sending task to tab', tab.id, 'variantUrl:', variantUrl);

  const filename = buildHlsDownloadFilename(manifestUrl, variant?.segmentType);

  const response = await chrome.tabs.sendMessage(tab.id, {
    action: 'startHlsDownloadTask',
    taskId: taskId,
    variantUrl: variantUrl,
    filename: filename,
    segmentType: variant?.segmentType || 'unknown',
    hlsConcurrency: hlsOptions?.hlsConcurrency
  });

  console.log('[startHLSDownloadInPage] Response from tab:', response);

  if (!response?.accepted) {
    throw new Error(response?.error || 'Tab did not accept HLS download task');
  }

  return { accepted: true, filename, taskId };
}

function buildHlsDownloadFilename(manifestUrl, segmentType = 'unknown') {
  const raw = String(generateFilename(manifestUrl, 'hls-video') || '').trim() || `hls-video-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const withoutKnownVideoSuffix = raw.replace(/\.(mp4|ts|m3u8|mpd|webm|mov)$/i, '');
  const extension = segmentType === 'fmp4' ? '.mp4' : '.ts';
  return `${withoutKnownVideoSuffix}${extension}`;
}

/**
 * Main function to scan for videos from both content script and background
 */
function switchTab(tabName) {
  tabButtons.forEach(btn => {
    if (btn.dataset.tab === tabName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
    content.classList.add('hidden');
  });

  if (networkRefreshInterval) {
    clearInterval(networkRefreshInterval);
    networkRefreshInterval = null;
  }

  if (tabName === 'videos') {
    const videosTab = document.getElementById('videos-tab');
    videosTab.classList.add('active');
    videosTab.classList.remove('hidden');
  } else if (tabName === 'network') {
    const networkTab = document.getElementById('network-tab');
    networkTab.classList.add('active');
    networkTab.classList.remove('hidden');
    networkHidden = false;
    loadNetworkMonitor();
    networkRefreshInterval = setInterval(loadNetworkMonitor, 2000);
  }
}

async function loadNetworkMonitor() {
  if (networkHidden) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    chrome.runtime.sendMessage(
      { action: 'getNetworkRequests', tabId: tab.id },
      (response) => {
        if (networkHidden) return;

        if (response && response.requests) {
          displayNetworkRequests(response.requests);
        } else {
          displayNetworkRequests([]);
        }
      }
    );
  } catch (error) {
    console.error('Failed to load network requests:', error);
    if (!networkHidden) {
      displayNetworkRequests([]);
    }
  }
}

function displayNetworkRequests(requests) {
  try {
    if (!networkFilterEl || !sizeFilterEl) {
      console.error('Filter elements are null!');
      return;
    }

    networkBadgeEl.textContent = requests.length;
    if (requests.length > 0) {
      networkBadgeEl.classList.remove('hidden');
    } else {
      networkBadgeEl.classList.add('hidden');
    }

    const typeFilter = networkFilterEl.value;
    const sizeFilter = parseInt(sizeFilterEl.value);

    let filteredRequests = requests;

    if (typeFilter === 'video') {
      filteredRequests = filteredRequests.filter(r => r.type === 'video');
    } else if (typeFilter === 'audio') {
      filteredRequests = filteredRequests.filter(r => r.type === 'audio');
    }

    if (sizeFilter > 0) {
      filteredRequests = filteredRequests.filter(r => {
        if (!r.size) return false;
        return r.size >= sizeFilter * 1024;
      });
    }

    filteredRequests.sort((a, b) => {
      const sizeA = a.size || 0;
      const sizeB = b.size || 0;
      return sizeB - sizeA;
    });

    if (filteredRequests.length === 0) {
      networkListEl.classList.add('hidden');
      networkEmptyEl.classList.remove('hidden');
      return;
    }

    networkEmptyEl.classList.add('hidden');
    networkListEl.classList.remove('hidden');
    networkListEl.innerHTML = '';

    filteredRequests.reverse().forEach((request) => {
      const item = document.createElement('div');
      item.className = 'network-item';

      const header = document.createElement('div');
      header.className = 'network-item-header';

      const typeSpan = document.createElement('span');
      typeSpan.className = `network-type ${request.type}`;
      typeSpan.textContent = request.type;

      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'network-size';
      if (request.size) {
        sizeSpan.textContent = formatFileSize(request.size);
      } else {
        sizeSpan.textContent = 'Size unknown';
      }

      header.appendChild(typeSpan);
      header.appendChild(sizeSpan);

      const urlDiv = document.createElement('div');
      urlDiv.className = 'network-url';
      urlDiv.textContent = request.url;
      urlDiv.title = request.url;

      const actions = document.createElement('div');
      actions.className = 'network-actions';

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'network-download-btn';
      downloadBtn.textContent = 'Download';
      downloadBtn.addEventListener('click', () => {
        chrome.downloads.download({ url: request.url, saveAs: settings.saveAs });
      });

      const copyBtn = document.createElement('button');
      copyBtn.className = 'network-copy-btn';
      copyBtn.textContent = 'Copy URL';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(request.url);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = 'Copy URL';
        }, 1500);
      });

      actions.appendChild(downloadBtn);
      actions.appendChild(copyBtn);

      item.appendChild(header);
      item.appendChild(urlDiv);
      item.appendChild(actions);

      networkListEl.appendChild(item);
    });
  } catch (error) {
    console.error('Error in displayNetworkRequests:', error);
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function formatSpeed(bytesPerSecond) {
  const speed = Number(bytesPerSecond || 0);
  if (!Number.isFinite(speed) || speed <= 0) {
    return '0 B/s';
  }

  if (speed < 1024) return `${speed.toFixed(0)} B/s`;
  if (speed < 1024 * 1024) return `${(speed / 1024).toFixed(1)} KB/s`;
  if (speed < 1024 * 1024 * 1024) return `${(speed / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(speed / (1024 * 1024 * 1024)).toFixed(1)} GB/s`;
}

async function scanForVideos() {
  showState('loading');
  console.log('Starting video scan...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('Active tab:', tab?.url);

    if (!tab || !tab.id) {
      console.error('No active tab found');
      showState('error');
      return;
    }

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      console.warn('Cannot access chrome:// pages');
      showState('error');
      return;
    }

    let contentVideos = [];
    try {
      console.log('Requesting videos from content script...');
      const contentResponse = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { action: 'getVideos' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
      ]);
      contentVideos = contentResponse.videos || [];
      console.log('Content script found:', contentVideos.length, 'videos');
    } catch (error) {
      console.warn('Could not get videos from content script:', error.message);
    }

    let networkVideos = [];
    try {
      console.log('Requesting videos from background...');
      const networkResponse = await chrome.runtime.sendMessage({
        action: 'getNetworkVideos',
        tabId: tab.id
      });
      networkVideos = networkResponse.videos || [];
      console.log('Background found:', networkVideos.length, 'videos');
    } catch (error) {
      console.warn('Could not get videos from background:', error.message);
    }

    const allVideos = mergeVideos(contentVideos, networkVideos);
    console.log('Total videos after merge:', allVideos.length);

    if (allVideos.length === 0) {
      console.log('No videos found, showing empty state');
      showState('empty');
    } else {
      console.log('Displaying', allVideos.length, 'videos');
      displayVideos(allVideos);
      showState('videos');
    }
  } catch (error) {
    console.error('Error scanning for videos:', error);
    showState('error');
  }
}

function isAudioUrl(url) {
  const audioExtensions = ['.mp3', '.aac', '.wav', '.flac', '.m4a', '.opus'];

  let pathname;
  try {
    const urlObj = new URL(url);
    pathname = urlObj.pathname.toLowerCase();
  } catch {
    pathname = url.split('?')[0].toLowerCase();
  }

  return audioExtensions.some(ext => pathname.endsWith(ext));
}

function hasUsableMetadata(video) {
  const width = Number(video?.width || 0);
  const height = Number(video?.height || 0);
  const duration = Number(video?.duration || 0);
  return (width > 0 && height > 0) || duration > 0;
}

function isLikelyAdUrl(url) {
  const normalized = String(url || '').toLowerCase();
  const adMarkers = [
    'admatic',
    'doubleclick',
    'googlesyndication',
    'adservice',
    'outstream',
    'prebid',
    'teads',
    'vast',
    '/ads/',
    'preroll',
    'midroll',
    'postroll'
  ];

  return adMarkers.some(marker => normalized.includes(marker));
}

function isLikelySegmentOrChunkUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return (
    normalized.includes('.ts') ||
    normalized.includes('.m4s') ||
    /\/seg-\d+/i.test(normalized) ||
    /\/chunk-?\d+/i.test(normalized) ||
    /\/fragment-?\d+/i.test(normalized) ||
    /\/index-v\d+-a\d+\.m3u8/i.test(normalized)
  );
}

function isLikelyMasterPlaylistUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return normalized.includes('master.m3u8') || normalized.includes('/master/');
}

function shouldDisplayVideoCard(video) {
  if (!video?.src) return false;

  const type = String(video.type || '').toLowerCase();
  const hasMetadata = hasUsableMetadata(video);

  if (video.sourceKind === 'network' && !hasMetadata) {
    return false;
  }

  if (isAudioUrl(video.src) || isLikelyAdUrl(video.src) || isLikelySegmentOrChunkUrl(video.src)) {
    return false;
  }

  if (type === 'unknown' && !hasMetadata) {
    return false;
  }

  if (type === 'hls' && !hasMetadata && !isLikelyMasterPlaylistUrl(video.src)) {
    return false;
  }

  return true;
}

function mergeVideos(contentVideos, networkVideos) {
  const videoMap = new Map();

  contentVideos.forEach(video => {
    const enriched = { ...video, sourceKind: 'content' };
    if (passesFilters(enriched) && shouldDisplayVideoCard(enriched)) {
      videoMap.set(enriched.src, enriched);
    }
  });

  networkVideos.forEach(video => {
    // Filter out audio files - they should only appear in Network Monitor
    const enriched = { ...video, sourceKind: 'network' };
    if (!videoMap.has(enriched.src) && passesFilters(enriched) && !isAudioUrl(enriched.src) && shouldDisplayVideoCard(enriched)) {
      videoMap.set(enriched.src, enriched);
    }
  });

  return Array.from(videoMap.values());
}

function passesFilters(video) {
  if (settings.minDuration > 0 && video.duration) {
    if (video.duration < settings.minDuration) return false;
  }

  if (settings.minResolution > 0 && video.height) {
    if (video.height < settings.minResolution) return false;
  }

  return true;
}

/**
 * Creates and displays video cards in the UI
 */
function displayVideos(videos) {
  videoListEl.innerHTML = '';
  allVideos = videos;
  selectedVideos.clear();

  videosBadgeEl.textContent = videos.length;
  if (videos.length > 0) {
    videosBadgeEl.classList.remove('hidden');
  } else {
    videosBadgeEl.classList.add('hidden');
  }

  const batchControlsEl = document.getElementById('batch-controls');
  if (videos.length > 1) {
    batchControlsEl.classList.remove('hidden');
  } else {
    batchControlsEl.classList.add('hidden');
  }

  videos.forEach((video, index) => {
    const card = createVideoCard(video, index);
    videoListEl.appendChild(card);
  });

  updateBatchControls();
}

/**
 * Creates a single video card element
 */
function createVideoCard(video, index) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.dataset.videoSrc = video.src;

  // Checkbox for batch selection
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'video-checkbox';
  checkbox.dataset.videoIndex = index;
  checkbox.addEventListener('change', (e) => {
    if (e.target.checked) {
      selectedVideos.add(video.src);
      card.classList.add('selected');
    } else {
      selectedVideos.delete(video.src);
      card.classList.remove('selected');
    }
    updateBatchControls();
  });
  card.appendChild(checkbox);

  // Thumbnail
  if (video.thumbnail) {
    const thumbnailDiv = document.createElement('div');
    thumbnailDiv.className = 'video-thumbnail';

    const thumbnailImg = document.createElement('img');
    thumbnailImg.src = video.thumbnail;
    thumbnailImg.alt = 'Video thumbnail';

    thumbnailDiv.appendChild(thumbnailImg);
    card.appendChild(thumbnailDiv);
  }

  // Type badge
  const badge = document.createElement('span');
  badge.className = `type-badge type-${video.type}`;
  badge.textContent = video.type.toUpperCase();

  // Video info container
  const infoDiv = document.createElement('div');
  infoDiv.className = 'video-info';

  // Resolution
  const resolutionDiv = document.createElement('div');
  resolutionDiv.className = 'video-meta';
  if (video.width && video.height) {
    resolutionDiv.textContent = `📐 ${video.width}×${video.height}`;
  } else {
    resolutionDiv.textContent = '📐 Unknown';
  }

  // Duration
  const durationDiv = document.createElement('div');
  durationDiv.className = 'video-meta';
  if (video.duration) {
    durationDiv.textContent = `⏱️ ${formatDuration(video.duration)}`;
  } else {
    durationDiv.textContent = '⏱️ Unknown';
  }

  const urlDiv = document.createElement('div');
  urlDiv.className = 'video-url';
  urlDiv.textContent = truncateUrl(video.src);
  urlDiv.title = video.src;

  infoDiv.appendChild(resolutionDiv);
  infoDiv.appendChild(durationDiv);

  if (video.type === 'blob' && video.blobCaptured === false) {
    const warningDiv = document.createElement('div');
    warningDiv.className = 'video-meta';
    warningDiv.style.color = '#FF8C42';
    warningDiv.textContent = '⚡ Blob stream - trying automatic extraction';
    infoDiv.appendChild(warningDiv);
  }

  infoDiv.appendChild(urlDiv);

  const downloadBtn = createDownloadButton(video);

  // Assemble card
  card.appendChild(badge);
  card.appendChild(infoDiv);
  card.appendChild(downloadBtn);

  return card;
}

/**
 * Creates download button with appropriate behavior based on video type
 */
function createDownloadButton(video) {
  const btn = document.createElement('button');
  btn.className = 'download-btn';

  // Handle different video types
  if (video.type === 'hls') {
    // HLS download - fetch and concatenate segments
    btn.textContent = 'Download';
    btn.addEventListener('click', () => downloadHLSVideo(video.src, btn));
  } else if (video.type === 'dash') {
    // DASH download - fetch and concatenate segments
    btn.textContent = 'Download';
    btn.addEventListener('click', () => downloadDASHVideo(video.src, btn));
  } else if (video.type === 'blob') {
    btn.textContent = 'Download';
    if (!video.blobCaptured) {
      btn.style.background = '#FF8C42';
    }
    btn.addEventListener('click', () => downloadBlob(video.src, btn, video));
  } else {
    // Direct download for mp4, webm, ogg, mov, unknown
    btn.textContent = 'Download';
    btn.addEventListener('click', () => downloadDirect(video.src, btn));
  }

  return btn;
}

async function downloadBlob(blobUrl, button, video, batchMode = false) {
  if (button) {
    button.textContent = 'Resolving stream...';
    button.disabled = true;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const sourceResolved = await tryDownloadBlobFromResolvedSources(blobUrl, tab.id, button, batchMode);
    if (sourceResolved) {
      if (button) button.textContent = '✓ Done';
      return;
    }

    if (button) {
      button.textContent = 'Capturing fallback...';
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'downloadBlob',
      url: blobUrl
    });

    if (response.success) {
      const filename = generateFilename('blob', 'video');
      await chrome.downloads.download({
        url: response.dataUrl,
        filename: filename,
        saveAs: batchMode ? false : settings.saveAs
      });
      if (button) button.textContent = '✓ Done';
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    console.error('Blob download error:', error);
    if (button) {
      button.textContent = '✗ Expired';
      button.className = 'download-btn error';
    }

    if (!batchMode) {
      let errorMsg = 'Blob URL has expired.\n\n';

      if (video && !video.blobCaptured) {
        errorMsg += 'This appears to be a player-managed stream.\n\n';
      }

      errorMsg += 'Tips:\n';
      errorMsg += '• Refresh the page and try downloading immediately\n';
      errorMsg += '• Keep the video playing when fallback capture starts\n';
      errorMsg += '• Try right-clicking the video → "Save video as"\n';
      errorMsg += '• Some sites intentionally block blob downloads';

      alert(errorMsg);
    }
    throw error;
  } finally {
    if (button) {
      setTimeout(() => {
        button.textContent = 'Download';
        button.disabled = false;
        button.className = 'download-btn';
      }, 3000);
    }
  }
}

async function tryDownloadBlobFromResolvedSources(blobUrl, tabId, button, batchMode) {
  try {
    const sourceResponse = await chrome.tabs.sendMessage(tabId, {
      action: 'resolveBlobSource',
      url: blobUrl
    });

    const sourceCandidates = sourceResponse?.success ? sourceResponse.candidates || [] : [];
    const networkCandidates = await getNetworkCandidatesForBlob(tabId);

    const mergedCandidates = prioritizeBlobCandidates([...sourceCandidates, ...networkCandidates]);

    for (const candidate of mergedCandidates) {
      try {
        if (button) {
          const label = candidate.type === 'unknown' ? 'stream' : candidate.type.toUpperCase();
          button.textContent = `Trying ${label}...`;
        }

        if (candidate.type === 'hls') {
          console.log('Attempting HLS download from candidate:', candidate.url);
          await downloadHLSVideo(candidate.url, button, batchMode);
          console.log('HLS download succeeded');
          return true;
        }

        if (candidate.type === 'dash') {
          console.log('Attempting DASH download from candidate:', candidate.url);
          await downloadDASHVideo(candidate.url, button, batchMode);
          console.log('DASH download succeeded');
          return true;
        }

        if (['mp4', 'webm', 'mov', 'unknown'].includes(candidate.type)) {
          console.log('Attempting direct download from candidate:', candidate.url);
          await downloadDirect(candidate.url, button, batchMode);
          console.log('Direct download succeeded');
          return true;
        }
      } catch (candidateError) {
        console.warn('Blob source candidate failed:', candidate.url, candidateError.message);
      }
    }

    console.log('All blob source candidates failed, returning false');
    return false;
  } catch (error) {
    console.warn('Failed to resolve blob source candidates:', error);
    return false;
  }
}

async function getNetworkCandidatesForBlob(tabId) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getNetworkRequests',
      tabId: tabId
    });

    const requests = response?.requests || [];

    return requests
      .filter(request => request.type === 'video' && request.url && !request.url.startsWith('blob:'))
      .slice(-30)
      .map(request => ({
        url: request.url,
        type: detectMediaTypeFromUrl(request.url),
        reason: 'network.request'
      }));
  } catch (error) {
    console.warn('Failed to read network requests for blob fallback:', error);
    return [];
  }
}

function detectMediaTypeFromUrl(url) {
  const lower = (url || '').toLowerCase().split('?')[0];
  if (lower.endsWith('.m3u8')) return 'hls';
  if (lower.endsWith('.mpd')) return 'dash';
  if (lower.endsWith('.mp4')) return 'mp4';
  if (lower.endsWith('.webm')) return 'webm';
  if (lower.endsWith('.mov')) return 'mov';
  return 'unknown';
}

function prioritizeBlobCandidates(candidates) {
  const seen = new Set();
  const deduped = [];

  candidates.forEach(candidate => {
    if (!candidate?.url || seen.has(candidate.url)) return;
    seen.add(candidate.url);
    deduped.push(candidate);
  });

  const typePriority = {
    hls: 1,
    dash: 2,
    mp4: 3,
    webm: 4,
    mov: 5,
    unknown: 6
  };

  return deduped.sort((a, b) => {
    const pa = typePriority[a.type] || 99;
    const pb = typePriority[b.type] || 99;
    return pa - pb;
  });
}

async function downloadDirect(url, button, batchMode = false) {
  if (button) {
    button.textContent = 'Starting...';
    button.disabled = true;
  }

  try {
    const filename = generateFilename(url, 'video');
    const response = await chrome.runtime.sendMessage({
      action: 'startDownload',
      url: url,
      filename: filename,
      saveAs: batchMode ? false : settings.saveAs
    });

    if (response.downloadId) {
      if (button) button.textContent = '✓ Queued';
    }
  } catch (error) {
    console.error('Download error:', error);
    if (button) {
      button.textContent = '✗ Failed';
      button.className = 'download-btn error';
    }
    throw error;
  } finally {
    if (button) {
      setTimeout(() => {
        button.textContent = 'Download';
        button.disabled = false;
        button.className = 'download-btn';
      }, 2000);
    }
  }
}

async function downloadHLSVideo(manifestUrl, button, batchMode = false) {
  if (button) {
    button.textContent = 'Loading...';
    button.disabled = true;
  }

  try {
    const hlsOptions = await buildHLSDownloadOptions();
    const variants = await getHLSVariants(manifestUrl, hlsOptions);

    if (button) {
      button.textContent = 'Download';
      button.disabled = false;
    }

    if (batchMode) {
      // In batch mode, auto-select best quality
      const selectedVariant = preferStableHLSVariant(variants, selectQualityByPreference(variants, 'best'));
      return await startHLSDownload(selectedVariant, manifestUrl, button, batchMode, hlsOptions);
    } else if (settings.defaultQuality === 'ask' || variants.length === 1) {
      showQualitySelector(variants, (selectedVariant) => {
        const safeVariant = preferStableHLSVariant(variants, selectedVariant);
        startHLSDownload(safeVariant, manifestUrl, button, false, hlsOptions);
      });
    } else {
      const selectedVariant = preferStableHLSVariant(variants, selectQualityByPreference(variants, settings.defaultQuality));
      startHLSDownload(selectedVariant, manifestUrl, button, false, hlsOptions);
    }
  } catch (error) {
    console.error('Failed to load variants:', error);
    if (button) {
      button.textContent = 'Download';
      button.disabled = false;
    }
    if (!batchMode) {
      showHLSError(error);
    }
    throw error;
  }
}

function selectQualityByPreference(variants, preference) {
  if (preference === 'best') {
    return variants[variants.length - 1];
  }
  if (preference === 'low') {
    return variants[0];
  }

  const resolutionMap = {
    'high': 1080,
    'medium': 720
  };

  const targetHeight = resolutionMap[preference];
  if (!targetHeight) return variants[variants.length - 1];

  let best = variants[0];
  let bestDiff = Infinity;

  variants.forEach(v => {
    const height = parseInt(v.resolution?.split('x')[1] || '0');
    const diff = Math.abs(height - targetHeight);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = v;
    }
  });

  return best;
}

function preferStableHLSVariant(variants, selectedVariant) {
  if (!Array.isArray(variants) || variants.length === 0 || !selectedVariant) {
    return selectedVariant;
  }

  if (selectedVariant.segmentType === 'ts' || selectedVariant.segmentType === 'unknown') {
    return selectedVariant;
  }

  const stableVariants = variants.filter(v => v.segmentType === 'ts' || v.segmentType === 'unknown');
  if (stableVariants.length === 0) {
    return selectedVariant;
  }

  const selectedHeight = parseInt(selectedVariant.resolution?.split('x')[1] || '0', 10);
  const selectedBandwidth = Number(selectedVariant.bandwidth || 0);

  let bestStable = stableVariants[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of stableVariants) {
    const candidateHeight = parseInt(candidate.resolution?.split('x')[1] || '0', 10);
    const candidateBandwidth = Number(candidate.bandwidth || 0);
    const heightDiff = Math.abs(candidateHeight - selectedHeight);
    const bandwidthDiff = Math.abs(candidateBandwidth - selectedBandwidth) / 1000000;
    const score = (heightDiff * 10) + bandwidthDiff;

    if (score < bestScore) {
      bestScore = score;
      bestStable = candidate;
    }
  }

  console.warn('Switching from fMP4 variant to stable variant:', {
    from: selectedVariant,
    to: bestStable
  });

  return bestStable;
}

async function startHLSDownload(variant, manifestUrl, button, batchMode = false, hlsOptions = null) {
  if (button) {
    button.textContent = 'Downloading...';
    button.disabled = true;
  }

  console.log('[startHLSDownload] Starting with variant:', variant.label, 'manifestUrl:', manifestUrl);

  if (variant?.segmentType === 'fmp4' && button) {
    button.title = 'Fragmented MP4 stream detected; saving as .mp4 for compatibility';
  }

  try {
    const effectiveOptions = hlsOptions || await buildHLSDownloadOptions();
    console.log('[startHLSDownload] Calling startHLSDownloadInPage with variant.url:', variant.url);
    await startHLSDownloadInPage(variant.url, manifestUrl, effectiveOptions);

    console.log('[startHLSDownload] Success, setting button to Started');
    if (button) button.textContent = '✓ Started';
  } catch (error) {
    console.warn('[startHLSDownload] Persistent HLS download failed, trying fallback:', error);

    let fallbackTaskId = null;

    try {
      const effectiveOptions = hlsOptions || await buildHLSDownloadOptions();
      const filename = buildHlsDownloadFilename(manifestUrl, variant?.segmentType);
      fallbackTaskId = `hls-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      chrome.runtime.sendMessage({
        action: 'hlsTaskStart',
        taskId: fallbackTaskId,
        filename: filename,
        variantUrl: variant.url
      });

      let lastProgressSentAt = 0;
      let lastTotalSegments = 0;

      console.log('[startHLSDownload] Fallback: downloading in popup context');
      const videoBlob = await downloadHLSWithQuality(variant.url, (current, total, status) => {
        if (Number.isFinite(Number(total)) && Number(total) >= 0) {
          lastTotalSegments = Number(total);
        }

        const now = Date.now();
        const shouldSend = now - lastProgressSentAt >= 200 || current === total;
        if (shouldSend) {
          lastProgressSentAt = now;
          chrome.runtime.sendMessage({
            action: 'hlsTaskProgress',
            taskId: fallbackTaskId,
            current: current,
            total: total,
            status: status || 'Downloading segments'
          });
        }

        if (button) {
          if (status === 'Finalizing TS') {
            button.textContent = 'Finalizing TS...';
          } else {
            button.textContent = 'Downloading...';
          }
        }
      }, effectiveOptions);

      console.log('[startHLSDownload] Fallback download complete, triggering download');
      triggerBlobDownload(videoBlob, filename);
      chrome.runtime.sendMessage({
        action: 'hlsTaskComplete',
        taskId: fallbackTaskId,
        totalSegments: lastTotalSegments,
        statusText: 'Saved to Downloads'
      });
      if (button) button.textContent = '✓ Done';
    } catch (fallbackError) {
      console.error('[startHLSDownload] Download failed:', fallbackError);

      if (fallbackTaskId) {
        chrome.runtime.sendMessage({
          action: 'hlsTaskFailed',
          taskId: fallbackTaskId,
          error: String(fallbackError?.message || fallbackError)
        });
      }

      if (button) {
        button.textContent = '✗ Failed';
        button.className = 'download-btn error';
      }
      if (!batchMode) {
        showHLSError(fallbackError);
      }
      throw fallbackError;
    }
  } finally {
    if (button) {
      // Only reset if it failed (error state)
      // Don't reset on success—let "✓ Started" or "✓ Done" remain visible
      if (button.className === 'download-btn error') {
        setTimeout(() => {
          button.textContent = 'Download';
          button.disabled = false;
          button.className = 'download-btn';
        }, 2000);
      }
    }
  }
}

function getHLSDownloadOptions() {
  const parsed = parseInt(settings.hlsConcurrency, 10);
  const normalized = Number.isFinite(parsed) ? parsed : 16;

  return {
    hlsConcurrency: Math.max(1, Math.min(32, normalized))
  };
}

async function buildHLSDownloadOptions() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const baseOptions = getHLSDownloadOptions();

  if (!tab?.id) {
    return baseOptions;
  }

  return {
    ...baseOptions,
    fetchTextFn: createHLSTextFetcher(tab.id),
    fetchSegmentFn: createHLSSegmentFetcher(tab.id)
  };
}

function createHLSTextFetcher(tabId) {
  return async (url) => {
    let nativeResponse = null;
    let nativeText = null;

    try {
      nativeResponse = await fetch(url, {
        credentials: 'include',
        cache: 'no-store'
      });

      if (nativeResponse.ok) {
        nativeText = await nativeResponse.text();
        
        // Validate that we got actual M3U8, not HTML
        if (nativeText && nativeText.trim().startsWith('#EXTM3U')) {
          console.log('Native HLS playlist fetch successful, using native response');
          return new Response(nativeText, {
            status: 200,
            headers: {
              'content-type': 'application/vnd.apple.mpegurl'
            }
          });
        }
        
        // Got 200 OK but content is not M3U8 (probably HTML redirect/error page)
        console.warn('Native fetch returned 200 OK but content is HTML/not M3U8:', nativeText?.substring(0, 100));
      }
    } catch (error) {
      console.warn('Native HLS playlist fetch failed:', error);
    }

    console.log('Falling back to tab-context fetch for manifest...');
    try {
      const fallback = await chrome.tabs.sendMessage(tabId, {
        action: 'fetchMediaText',
        url: url
      });

      if (fallback?.success && typeof fallback.text === 'string') {
        if (fallback.ok) {
          console.log('Tab-context fetch successful with valid content');
        } else {
          console.warn('Tab-context fetch returned non-OK content, passing body through for deeper parsing');
        }

        return new Response(fallback.text, {
          status: typeof fallback.status === 'number' ? fallback.status : 200,
          headers: {
            'content-type': fallback.contentType || 'application/vnd.apple.mpegurl'
          }
        });
      }

      if (fallback?.success) {
        console.warn('Tab-context fetch returned status:', fallback.status);
      }
    } catch (error) {
      console.warn('Tab-context HLS playlist fetch fallback failed:', error);
    }

    if (nativeResponse) {
      console.warn('All fallbacks failed, returning native response (may be HTML)');
      return nativeResponse;
    }

    throw new Error('Manifest request failed (network error)');
  };
}

function createHLSSegmentFetcher(tabId) {
  return async (url) => {
    let nativeResponse = null;

    try {
      nativeResponse = await fetch(url, {
        credentials: 'include',
        cache: 'no-store'
      });

      if (nativeResponse.ok) {
        return nativeResponse;
      }
    } catch (error) {
      console.warn('Native HLS segment fetch failed, trying tab-context fallback:', error);
    }

    try {
      const fallback = await chrome.tabs.sendMessage(tabId, {
        action: 'fetchMediaBlob',
        url: url
      });

      if (fallback?.success && fallback.ok) {
        return new Response(fallback.buffer, {
          status: 200,
          headers: {
            'content-type': fallback.contentType || 'application/octet-stream'
          }
        });
      }

      if (fallback?.success && typeof fallback.status === 'number') {
        return new Response('', { status: fallback.status });
      }
    } catch (error) {
      console.warn('Tab-context HLS segment fetch fallback failed:', error);
    }

    if (nativeResponse) {
      return nativeResponse;
    }

    throw new Error('Segment request failed (network error)');
  };
}

function showHLSError(error) {
  if (error?.code === 'HLS_ENCRYPTED') {
    const methods = Array.isArray(error.encryptionMethods) && error.encryptionMethods.length > 0
      ? error.encryptionMethods.join(', ')
      : 'Unknown';

    alert(
      'This HLS stream is encrypted and cannot be downloaded directly by this extension.\n\n' +
      `Encryption method(s): ${methods}\n\n` +
      'Tip: This usually requires decryption keys from the player session.'
    );
    return;
  }

  if (error?.code === 'HLS_SEGMENT_DOWNLOAD_FAILED') {
    alert(
      'HLS download failed because some segments could not be fetched.\n\n' +
      `Failed segments: ${error.failedSegments}/${error.totalSegments}\n\n` +
      'Try reducing HLS concurrency in Settings, then retry.'
    );
    return;
  }

  if (error?.code === 'HLS_AUTH_FORBIDDEN') {
    alert(
      'HLS download failed with authorization error (401/403).\n\n' +
      'This stream likely requires session-bound headers/cookies from the webpage.\n\n' +
      `Failed segments: ${error.failedSegments || 0}/${error.totalSegments || 0}\n\n` +
      'Tip: Keep the video page open and retry immediately.'
    );
    return;
  }

  alert(`HLS download failed: ${error?.message || 'Unknown error'}`);
}

/**
 * Downloads a DASH video (mpd) by fetching and concatenating segments
 */
async function downloadDASHVideo(manifestUrl, button, batchMode = false) {
  const originalText = button ? button.textContent : '';
  if (button) {
    button.textContent = 'Preparing...';
    button.disabled = true;
  }

  try {
    const videoBlob = await downloadDASH(manifestUrl, (current, total, status) => {
      if (button) {
        if (status === 'Muxing MP4') {
          button.textContent = 'Muxing MP4...';
        } else if (status === 'Downloading video') {
          button.textContent = `Video ${current}/${total}`;
        } else if (status === 'Downloading audio') {
          button.textContent = `Audio ${current}/${total}`;
        } else {
          button.textContent = `${current}/${total}`;
        }
      }
    });

    const filename = generateFilename(manifestUrl, 'dash-video') + '.mp4';
    triggerBlobDownload(videoBlob, filename);

    if (button) button.textContent = '✓ Downloaded';
  } catch (error) {
    console.error('DASH download error:', error);
    if (button) {
      button.textContent = '✗ Failed';
      button.className = 'download-btn error';
    }
    if (!batchMode) {
      alert(`DASH download failed: ${error.message}`);
    }
    throw error;
  } finally {
    if (button) {
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
        button.className = 'download-btn';
      }, 2000);
    }
  }
}

function showQualitySelector(variants, onSelect) {
  qualityOptionsEl.innerHTML = '';

  variants.forEach((variant) => {
    const option = document.createElement('div');
    option.className = 'quality-option';

    const info = document.createElement('div');
    info.className = 'quality-info';

    const label = document.createElement('div');
    label.className = 'quality-label';
    label.textContent = variant.label;

    const details = document.createElement('div');
    details.className = 'quality-details';
    const bandwidth = variant.bandwidth ? `${(variant.bandwidth / 1000000).toFixed(1)} Mbps` : 'Unknown bitrate';
    details.textContent = bandwidth;

    info.appendChild(label);
    info.appendChild(details);

    const badge = document.createElement('div');
    badge.className = 'quality-badge';
    if (variant.isBest) {
      badge.classList.add('best');
      badge.textContent = 'Best';
    } else if (variant.isLow) {
      badge.classList.add('low');
      badge.textContent = 'Low';
    } else {
      badge.textContent = 'Mid';
    }

    option.appendChild(info);
    option.appendChild(badge);

    option.addEventListener('click', () => {
      qualityModal.classList.add('hidden');
      onSelect(variant);
    });

    qualityOptionsEl.appendChild(option);
  });

  qualityModal.classList.remove('hidden');
}

function generateFilename(url, fallback) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const parts = pathname.split('/');
    const lastPart = parts[parts.length - 1];

    if (lastPart && lastPart.includes('.')) {
      return lastPart;
    }
  } catch (error) {
    // Invalid URL, use fallback
  }

  // Generate timestamped filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${fallback}-${timestamp}.mp4`;
}

/**
 * Formats duration in seconds to mm:ss
 */
function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return 'Unknown';

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Truncates URL to last 60 characters
 */
function truncateUrl(url) {
  if (url.length <= 60) return url;
  return '...' + url.slice(-60);
}

function showState(state) {
  loadingEl.classList.add('hidden');
  emptyStateEl.classList.add('hidden');
  errorStateEl.classList.add('hidden');
  videoListEl.classList.add('hidden');

  switch (state) {
    case 'loading':
      loadingEl.classList.remove('hidden');
      break;
    case 'empty':
      emptyStateEl.classList.remove('hidden');
      break;
    case 'error':
      errorStateEl.classList.remove('hidden');
      break;
    case 'videos':
      videoListEl.classList.remove('hidden');
      break;
  }
}

async function updateQueueDisplay() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getQueueStatus' });
    const queue = response.queue || [];

    if (queue.length === 0) {
      downloadQueueEl.classList.add('hidden');
      return;
    }

    downloadQueueEl.classList.remove('hidden');
    queueItemsEl.innerHTML = '';

    queue.forEach(item => {
      const queueItem = document.createElement('div');
      queueItem.className = 'queue-item';

      const header = document.createElement('div');
      header.className = 'queue-item-header';

      const filename = document.createElement('div');
      filename.className = 'queue-filename';
      filename.textContent = item.filename || 'Downloading...';
      filename.title = item.filename;

      const status = document.createElement('div');
      status.className = `queue-status ${item.status}`;
      status.textContent = item.status;

      header.appendChild(filename);
      header.appendChild(status);

      queueItem.appendChild(header);

      if (item.status === 'downloading') {
        const speedRow = document.createElement('div');
        speedRow.className = 'video-meta';
        if (item.progressUnit === 'segments') {
          speedRow.textContent = `🎞️ ${item.progress || 0}/${item.total || 0} segments${item.statusText ? ` • ${item.statusText}` : ''}`;
        } else {
          speedRow.textContent = `🚀 ${formatSpeed(item.speedBps)}${item.total > 0 ? ` • ${formatFileSize(item.progress)} / ${formatFileSize(item.total)}` : ''}`;
        }
        queueItem.appendChild(speedRow);
      } else if (item.statusText) {
        const statusDetail = document.createElement('div');
        statusDetail.className = 'video-meta';
        statusDetail.textContent = item.statusText;
        queueItem.appendChild(statusDetail);
      }

      if (item.status === 'downloading' && item.total > 0) {
        const progressBar = document.createElement('div');
        progressBar.className = 'queue-progress-bar';

        const progressFill = document.createElement('div');
        progressFill.className = 'queue-progress-fill';
        const percent = (item.progress / item.total) * 100;
        progressFill.style.width = `${percent}%`;

        progressBar.appendChild(progressFill);
        queueItem.appendChild(progressBar);
      }

      queueItemsEl.appendChild(queueItem);
    });
  } catch (error) {
    console.error('Failed to update queue:', error);
  }
}

/**
 * Batch Download Functions
 */

function selectAllVideos() {
  const checkboxes = document.querySelectorAll('.video-checkbox');
  checkboxes.forEach(checkbox => {
    if (!checkbox.checked) {
      checkbox.checked = true;
      const videoSrc = checkbox.closest('.video-card').dataset.videoSrc;
      selectedVideos.add(videoSrc);
      checkbox.closest('.video-card').classList.add('selected');
    }
  });
  updateBatchControls();
}

function deselectAllVideos() {
  const checkboxes = document.querySelectorAll('.video-checkbox');
  checkboxes.forEach(checkbox => {
    if (checkbox.checked) {
      checkbox.checked = false;
      checkbox.closest('.video-card').classList.remove('selected');
    }
  });
  selectedVideos.clear();
  updateBatchControls();
}

function updateBatchControls() {
  const selectedCountEl = document.getElementById('selected-count');
  const downloadSelectedBtn = document.getElementById('download-selected-btn');

  // Check if elements exist (they might be temporarily removed during download)
  if (selectedCountEl) {
    selectedCountEl.textContent = selectedVideos.size;
  }

  if (downloadSelectedBtn) {
    if (selectedVideos.size > 0) {
      downloadSelectedBtn.disabled = false;
    } else {
      downloadSelectedBtn.disabled = true;
    }
  }
}

async function downloadSelectedVideos() {
  if (selectedVideos.size === 0) return;

  const downloadBtn = document.getElementById('download-selected-btn');
  const originalText = downloadBtn.innerHTML;

  downloadBtn.disabled = true;
  downloadBtn.innerHTML = `Downloading... (<span id="selected-count">${selectedVideos.size}</span>)`;

  const selectedUrls = Array.from(selectedVideos);
  const selectedVideoObjs = allVideos.filter(v => selectedUrls.includes(v.src));

  let completed = 0;
  let failed = 0;

  for (let i = 0; i < selectedVideoObjs.length; i++) {
    const video = selectedVideoObjs[i];
    const remaining = selectedVideoObjs.length - i;

    try {
      // Show what's happening
      if (video.type === 'blob' && !video.blobCaptured) {
        downloadBtn.innerHTML = `Capturing blob... (<span id="selected-count">${remaining}</span> left)`;
      } else if (video.type === 'hls' || video.type === 'dash') {
        downloadBtn.innerHTML = `Processing ${video.type.toUpperCase()}... (<span id="selected-count">${remaining}</span> left)`;
      } else {
        downloadBtn.innerHTML = `Downloading... (<span id="selected-count">${remaining}</span> left)`;
      }

      await downloadVideoInBatch(video);
      completed++;
    } catch (error) {
      console.error(`Failed to download ${video.src}:`, error);
      failed++;
    }

    // Small delay between downloads to avoid overwhelming the system
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Show completion message
  if (failed === 0) {
    downloadBtn.innerHTML = `✓ Downloaded ${completed}`;
    setTimeout(() => {
      downloadBtn.innerHTML = originalText;
      downloadBtn.disabled = false;
    }, 2000);
  } else {
    downloadBtn.innerHTML = `⚠ ${completed} OK, ${failed} Failed`;
    setTimeout(() => {
      downloadBtn.innerHTML = originalText;
      downloadBtn.disabled = false;
    }, 3000);
  }

  // Deselect all after batch download
  deselectAllVideos();
}

async function downloadVideoInBatch(video) {
  if (video.type === 'hls') {
    return await downloadHLSVideo(video.src, null, true);
  } else if (video.type === 'dash') {
    return await downloadDASHVideo(video.src, null, true);
  } else if (video.type === 'blob') {
    return await downloadBlob(video.src, null, video, true);
  } else {
    return await downloadDirect(video.src, null, true);
  }
}
