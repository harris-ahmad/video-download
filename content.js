const blobDataCache = new Map();

function detectVideos() {
  const videos = [];
  const seenUrls = new Set();
  const videoElements = document.querySelectorAll("video");

  videoElements.forEach(video => {
      if (video.src) {
          addVideo(video.src, video);
      }

      const sources = video.querySelectorAll("source");
      sources.forEach(source => {
          if (source.src) {
              addVideo(source.src, video);
          }
      });
  });

  function addVideo(url, videoElement) {
      if (seenUrls.has(url)) return;
      seenUrls.add(url);

      const type = getVideoType(url);

      const videoData = {
          src: url,
          type: type,
          width: videoElement.videoWidth || videoElement.clientWidth || null,
          height: videoElement.videoHeight || videoElement.clientHeight || null,
          duration: videoElement.duration && isFinite(videoElement.duration) ? videoElement.duration : null
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

      // Blob URLs are special, check first
      if (urlLower.startsWith('blob:')) return 'blob';

      // Extract pathname for accurate detection
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

  return videos;
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