const blobDataCache = new Map();
let dynamicVideosCache = [];
let currentUrl = location.href;

// Clear caches when navigating to a new page
function clearCaches() {
  blobDataCache.clear();
  dynamicVideosCache = [];
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
          thumbnail: captureThumbnail(videoElement)
      };

      if (type === 'blob') {
          videoData.blobCaptured = false;

          captureBlobData(url, videoElement).then(dataUrl => {
              if (dataUrl) {
                  blobDataCache.set(url, dataUrl);
                  videoData.blobCaptured = true;
              }
          }).catch(error => {
              console.warn('Failed to capture blob:', error);
          });
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
                  thumbnail: captureThumbnail(videoElement)
              };

              dynamicVideosCache.push(videoData);

              if (videoData.type === 'blob') {
                  videoData.blobCaptured = false;
                  captureBlobData(url, videoElement).then(dataUrl => {
                      if (dataUrl) {
                          blobDataCache.set(url, dataUrl);
                          videoData.blobCaptured = true;
                      }
                  }).catch(error => {
                      console.warn('Failed to capture blob:', error);
                  });
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
      const response = await fetch(blobUrl);
      const blob = await response.blob();

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
              return await captureFromVideoElement(videoElement);
          } catch (altError) {
              console.error('Alternative capture also failed:', altError);
          }
      }

      return null;
  }
}

async function captureFromVideoElement(videoElement, recordSeconds = 30) {
  if (!videoElement.captureStream) {
      throw new Error('captureStream not supported');
  }

  return new Promise((resolve, reject) => {
      try {
          const stream = videoElement.captureStream();
          const mimeType = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4';
          const mediaRecorder = new MediaRecorder(stream, { mimeType });

          const chunks = [];

          mediaRecorder.ondataavailable = (event) => {
              if (event.data.size > 0) {
                  chunks.push(event.data);
              }
          };

          mediaRecorder.onstop = () => {
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

      } catch (error) {
          reject(error);
      }
  });
}

async function downloadBlob(blobUrl) {
  if (blobDataCache.has(blobUrl)) {
      return blobDataCache.get(blobUrl);
  }

  try {
      const dataUrl = await captureBlobData(blobUrl);
      if (!dataUrl) {
          throw new Error('Blob URL has expired or is no longer accessible');
      }
      return dataUrl;
  } catch (error) {
      throw new Error(`Failed to fetch blob: ${error.message}`);
  }
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
              if (recordFromStart && video.currentTime > 0) {
                  video.currentTime = 0;
                  await new Promise(resolve => {
                      video.onseeked = () => resolve();
                      setTimeout(() => resolve(), 1000);
                  });
              }

              return await captureFromVideoElement(video, duration);
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