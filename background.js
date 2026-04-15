const networkVideos = new Map();

const MAX_URLS_PER_TAB = 50;

chrome.webRequest.onResponseStarted.addListener(details => {
    const {tabId, url, responseHeaders} = details;

    if (tabId === -1) return;

    if (isVideoUrl(url, responseHeaders)) {
        addNetworkVideo(tabId, url);
    }
}, 
{urls: ["<all_urls>"]},
["responseHeaders"]
);

function isVideoUrl(url, headers) {
    const urlLower = url.toLowerCase();

    const videoExtensions = [".mp4", ".webm", ".m3u8", ".mpd", ".mov", ".ogg"];
    const hasVideoExtension = videoExtensions.some(ext => urlLower.includes(ext));

    if (hasVideoExtension) return true;

    if (headers) {
        const contentType = headers.find(h => h.name.toLowerCase() === "content-type");
        if (contentType && contentType.value.toLowerCase().startsWith("video/")) return true;
    }

    return false;
}

function addNetworkVideo(tabId, url) {
    if (!networkVideos.has(tabId)) networkVideos.set(tabId, []);

    const urls = networkVideos.get(tabId);

    if (urls.includes(url)) return;

    urls.push(url);

    if (urls.length > MAX_URLS_PER_TAB) urls.shift();
}

function getVideoType(url) {
    const urlLower = url.toLowerCase();
  
    if (urlLower.includes('.mp4') || urlLower.includes('mp4')) return 'mp4';
    if (urlLower.includes('.webm') || urlLower.includes('webm')) return 'webm';
    if (urlLower.includes('.m3u8')) return 'hls';
    if (urlLower.includes('.mpd')) return 'dash';
    if (urlLower.includes('.ogg')) return 'ogg';
    if (urlLower.includes('.mov')) return 'mov';
  
    return 'unknown';
}

chrome.tabs.onRemoved.addListener(tabId => {
    networkVideos.delete(tabId);
})

chrome.webNavigation.onBeforeNavigate.addListener(details => {
    const {tabId, frameId} = details;

    if (frameId===0) networkVideos.delete(tabId);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getNetworkVideos") {
        const tabId = request.tabId;
        const urls = networkVideos.get(tabId) || [];

        const videos = urls.map(url => ({
            src: url,
            type: getVideoType(url),
            width: null,
            height: null,
            duration: null
        }));

        sendResponse({videos: videos});
        return true;
    }
});