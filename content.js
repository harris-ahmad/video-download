const blobDataCache = new Map();
let dynamicVideosCache = [];
let currentUrl = location.href;
const captionRecorderState = {
    active: false,
    buffer: [],
    lastSnapshot: '',
    observer: null,
    intervalId: null
};

// Clear caches when navigating to a new page
function clearCaches() {
  blobDataCache.clear();
  dynamicVideosCache = [];
    stopCaptionRecording(true);
  console.log('Video caches cleared due to navigation');
}

// Detect navigation and clear caches
function checkForNavigation() {
  if (location.href !== currentUrl) {
    console.log('Navigation detected:', currentUrl, '->', location.href);
    currentUrl = location.href;
    clearCaches();
  }
}

// Check for navigation every 500ms (for SPAs like YouTube)
setInterval(checkForNavigation, 500);

// Also clear on page show (handles back/forward navigation)
window.addEventListener('pageshow', () => {
  checkForNavigation();
});

// Check if current page is YouTube homepage or feed
function isYouTubeHomepage() {
  const url = location.href;
  const hostname = location.hostname;

  // Check if it's YouTube domain
  if (!hostname.includes('youtube.com')) {
    return false;
  }

  // Homepage patterns
  const homepagePatterns = [
    /^https?:\/\/(www\.)?youtube\.com\/?$/,           // youtube.com or youtube.com/
    /^https?:\/\/(www\.)?youtube\.com\/feed/,         // youtube.com/feed/*
    /^https?:\/\/(www\.)?youtube\.com\/\?/,           // youtube.com/?...
    /^https?:\/\/(www\.)?youtube\.com\/#/,            // youtube.com/#...
    /^https?:\/\/(www\.)?youtube\.com\/results/,      // youtube.com/results (search results)
    /^https?:\/\/(www\.)?youtube\.com\/trending/,     // youtube.com/trending
  ];

  // If URL matches any homepage pattern, return true
  for (const pattern of homepagePatterns) {
    if (pattern.test(url)) {
      console.log('[Video Filter] On homepage/feed - filtering enabled');
      return true;
    }
  }

  // Check if on video watch page (watch page should always allow all videos)
  const isWatchPage = url.includes('/watch');
  if (isWatchPage) {
    console.log('[Video Filter] On watch page - showing all videos');
    return false;
  }

  // Other YouTube pages (channels, playlists, etc.) - enable filtering
  console.log('[Video Filter] On other YouTube page - filtering enabled');
  return true;
}

function detectVideos() {
  const videos = [];
  const seenUrls = new Set();

  scanDocument(document, seenUrls, videos);
  scanIframes(seenUrls, videos);
  scanShadowRoots(document.body, seenUrls, videos);

  return videos;

  function scanDocument(doc, seenUrls, videos) {
      const videoElements = doc.querySelectorAll("video");

      videoElements.forEach(video => {
          if (video.src) {
              addVideo(video.src, video, seenUrls, videos);
          }

          const sources = video.querySelectorAll("source");
          sources.forEach(source => {
              if (source.src) {
                  addVideo(source.src, video, seenUrls, videos);
              }
          });
      });
  }

  function scanIframes(seenUrls, videos) {
      const iframes = document.querySelectorAll('iframe');

      iframes.forEach(iframe => {
          try {
              if (iframe.contentDocument) {
                  scanDocument(iframe.contentDocument, seenUrls, videos);

                  if (iframe.contentDocument.body) {
                      scanShadowRoots(iframe.contentDocument.body, seenUrls, videos);
                  }
              }
          } catch (e) {
              // Cross-origin iframe, can't access
          }
      });
  }

  function scanShadowRoots(root, seenUrls, videos) {
      if (!root) return;

      const walker = document.createTreeWalker(
          root,
          NodeFilter.SHOW_ELEMENT,
          null,
          false
      );

      const elementsWithShadow = [];
      let node;

      while (node = walker.nextNode()) {
          if (node.shadowRoot) {
              elementsWithShadow.push(node);
          }
      }

      elementsWithShadow.forEach(element => {
          const shadowVideos = element.shadowRoot.querySelectorAll('video');

          shadowVideos.forEach(video => {
              if (video.src) {
                  addVideo(video.src, video, seenUrls, videos);
              }

              const sources = video.querySelectorAll('source');
              sources.forEach(source => {
                  if (source.src) {
                      addVideo(source.src, video, seenUrls, videos);
                  }
              });
          });

          scanShadowRoots(element.shadowRoot, seenUrls, videos);
      });
  }

  function addVideo(url, videoElement, seenUrls, videos) {
      if (seenUrls.has(url)) return;
      seenUrls.add(url);

      const duration = videoElement.duration && isFinite(videoElement.duration) ? videoElement.duration : null;

      // Filter short preview videos on homepage/feed pages only
      const isHomepageOrFeed = isYouTubeHomepage();
      if (isHomepageOrFeed && duration !== null && duration < 15) {
          console.log('Skipping short preview video on homepage:', url, 'duration:', duration);
          return;
      }

      const type = getVideoType(url);

      const videoData = {
          src: url,
          type: type,
          width: videoElement.videoWidth || videoElement.clientWidth || null,
          height: videoElement.videoHeight || videoElement.clientHeight || null,
          duration: duration,
          pageUrl: location.href,
          thumbnail: captureThumbnail(videoElement),
          subtitleTracks: collectSubtitleTracks(videoElement, url, document),
          transcriptText: collectPageTranscriptText(document)
      };

      if (type === 'blob') {
          videoData.blobCaptured = false;
      }

      videos.push(videoData);
  }

  function getVideoType(url) {
      const urlLower = url.toLowerCase();

      if (urlLower.startsWith('blob:')) return 'blob';

      let pathname;
      try {
          const urlObj = new URL(url);
          pathname = urlObj.pathname.toLowerCase();
      } catch {
          pathname = url.split('?')[0].toLowerCase();
      }

      if (pathname.endsWith('.mp4')) return 'mp4';
      if (pathname.endsWith('.webm')) return 'webm';
      if (pathname.endsWith('.m3u8')) return 'hls';
      if (pathname.endsWith('.mpd')) return 'dash';
      if (pathname.endsWith('.ogg')) return 'ogg';
      if (pathname.endsWith('.mov')) return 'mov';

      return 'unknown';
  }
}

function setupDynamicObserver() {
  const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                  if (node.tagName === 'VIDEO') {
                      handleNewVideo(node);
                  }

                  const videos = node.querySelectorAll && node.querySelectorAll('video');
                  if (videos && videos.length > 0) {
                      videos.forEach(video => handleNewVideo(video));
                  }

                  if (node.tagName === 'IFRAME') {
                      setTimeout(() => {
                          try {
                              if (node.contentDocument) {
                                  const iframeVideos = node.contentDocument.querySelectorAll('video');
                                  iframeVideos.forEach(video => handleNewVideo(video));
                              }
                          } catch (e) {
                              // Cross-origin
                          }
                      }, 1000);
                  }

                  if (node.shadowRoot) {
                      const shadowVideos = node.shadowRoot.querySelectorAll('video');
                      shadowVideos.forEach(video => handleNewVideo(video));
                  }
              }
          });
      });
  });

  observer.observe(document.body, {
      childList: true,
      subtree: true
  });

  function handleNewVideo(videoElement) {
      const urls = [];

      if (videoElement.src) {
          urls.push(videoElement.src);
      }

      const sources = videoElement.querySelectorAll('source');
      sources.forEach(source => {
          if (source.src) {
              urls.push(source.src);
          }
      });

      urls.forEach(url => {
          if (!dynamicVideosCache.some(v => v.src === url)) {
              const duration = videoElement.duration && isFinite(videoElement.duration) ? videoElement.duration : null;

              // Filter short preview videos on homepage/feed pages only
              const isHomepageOrFeed = isYouTubeHomepage();
              if (isHomepageOrFeed && duration !== null && duration < 15) {
                  console.log('Skipping short preview video on homepage:', url, 'duration:', duration);
                  return;
              }

              const videoData = {
                  src: url,
                  type: getVideoType(url),
                  width: videoElement.videoWidth || videoElement.clientWidth || null,
                  height: videoElement.videoHeight || videoElement.clientHeight || null,
                  duration: duration,
                  dynamic: true,
                  pageUrl: location.href,
                  thumbnail: captureThumbnail(videoElement),
                  subtitleTracks: collectSubtitleTracks(videoElement, url, document)
              };

              dynamicVideosCache.push(videoData);

              if (videoData.type === 'blob') {
                  videoData.blobCaptured = false;
              }
          }
      });
  }

  function getVideoType(url) {
      const urlLower = url.toLowerCase();

      if (urlLower.startsWith('blob:')) return 'blob';

      let pathname;
      try {
          const urlObj = new URL(url);
          pathname = urlObj.pathname.toLowerCase();
      } catch {
          pathname = url.split('?')[0].toLowerCase();
      }

      if (pathname.endsWith('.mp4')) return 'mp4';
      if (pathname.endsWith('.webm')) return 'webm';
      if (pathname.endsWith('.m3u8')) return 'hls';
      if (pathname.endsWith('.mpd')) return 'dash';
      if (pathname.endsWith('.ogg')) return 'ogg';
      if (pathname.endsWith('.mov')) return 'mov';

      return 'unknown';
  }
}

if (document.body) {
  setupDynamicObserver();
} else {
  document.addEventListener('DOMContentLoaded', setupDynamicObserver);
}

function captureThumbnail(videoElement) {
  try {
    if (!videoElement || videoElement.readyState < 2) {
      return null;
    }

    const canvas = document.createElement('canvas');
    const width = videoElement.videoWidth || videoElement.clientWidth || 320;
    const height = videoElement.videoHeight || videoElement.clientHeight || 180;

    canvas.width = Math.min(width, 320);
    canvas.height = Math.min(height, 180);

    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL('image/jpeg', 0.7);
  } catch (error) {
    console.warn('Failed to capture thumbnail:', error);
    return null;
  }
}

async function captureBlobData(blobUrl, videoElement) {
  try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const response = await fetch(blobUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
          throw new Error(`Blob fetch failed (${response.status})`);
      }

      const blob = await response.blob();

      if (!blob || blob.size === 0) {
          throw new Error('Blob is empty');
      }

      return new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onloadend = () => res(reader.result);
          reader.onerror = rej;
          reader.readAsDataURL(blob);
      });
  } catch (error) {
      console.warn('Fetch failed, trying alternative methods:', error);

      if (videoElement) {
          try {
              const duration = getRecommendedCaptureDuration(videoElement, true);
              return await captureFromVideoElement(videoElement, {
                  recordSeconds: duration,
                  recordFromStart: true
              });
          } catch (altError) {
              console.error('Alternative capture also failed:', altError);
          }
      }

      return null;
  }
}

async function captureFromVideoElement(videoElement, options = {}) {
  if (!videoElement.captureStream) {
      throw new Error('captureStream not supported');
  }

  const recordSeconds = Math.max(1, Math.floor(options.recordSeconds || 30));
  const recordFromStart = options.recordFromStart !== false;

  return new Promise((resolve, reject) => {
      try {
          let originalCurrentTime = videoElement.currentTime;

          const startRecording = async () => {
              if (recordFromStart && videoElement.currentTime > 0) {
                  await seekVideo(videoElement, 0);
              }

              const stream = videoElement.captureStream();
              const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
                  ? 'video/webm;codecs=vp9,opus'
                  : (MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4');
              const mediaRecorder = new MediaRecorder(stream, { mimeType });

              const chunks = [];

              mediaRecorder.ondataavailable = (event) => {
                  if (event.data.size > 0) {
                      chunks.push(event.data);
                  }
              };

              mediaRecorder.onstop = async () => {
                  try {
                      if (recordFromStart && Number.isFinite(originalCurrentTime) && originalCurrentTime > 0) {
                          await seekVideo(videoElement, originalCurrentTime).catch(() => {});
                      }
                  } catch {
                      // Ignore restore failures
                  }

                  const blob = new Blob(chunks, { type: mimeType });
                  const reader = new FileReader();
                  reader.onloadend = () => resolve(reader.result);
                  reader.onerror = reject;
                  reader.readAsDataURL(blob);
              };

              mediaRecorder.onerror = (error) => {
                  reject(error);
              };

              mediaRecorder.start(1000);

              if (videoElement.paused) {
                  videoElement.play().catch(() => {});
              }

              const recordDuration = recordSeconds * 1000;

              setTimeout(() => {
                  if (mediaRecorder.state !== 'inactive') {
                      mediaRecorder.stop();
                  }
              }, recordDuration);
          };

          startRecording().catch(reject);

      } catch (error) {
          reject(error);
      }
  });
}

function getRecommendedCaptureDuration(videoElement, recordFromStart = true) {
  const duration = Number(videoElement?.duration);
  const currentTime = Number(videoElement?.currentTime) || 0;

  if (Number.isFinite(duration) && duration > 0) {
      const targetSeconds = recordFromStart ? duration : Math.max(1, duration - currentTime);
      return Math.min(Math.ceil(targetSeconds), 2 * 60 * 60);
  }

  return 60;
}

function seekVideo(videoElement, targetTime, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
      const done = () => {
          cleanup();
          resolve();
      };

      const onError = () => {
          cleanup();
          reject(new Error('Video seek failed'));
      };

      const cleanup = () => {
          clearTimeout(timeout);
          videoElement.removeEventListener('seeked', done);
          videoElement.removeEventListener('error', onError);
      };

      const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Video seek timeout'));
      }, timeoutMs);

      videoElement.addEventListener('seeked', done, { once: true });
      videoElement.addEventListener('error', onError, { once: true });

      try {
          videoElement.currentTime = Math.max(0, targetTime);
      } catch (error) {
          cleanup();
          reject(error);
      }
  });
}

async function downloadBlob(blobUrl) {
  if (blobDataCache.has(blobUrl)) {
      return blobDataCache.get(blobUrl);
  }

  try {
      const videoElement = findVideoElementByBlobUrl(blobUrl);
      const dataUrl = await captureBlobData(blobUrl, videoElement);
      if (!dataUrl) {
          throw new Error('Blob URL has expired or is no longer accessible');
      }

      blobDataCache.set(blobUrl, dataUrl);
      return dataUrl;
  } catch (error) {
      throw new Error(`Failed to fetch blob: ${error.message}`);
  }
}

function getUrlType(url) {
  const normalized = (url || '').toLowerCase();
  if (normalized.endsWith('.m3u8')) return 'hls';
  if (normalized.endsWith('.mpd')) return 'dash';
  if (normalized.endsWith('.mp4')) return 'mp4';
  if (normalized.endsWith('.webm')) return 'webm';
  if (normalized.endsWith('.mov')) return 'mov';
  return 'unknown';
}

function resolveBlobDownloadSources(blobUrl) {
  const candidates = [];
  const seen = new Set();
  const videoElement = findVideoElementByBlobUrl(blobUrl);

  const addCandidate = (url, reason) => {
      if (!url || typeof url !== 'string') return;
      const trimmed = url.trim();
      if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) return;
      if (seen.has(trimmed)) return;

      seen.add(trimmed);
      candidates.push({
          url: trimmed,
          type: getUrlType(trimmed),
          reason: reason
      });
  };

  if (videoElement) {
      addCandidate(videoElement.currentSrc, 'video.currentSrc');
      addCandidate(videoElement.src, 'video.src');

      const sources = videoElement.querySelectorAll('source');
      sources.forEach(source => addCandidate(source.src, 'video.source'));
  }

  const perfEntries = performance.getEntriesByType('resource');
  for (let i = perfEntries.length - 1; i >= 0; i--) {
      const entry = perfEntries[i];
      const lower = name.toLowerCase();

      if (lower.includes('.m3u8') || lower.includes('.mpd') || lower.includes('.mp4') || lower.includes('.webm')) {
          addCandidate(name, 'performance.resource');
      }
  }

  return {
      candidates: candidates,
      duration: Number.isFinite(videoElement?.duration) ? videoElement.duration : null,
      canCapture: Boolean(videoElement && videoElement.captureStream)
  };
}

function findVideoElementByBlobUrl(blobUrl) {
  const videoElements = document.querySelectorAll('video');

  for (const video of videoElements) {
      if (video.src === blobUrl) {
          return video;
      }

      const sourceMatch = Array.from(video.querySelectorAll('source')).some(source => source.src === blobUrl);
      if (sourceMatch) {
          return video;
      }
  }

  return null;
}

function buildHlsDownloadFilename(suggestedFilename) {
    const raw = typeof suggestedFilename === 'string' && suggestedFilename.trim()
        ? suggestedFilename.trim()
        : `hls-video-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    if (/\.(mp4|ts|m3u8|mpd|webm|mov)$/i.test(raw)) {
        return raw;
    }

    return `${raw}.ts`;
}

function collectSubtitleTracks(videoElement, baseUrl, doc = document) {
    const tracks = [];
    const seen = new Set();

    const pushTrack = (track) => {
        if (!track) return;

        const src = typeof track.src === 'string' ? track.src.trim() : '';
        const label = typeof track.label === 'string' ? track.label.trim() : '';
        const language = typeof track.language === 'string'
            ? track.language.trim()
            : (typeof track.srclang === 'string' ? track.srclang.trim() : '');
        const kind = typeof track.kind === 'string' ? track.kind.trim().toLowerCase() : '';
        const resolvedSrc = src ? resolveMaybeRelativeUrl(src, baseUrl) : '';
        const transcriptText = typeof track.transcriptText === 'string' ? track.transcriptText.trim() : '';
        const key = `${resolvedSrc}|${label}|${language}|${kind}|${transcriptText.slice(0, 80)}`;

        if ((!resolvedSrc && !transcriptText) || seen.has(key)) return;
        seen.add(key);

        tracks.push({
            src: resolvedSrc,
            label: label,
            language: language,
            kind: kind,
            isDefault: Boolean(track.default),
            mode: typeof track.mode === 'string' ? track.mode : '',
            transcriptText: transcriptText
        });
    };

    const trackElements = videoElement.querySelectorAll('track');
    trackElements.forEach(trackEl => {
        pushTrack({
            src: trackEl.src,
            label: trackEl.label,
            language: trackEl.srclang,
            kind: trackEl.kind,
            default: trackEl.default
        });
    });

    if (videoElement.textTracks && typeof videoElement.textTracks.length === 'number') {
        Array.from(videoElement.textTracks).forEach(textTrack => {
            const transcriptText = extractTextTrackTranscript(textTrack);
            pushTrack({
                src: textTrack.src || '',
                label: textTrack.label || textTrack.language || '',
                language: textTrack.language || '',
                kind: textTrack.kind || '',
                default: textTrack.mode === 'showing' || textTrack.mode === 'hidden',
                transcriptText: transcriptText
            });
        });
    }

    const youtubeTracks = collectYouTubeCaptionTracks(doc, baseUrl);
    youtubeTracks.forEach(pushTrack);

    const pageTranscriptText = collectPageTranscriptText(doc);
    if (pageTranscriptText) {
        pushTrack({
            src: '',
            label: 'Transcript',
            language: 'en',
            kind: 'transcript',
            default: true,
            transcriptText: pageTranscriptText
        });
    }

    return tracks;
}

function collectPageTranscriptText(doc) {
    const visibleCaptionText = collectVisibleCaptionText(doc);
    if (visibleCaptionText) {
        return visibleCaptionText;
    }

    const visibleTranscriptText = collectTranscriptTextFromDom(doc);
    if (visibleTranscriptText) {
        return visibleTranscriptText;
    }

    const initialData = getYouTubeInitialData(doc);
    const rendered = extractYouTubeTranscriptFromData(initialData);
    if (rendered) {
        return rendered;
    }

    return '';
}

function collectVisibleCaptionText(doc) {
    const selectors = [
        '#ytp-caption-window-container .ytp-caption-segment',
        '.ytp-caption-window-container .ytp-caption-segment',
        '.ytp-caption-segment'
    ];

    const texts = [];
    const seen = new Set();

    selectors.forEach(selector => {
        doc.querySelectorAll(selector).forEach(node => {
            const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
            if (text && !seen.has(text)) {
                seen.add(text);
                texts.push(text);
            }
        });
    });

    return texts.join('\n').trim();
}

function normalizeCaptionSnapshot(text) {
    return String(text || '')
      .replace(/\uFEFF/g, '')
      .split(/\r?\n/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
      .trim();
}

function getActiveCaptionVideoElement() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) {
        return null;
    }

    const visible = videos.find(video => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && window.getComputedStyle(video).visibility !== 'hidden';
    });
    if (visible) {
        return visible;
    }

    const playing = videos.find(video => !video.paused && !video.ended);
    if (playing) {
        return playing;
    }

    return videos[0];
}

function formatCaptionTimestamp(seconds) {
    const totalSeconds = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const wholeSeconds = Math.floor(totalSeconds % 60);
    const milliseconds = Math.floor((totalSeconds - Math.floor(totalSeconds)) * 1000);

    const pad = (value, size = 2) => String(value).padStart(size, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}.${pad(milliseconds, 3)}`;
}

function buildCaptionTranscriptLine(entry) {
    if (!entry || !entry.text) {
        return '';
    }

    const timestamp = formatCaptionTimestamp(entry.timeSeconds);
    return `[${timestamp}] ${entry.text}`.trim();
}

function getCaptionRecorderTranscript() {
    return captionRecorderState.buffer
      .map(buildCaptionTranscriptLine)
      .filter(Boolean)
      .join('\n')
      .trim();
}

function recordCaptionSnapshot() {
    if (!captionRecorderState.active) {
        return false;
    }

    const snapshot = normalizeCaptionSnapshot(collectVisibleCaptionText(document));
    if (!snapshot || snapshot === captionRecorderState.lastSnapshot) {
        return false;
    }

    captionRecorderState.lastSnapshot = snapshot;
    const video = getActiveCaptionVideoElement();
    captionRecorderState.buffer.push({
        text: snapshot,
        timeSeconds: video && Number.isFinite(video.currentTime) ? video.currentTime : 0
    });
    return true;
}

function disconnectCaptionRecorderObservers() {
    if (captionRecorderState.observer) {
        captionRecorderState.observer.disconnect();
        captionRecorderState.observer = null;
    }

    if (captionRecorderState.intervalId) {
        clearInterval(captionRecorderState.intervalId);
        captionRecorderState.intervalId = null;
    }
}

function ensureCaptionRecorderObservers() {
    if (captionRecorderState.observer || captionRecorderState.intervalId) {
        return;
    }

    const observerTarget = document.querySelector('#ytp-caption-window-container') || document.body;
    if (observerTarget) {
        captionRecorderState.observer = new MutationObserver(() => {
            recordCaptionSnapshot();
        });

        captionRecorderState.observer.observe(observerTarget, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true
        });
    }

    captionRecorderState.intervalId = setInterval(() => {
        recordCaptionSnapshot();
    }, 250);
}

function startCaptionRecording() {
    if (captionRecorderState.active) {
        return getCaptionRecordingStatus();
    }

    captionRecorderState.active = true;
    captionRecorderState.buffer = [];
    captionRecorderState.lastSnapshot = '';
    ensureCaptionRecorderObservers();
    recordCaptionSnapshot();

    return getCaptionRecordingStatus();
}

function stopCaptionRecording(reset = true) {
    const transcriptText = getCaptionRecorderTranscript();
    const lineCount = captionRecorderState.buffer.length;

    captionRecorderState.active = false;
    disconnectCaptionRecorderObservers();

    if (reset) {
        captionRecorderState.buffer = [];
        captionRecorderState.lastSnapshot = '';
    }

    return {
        active: false,
        transcriptText,
        lineCount
    };
}

function getCaptionRecordingStatus() {
    return {
        active: captionRecorderState.active,
        transcriptText: getCaptionRecorderTranscript(),
        lineCount: captionRecorderState.buffer.length
    };
}

function collectTranscriptTextFromDom(doc) {
    const selectors = [
        'ytd-transcript-segment-renderer',
        'tp-yt-paper-item[role="button"]',
        'tp-yt-paper-listbox ytd-transcript-segment-renderer'
    ];

    const lines = [];
    selectors.forEach(selector => {
        doc.querySelectorAll(selector).forEach(node => {
            const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
            if (text) {
                lines.push(text);
            }
        });
    });

    return lines.join('\n').trim();
}

function getYouTubeInitialData(doc) {
    if (!doc) return null;

    const direct = window.ytInitialData || window.__ytInitialData || doc.defaultView?.ytInitialData || doc.defaultView?.__ytInitialData;
    if (direct) return direct;

    const scripts = Array.from(doc.scripts || []);
    for (const script of scripts) {
        const text = script.textContent || '';
        if (!text.includes('ytInitialData')) continue;

        const match = text.match(/ytInitialData\s*=\s*(\{.*?\});/s)
          || text.match(/var\s+ytInitialData\s*=\s*(\{.*?\});/s);
        if (!match) continue;

        try {
            return JSON.parse(match[1]);
        } catch {
            continue;
        }
    }

    return null;
}

function extractYouTubeTranscriptFromData(data) {
    const segments = [];

    walkYouTubeObject(data, (value) => {
        if (typeof value?.transcriptSegmentRenderer?.snippet?.simpleText === 'string') {
            segments.push(value.transcriptSegmentRenderer.snippet.simpleText.trim());
        }

        if (typeof value?.transcriptSegmentRenderer?.snippet?.runs?.length === 'number') {
            const text = value.transcriptSegmentRenderer.snippet.runs.map(run => run?.text || '').join('').trim();
            if (text) segments.push(text);
        }
    });

    return segments.join('\n').trim();
}

function walkYouTubeObject(value, visitor) {
    if (!value || typeof value !== 'object') return;

    visitor(value);

    if (Array.isArray(value)) {
        value.forEach(item => walkYouTubeObject(item, visitor));
        return;
    }

    Object.values(value).forEach(child => walkYouTubeObject(child, visitor));
}

function extractTextTrackTranscript(textTrack) {
    const cueSource = (textTrack && typeof textTrack === 'object') ? (textTrack.cues || textTrack.activeCues) : null;
    if (!cueSource || typeof cueSource.length !== 'number') {
        return '';
    }

    const lines = [];
    for (const cue of Array.from(cueSource)) {
        const text = typeof cue?.text === 'string'
            ? cue.text.trim()
            : (typeof cue?.getCueAsHTML === 'function' ? (cue.getCueAsHTML()?.textContent || '').trim() : '');
        if (text) {
            lines.push(text.replace(/\s+/g, ' '));
        }
    }

    return lines.join('\n').trim();
}

function collectYouTubeCaptionTracks(doc, baseUrl) {
    const tracks = [];
    const playerResponse = getYouTubePlayerResponse(doc);
    const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    captionTracks.forEach(track => {
        const src = typeof track?.baseUrl === 'string' ? track.baseUrl.trim() : '';
        if (!src) return;

        const language = typeof track?.languageCode === 'string' ? track.languageCode.trim() : '';
        const label = getYouTubeCaptionLabel(track) || language || 'Subtitles';
        const kind = typeof track?.kind === 'string' ? track.kind.trim().toLowerCase() : '';
        const resolvedSrc = resolveMaybeRelativeUrl(ensureYouTubeCaptionFormat(src), baseUrl);

        tracks.push({
            src: resolvedSrc,
            label,
            language,
            kind,
            isDefault: Boolean(track?.isTranslatable) || /default/i.test(label)
        });
    });

    return tracks;
}

function getYouTubePlayerResponse(doc) {
    if (!doc) return null;

    const direct = window.ytInitialPlayerResponse
      || window.__ytInitialPlayerResponse
      || doc.defaultView?.ytInitialPlayerResponse
      || doc.defaultView?.__ytInitialPlayerResponse;
    if (direct) return direct;

    const scripts = Array.from(doc.scripts || []);
    for (const script of scripts) {
        const text = script.textContent || '';
        if (!text.includes('ytInitialPlayerResponse')) continue;

        const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s)
          || text.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
        if (!match) continue;

        try {
            return JSON.parse(match[1]);
        } catch {
            continue;
        }
    }

    return null;
}

function getYouTubeCaptionLabel(track) {
    const name = track?.name;
    if (typeof name?.simpleText === 'string' && name.simpleText.trim()) {
        return name.simpleText.trim();
    }

    if (Array.isArray(name?.runs)) {
        const text = name.runs.map(run => run?.text || '').join('').trim();
        if (text) return text;
    }

    return '';
}

function ensureYouTubeCaptionFormat(url) {
    try {
        const parsed = new URL(url);
        if (!parsed.searchParams.has('fmt')) {
          parsed.searchParams.set('fmt', 'vtt');
        }
        return parsed.toString();
    } catch {
        const separator = url.includes('?') ? '&' : '?';
        return url.includes('fmt=') ? url : `${url}${separator}fmt=vtt`;
    }
}

function resolveMaybeRelativeUrl(url, baseUrl) {
    try {
        return new URL(url, baseUrl).href;
    } catch {
        return url;
    }
}

async function fetchMediaTextThroughBackground(url) {
    const response = await chrome.runtime.sendMessage({ action: 'fetchMediaText', url });

    if (!response?.success) {
        throw new Error(response?.error || 'Manifest request failed (network error)');
    }

    return new Response(response.text || '', {
        status: typeof response.status === 'number' ? response.status : 200,
        headers: {
            'content-type': response.contentType || 'application/vnd.apple.mpegurl'
        }
    });
}

async function fetchMediaBlobThroughBackground(url) {
    const response = await chrome.runtime.sendMessage({ action: 'fetchMediaBlob', url });

    if (!response?.success) {
        throw new Error(response?.error || 'Segment request failed (network error)');
    }

    return new Response(response.buffer || new ArrayBuffer(0), {
        status: typeof response.status === 'number' ? response.status : 200,
        headers: {
            'content-type': response.contentType || 'application/octet-stream'
        }
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getVideos") {
      try {
          const videos = detectVideos();

          dynamicVideosCache.forEach(dynamicVideo => {
              if (!videos.some(v => v.src === dynamicVideo.src)) {
                  videos.push(dynamicVideo);
              }
          });

          sendResponse({videos: videos});
      } catch (error) {
          console.error('Detection failed:', error);
          sendResponse({videos: []});
      }
      return true;
  }

  if (request.action === "downloadBlob") {
      downloadBlob(request.url).then(dataUrl => {
          sendResponse({success: true, dataUrl: dataUrl});
      }).catch(error => {
          sendResponse({success: false, error: error.message});
      });
      return true;
  }

  if (request.action === "resolveBlobSource") {
      try {
          const result = resolveBlobDownloadSources(request.url);
          sendResponse({success: true, ...result});
      } catch (error) {
          sendResponse({success: false, error: error.message, candidates: []});
      }
      return true;
  }

  if (request.action === "fetchMediaText") {
      fetchMediaText(request.url).then(result => {
          sendResponse({success: true, ...result});
      }).catch(error => {
          sendResponse({success: false, error: error.message});
      });
      return true;
  }

  if (request.action === "fetchMediaBlob") {
      fetchMediaBlob(request.url).then(result => {
          sendResponse({success: true, ...result});
      }).catch(error => {
          sendResponse({success: false, error: error.message});
      });
      return true;
  }

  if (request.action === "startCaptionRecording") {
      try {
          const status = startCaptionRecording();
          sendResponse({success: true, ...status});
      } catch (error) {
          sendResponse({success: false, error: error.message});
      }
      return true;
  }

  if (request.action === "stopCaptionRecording") {
      try {
          const result = stopCaptionRecording(true);
          sendResponse({success: true, ...result});
      } catch (error) {
          sendResponse({success: false, error: error.message});
      }
      return true;
  }

  if (request.action === "getCaptionRecordingStatus") {
      try {
          sendResponse({success: true, ...getCaptionRecordingStatus()});
      } catch (error) {
          sendResponse({success: false, error: error.message});
      }
      return true;
  }

  if (request.action === "startHlsDownloadTask") {
      const taskId = request.taskId || `hls-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const variantUrl = request.variantUrl;
      const filename = buildHlsDownloadFilename(request.filename);
      const hlsConcurrency = Number(request.hlsConcurrency);

      if (!variantUrl || typeof variantUrl !== 'string') {
          sendResponse({accepted: false, error: 'variantUrl is required'});
          return true;
      }

      if (typeof downloadHLSWithQuality !== 'function' || typeof triggerBlobDownload !== 'function') {
          sendResponse({accepted: false, error: 'HLS downloader is not loaded in content context'});
          return true;
      }

      sendResponse({accepted: true, taskId: taskId});

      (async () => {
          try {
              console.log('[HLS] Starting download from:', variantUrl);
              chrome.runtime.sendMessage({
                  action: 'hlsTaskStart',
                  taskId: taskId,
                  filename: filename,
                  variantUrl: variantUrl
              });

              let lastProgressSentAt = 0;
              let lastTotalSegments = 0;
              const blob = await downloadHLSWithQuality(variantUrl, (current, total, status) => {
                  if (Number.isFinite(Number(total)) && Number(total) >= 0) {
                      lastTotalSegments = Number(total);
                  }

                  const now = Date.now();
                  const shouldSend = now - lastProgressSentAt >= 200 || current === total;

                  if (!shouldSend) {
                      return;
                  }

                  lastProgressSentAt = now;
                  chrome.runtime.sendMessage({
                      action: 'hlsTaskProgress',
                      taskId: taskId,
                      current: current,
                      total: total,
                      status: status || 'Downloading segments'
                  });
              }, {
                  hlsConcurrency: Number.isFinite(hlsConcurrency) ? hlsConcurrency : undefined,
                  fetchTextFn: fetchMediaTextThroughBackground,
                  fetchSegmentFn: fetchMediaBlobThroughBackground
              });
              
              console.log('[HLS] Download complete, blob size:', blob.size, 'bytes');
              triggerBlobDownload(blob, filename);

              chrome.runtime.sendMessage({
                  action: 'hlsTaskComplete',
                  taskId: taskId,
                  totalSegments: lastTotalSegments,
                  statusText: 'Saved to Downloads'
              });
          } catch (error) {
              console.error('[HLS] Content-side HLS download task failed:', error);
              const errorMessage = String(error?.message || error || 'Unknown HLS error');
              chrome.runtime.sendMessage({
                  action: 'hlsTaskFailed',
                  taskId: taskId,
                  error: errorMessage
              });
          }
      })();

      return true;
  }

  if (request.action === "forceCapture") {
      forceCaptureBlob(request.url, request.recordFromStart, request.duration).then(dataUrl => {
          if (dataUrl) {
              blobDataCache.set(request.url, dataUrl);
              sendResponse({success: true, dataUrl: dataUrl});
          } else {
              sendResponse({success: false, error: 'Capture failed'});
          }
      }).catch(error => {
          sendResponse({success: false, error: error.message});
      });
      return true;
  }
});

async function forceCaptureBlob(blobUrl, recordFromStart = false, duration = 30) {
  const videoElements = document.querySelectorAll('video');

  for (const video of videoElements) {
      if (video.src === blobUrl ||
          Array.from(video.querySelectorAll('source')).some(s => s.src === blobUrl)) {

          try {
              return await captureFromVideoElement(video, {
                  recordSeconds: duration,
                  recordFromStart: recordFromStart
              });
          } catch (error) {
              console.warn('Video recording failed, trying blob fetch:', error);
          }
      }
  }

  try {
      return await captureBlobData(blobUrl, null);
  } catch (error) {
      console.error('All capture methods failed:', error);
      return null;
  }
}

async function fetchMediaText(url) {
    const result = await fetchMediaResource(url, 'text');
    
    // If we got text content, validate it's not HTML (error page)
    if (result.ok && result.text) {
        const trimmedText = result.text.trim();
        if (trimmedText.startsWith('<') || trimmedText.includes('<!DOCTYPE')) {
            // Got HTML instead of expected content, treat as failure
            console.warn('fetchMediaText got HTML instead of text content:', trimmedText.substring(0, 100));
            return {
                ok: false,
                status: result.status,
                text: result.text,
                contentType: 'text/html'
            };
        }
    }
    
    return {
            ok: result.ok,
            status: result.status,
            text: result.text || '',
            contentType: result.contentType || ''
    };
}

async function fetchMediaBlob(url) {
    const result = await fetchMediaResource(url, 'arrayBuffer');
    return {
            ok: result.ok,
            status: result.status,
            buffer: result.buffer || new ArrayBuffer(0),
            contentType: result.contentType || 'application/octet-stream'
    };
}

async function fetchMediaResource(url, responseType) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
      const response = await fetch(url, {
          signal: controller.signal,
          credentials: 'include',
          cache: 'no-store'
      });

      const contentType = response.headers.get('content-type') || '';

      if (responseType === 'text') {
          const text = response.ok ? await response.text() : '';
          return {
              ok: response.ok,
              status: response.status,
              text: text,
              contentType: contentType
          };
      }

      const buffer = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0);
      return {
          ok: response.ok,
          status: response.status,
          buffer: buffer,
          contentType: contentType
      };
  } finally {
      clearTimeout(timeout);
  }
}