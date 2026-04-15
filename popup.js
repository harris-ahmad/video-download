// popup.js - Handles UI logic and orchestrates video detection

// DOM elements
const loadingEl = document.getElementById('loading');
const emptyStateEl = document.getElementById('empty-state');
const errorStateEl = document.getElementById('error-state');
const videoListEl = document.getElementById('video-list');
const refreshBtn = document.getElementById('refresh-btn');

// Initialize on popup open
document.addEventListener('DOMContentLoaded', () => {
  scanForVideos();

  // Refresh button handler
  refreshBtn.addEventListener('click', () => {
    scanForVideos();
  });
});

/**
 * Main function to scan for videos from both content script and background
 */
async function scanForVideos() {
  // Show loading state
  showState('loading');

  try {
    // Get the current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      showState('error');
      return;
    }

    // Check if we can access this page (chrome:// pages are restricted)
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      showState('error');
      return;
    }

    // Get videos from content script (DOM videos)
    let contentVideos = [];
    try {
      const contentResponse = await chrome.tabs.sendMessage(tab.id, { action: 'getVideos' });
      contentVideos = contentResponse.videos || [];
    } catch (error) {
      console.warn('Could not get videos from content script:', error);
      // Content script might not be injected yet, continue anyway
    }

    // Get videos from background script (network intercepted videos)
    let networkVideos = [];
    try {
      const networkResponse = await chrome.runtime.sendMessage({
        action: 'getNetworkVideos',
        tabId: tab.id
      });
      networkVideos = networkResponse.videos || [];
    } catch (error) {
      console.warn('Could not get videos from background:', error);
    }

    // Merge and deduplicate videos by URL
    const allVideos = mergeVideos(contentVideos, networkVideos);

    // Display results
    if (allVideos.length === 0) {
      showState('empty');
    } else {
      displayVideos(allVideos);
      showState('videos');
    }
  } catch (error) {
    console.error('Error scanning for videos:', error);
    showState('error');
  }
}

/**
 * Merges videos from content and network, removes duplicates by URL
 * Prefers content script data (has better metadata)
 */
function mergeVideos(contentVideos, networkVideos) {
  const videoMap = new Map();

  // Add content videos first (they have better metadata)
  contentVideos.forEach(video => {
    videoMap.set(video.src, video);
  });

  // Add network videos only if URL not already seen
  networkVideos.forEach(video => {
    if (!videoMap.has(video.src)) {
      videoMap.set(video.src, video);
    }
  });

  return Array.from(videoMap.values());
}

/**
 * Creates and displays video cards in the UI
 */
function displayVideos(videos) {
  // Clear existing content
  videoListEl.innerHTML = '';

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

  // URL (truncated with tooltip)
  const urlDiv = document.createElement('div');
  urlDiv.className = 'video-url';
  urlDiv.textContent = truncateUrl(video.src);
  urlDiv.title = video.src; // Full URL on hover

  infoDiv.appendChild(resolutionDiv);
  infoDiv.appendChild(durationDiv);
  infoDiv.appendChild(urlDiv);

  // Download button
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
    // Blob URLs need special handling
    btn.textContent = 'Download';
    btn.addEventListener('click', () => downloadBlob(video.src, btn));
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
async function downloadBlob(blobUrl, button) {
  button.textContent = 'Downloading...';
  button.disabled = true;

  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Ask content script to convert blob to data URL
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'downloadBlob',
      url: blobUrl
    });

    if (response.success) {
      // Download the data URL
      const filename = generateFilename('blob', 'video');
      await chrome.downloads.download({
        url: response.dataUrl,
        filename: filename,
        saveAs: true
      });
      button.textContent = '✓ Downloaded';
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    console.error('Blob download error:', error);
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
 * Downloads a video using direct URL
 */
async function downloadDirect(url, button) {
  button.textContent = 'Downloading...';
  button.disabled = true;

  try {
    const filename = generateFilename(url, 'video');
    await chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    });
    button.textContent = '✓ Downloaded';
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

/**
 * Downloads an HLS video (m3u8) by fetching and concatenating segments
 */
async function downloadHLSVideo(manifestUrl, button) {
  const originalText = button.textContent;
  button.textContent = 'Preparing...';
  button.disabled = true;

  try {
    // Download HLS segments with progress callback
    const videoBlob = await downloadHLS(manifestUrl, (current, total) => {
      button.textContent = `Downloading ${current}/${total}`;
    });

    // Trigger download
    const filename = generateFilename(manifestUrl, 'hls-video') + '.ts';
    triggerBlobDownload(videoBlob, filename);

    button.textContent = '✓ Downloaded';
  } catch (error) {
    console.error('HLS download error:', error);
    button.textContent = '✗ Failed';
    button.className = 'download-btn error';
    alert(`HLS download failed: ${error.message}\n\nTip: Some HLS streams use master playlists. Try opening the .m3u8 URL in a new tab and looking for variant playlist URLs.`);
  } finally {
    setTimeout(() => {
      button.textContent = originalText;
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
    // Download DASH segments with progress callback
    const videoBlob = await downloadDASH(manifestUrl, (current, total) => {
      button.textContent = `Downloading ${current}/${total}`;
    });

    // Trigger download
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

/**
 * Generates a filename from URL or type
 */
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

/**
 * Shows the appropriate UI state
 */
function showState(state) {
  // Hide all states
  loadingEl.classList.add('hidden');
  emptyStateEl.classList.add('hidden');
  errorStateEl.classList.add('hidden');
  videoListEl.classList.add('hidden');

  // Show requested state
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
