function detectVideos() {
  const videos=[];
  const seenUrls = new Set();

  const videoElements = document.querySelectorAll("video");

  videoElements.forEach((video, index) => {
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

      const type=getVideoType(url);

      const videoData={
          src: url,
          type: type,
          width: videoElement.videoWidth || videoElement.clientWidth || null,
          height: videoElement.videoHeight || videoElement.clientHeight || null,
          duration: videoElement.duration && isFinite(videoElement.duration) ? videoElement.duration : null
      };

      videos.push(videoData);

  }

  function getVideoType(url) {
      const urlLower = url.toLowerCase();

      if (urlLower.startsWith('blob:')) return 'blob';
      if (urlLower.includes('.mp4') || urlLower.includes('mp4')) return 'mp4';
      if (urlLower.includes('.webm') || urlLower.includes('webm')) return 'webm';
      if (urlLower.includes('.m3u8')) return 'hls';
      if (urlLower.includes('.mpd')) return 'dash';
      if (urlLower.includes('.ogg')) return 'ogg';
      if (urlLower.includes('.mov')) return 'mov';

      return 'unknown';
  }

  return videos;
}

async function downloadBlob(blobUrl) {
  try {
      const response = await fetch(blobUrl);
      const blob = await response.blob();

      return new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onloadend = () => res(reader.result);
          reader.onerror = rej;
          reader.readAsDataURL(blob);
      })
  } catch (error) {
      throw new Error(`Failed to fetch blob: ${error.message}`);        
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action==="getVideos") {
      const videos = detectVideos();
      sendResponse({videos: videos});
      return true;
  }

  if (request.action==="downloadBlob"){
      downloadBlob(request.url).then(dataUrl => {
          sendResponse({success: true, dataUrl: dataUrl})
      }).catch(error => {
          sendResponse({success: false, error: error.message});
      })

      return true;
  }

});