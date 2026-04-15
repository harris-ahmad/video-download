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

let settings = {
  defaultQuality: 'best',
  saveAs: true,
  autoDownload: false,
  minDuration: 0,
  minResolution: 0,
  theme: 'dark',
  maxConcurrent: 3,
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
});

async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  if (stored.settings) {
    settings = stored.settings;
  }
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

function mergeVideos(contentVideos, networkVideos) {
  const videoMap = new Map();

  contentVideos.forEach(video => {
    if (passesFilters(video)) {
      videoMap.set(video.src, video);
    }
  });

  networkVideos.forEach(video => {
    if (!videoMap.has(video.src) && passesFilters(video)) {
      videoMap.set(video.src, video);
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

  videosBadgeEl.textContent = videos.length;
  if (videos.length > 0) {
    videosBadgeEl.classList.remove('hidden');
  } else {
    videosBadgeEl.classList.add('hidden');
  }

  videos.forEach((video, index) => {
    const card = createVideoCard(video, index);
    videoListEl.appendChild(card);
  });
}

/**
 * Creates a single video card element
 */
function createVideoCard(video, index) {
  const card = document.createElement('div');
  card.className = 'video-card';

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
    warningDiv.textContent = '⚡ Click button to capture';
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
    if (video.blobCaptured) {
      btn.textContent = 'Download';
      btn.addEventListener('click', () => downloadBlob(video.src, btn, video));
    } else {
      btn.textContent = 'Capture & Download';
      btn.style.background = '#FF8C42';
      btn.addEventListener('click', () => captureBlobNow(video.src, btn));
    }
  } else {
    // Direct download for mp4, webm, ogg, mov, unknown
    btn.textContent = 'Download';
    btn.addEventListener('click', () => downloadDirect(video.src, btn));
  }

  return btn;
}

/**
 * Downloads a blob URL by fetching it from content script
 */
async function captureBlobNow(blobUrl, button) {
  const durationInput = prompt(
    'How many seconds to record?\n\n' +
    'Enter duration (default: 60 seconds)\n' +
    'Note: Very long recordings (>10 min) may cause memory issues',
    '60'
  );

  if (durationInput === null) return;

  const duration = Math.max(parseInt(durationInput) || 60, 1);

  const recordFromStart = confirm(
    `Will record ${duration} seconds.\n\n` +
    '✓ Yes - Record from beginning\n' +
    '✗ No - Record from current position'
  );

  button.textContent = recordFromStart ? 'Rewinding...' : 'Starting...';
  button.disabled = true;
  button.classList.add('recording');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let elapsed = 0;
    const countdownInterval = setInterval(() => {
      elapsed++;
      button.textContent = `Recording ${elapsed}/${duration}s`;
    }, 1000);

    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tab.id, {
          action: 'forceCapture',
          url: blobUrl,
          recordFromStart: recordFromStart,
          duration: duration
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Recording timeout')), (duration + 10) * 1000))
      ]);

      clearInterval(countdownInterval);

      if (response.success) {
        button.textContent = 'Processing...';

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `recorded-video-${timestamp}.webm`;

        await chrome.downloads.download({
          url: response.dataUrl,
          filename: filename,
          saveAs: settings.saveAs
        });

        button.textContent = '✓ Recorded';
        button.style.background = '#2ECC71';

        setTimeout(() => {
          alert('Video recorded successfully!\n\n✓ Saved as: ' + filename + '\n\n✓ Duration: ' + duration + ' seconds\n\nNote: The video is in WebM format. If you need MP4, you can convert it using HandBrake or FFmpeg.');
        }, 500);
      } else {
        throw new Error(response.error);
      }
    } catch (innerError) {
      clearInterval(countdownInterval);
      throw innerError;
    }
  } catch (error) {
    console.error('Capture failed:', error);
    button.textContent = '✗ Failed';
    button.className = 'download-btn error';

    let errorMsg = 'Failed to record video.\n\n';
    if (error.message === 'Recording timeout') {
      errorMsg += 'Recording timed out. Try:\n';
      errorMsg += '• Shorter duration\n';
      errorMsg += '• Ensure video is playing\n\n';
    } else {
      errorMsg += 'Common issues:\n';
      errorMsg += '• Video must be playing (not paused)\n';
      errorMsg += '• Some sites use DRM protection\n';
      errorMsg += '• Browser may block recording\n\n';
    }
    errorMsg += 'Alternative: Try right-clicking video → "Save video as"';

    alert(errorMsg);
  } finally {
    button.classList.remove('recording');
    setTimeout(() => {
      button.textContent = 'Capture & Download';
      button.disabled = false;
      button.className = 'download-btn';
      button.style.background = '#FF8C42';
    }, 3000);
  }
}

async function downloadBlob(blobUrl, button, video) {
  button.textContent = 'Downloading...';
  button.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'downloadBlob',
      url: blobUrl
    });

    if (response.success) {
      const filename = generateFilename('blob', 'video');
      await chrome.downloads.download({
        url: response.dataUrl,
        filename: filename,
        saveAs: settings.saveAs
      });
      button.textContent = '✓ Done';
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    console.error('Blob download error:', error);
    button.textContent = '✗ Expired';
    button.className = 'download-btn error';

    let errorMsg = 'Blob URL has expired.\n\n';

    if (video && !video.blobCaptured) {
      errorMsg += 'The blob was detected but could not be captured in time.\n\n';
    }

    errorMsg += 'Tips:\n';
    errorMsg += '• Refresh the page and try downloading immediately\n';
    errorMsg += '• Try right-clicking the video → "Save video as"\n';
    errorMsg += '• Some sites intentionally block blob downloads';

    alert(errorMsg);
  } finally {
    setTimeout(() => {
      button.textContent = 'Download';
      button.disabled = false;
      button.className = 'download-btn';
    }, 3000);
  }
}

async function downloadDirect(url, button) {
  button.textContent = 'Starting...';
  button.disabled = true;

  try {
    const filename = generateFilename(url, 'video');
    const response = await chrome.runtime.sendMessage({
      action: 'startDownload',
      url: url,
      filename: filename,
      saveAs: settings.saveAs
    });

    if (response.downloadId) {
      button.textContent = '✓ Queued';
    }
  } catch (error) {
    console.error('Download error:', error);
    button.textContent = '✗ Failed';
    button.className = 'download-btn error';
  } finally {
    setTimeout(() => {
      button.textContent = 'Download';
      button.disabled = false;
      button.className = 'download-btn';
    }, 2000);
  }
}

async function downloadHLSVideo(manifestUrl, button) {
  button.textContent = 'Loading...';
  button.disabled = true;

  try {
    const variants = await getHLSVariants(manifestUrl);

    button.textContent = 'Download';
    button.disabled = false;

    if (settings.defaultQuality === 'ask' || variants.length === 1) {
      showQualitySelector(variants, (selectedVariant) => {
        startHLSDownload(selectedVariant, manifestUrl, button);
      });
    } else {
      const selectedVariant = selectQualityByPreference(variants, settings.defaultQuality);
      startHLSDownload(selectedVariant, manifestUrl, button);
    }
  } catch (error) {
    console.error('Failed to load variants:', error);
    button.textContent = 'Download';
    button.disabled = false;
    alert(`Failed to load quality options: ${error.message}`);
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

async function startHLSDownload(variant, manifestUrl, button) {
  button.textContent = 'Downloading...';
  button.disabled = true;

  try {
    const videoBlob = await downloadHLSWithQuality(variant.url, (current, total, status) => {
      if (status === 'Remuxing to MP4') {
        button.textContent = 'Remuxing to MP4...';
      } else {
        button.textContent = `Downloading ${current}/${total}`;
      }
    });

    const filename = generateFilename(manifestUrl, 'hls-video') + '.mp4';
    triggerBlobDownload(videoBlob, filename);
    button.textContent = '✓ Done';
  } catch (error) {
    console.error('Download failed:', error);
    button.textContent = '✗ Failed';
    button.className = 'download-btn error';
  } finally {
    setTimeout(() => {
      button.textContent = 'Download';
      button.disabled = false;
      button.className = 'download-btn';
    }, 2000);
  }
}

/**
 * Downloads a DASH video (mpd) by fetching and concatenating segments
 */
async function downloadDASHVideo(manifestUrl, button) {
  const originalText = button.textContent;
  button.textContent = 'Preparing...';
  button.disabled = true;

  try {
    const videoBlob = await downloadDASH(manifestUrl, (current, total, status) => {
      if (status === 'Muxing MP4') {
        button.textContent = 'Muxing MP4...';
      } else if (status === 'Downloading video') {
        button.textContent = `Video ${current}/${total}`;
      } else if (status === 'Downloading audio') {
        button.textContent = `Audio ${current}/${total}`;
      } else {
        button.textContent = `${current}/${total}`;
      }
    });

    const filename = generateFilename(manifestUrl, 'dash-video') + '.mp4';
    triggerBlobDownload(videoBlob, filename);

    button.textContent = '✓ Downloaded';
  } catch (error) {
    console.error('DASH download error:', error);
    button.textContent = '✗ Failed';
    button.className = 'download-btn error';
    alert(`DASH download failed: ${error.message}`);
  } finally {
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
      button.className = 'download-btn';
    }, 2000);
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
