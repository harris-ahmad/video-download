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
    // Extract pathname (before query parameters) for more accurate detection
    let pathname;
    try {
        const urlObj = new URL(url);
        pathname = urlObj.pathname.toLowerCase();
    } catch {
        // If URL parsing fails, fall back to simple string check
        pathname = url.split('?')[0].toLowerCase();
    }

    // Check if pathname ends with a video extension (more accurate than includes)
    const videoExtensions = [".mp4", ".webm", ".m3u8", ".mpd", ".mov", ".ogg"];
    const hasVideoExtension = videoExtensions.some(ext => pathname.endsWith(ext));

    if (hasVideoExtension) return true;

    // Also check Content-Type header as fallback
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
    // Extract pathname for accurate type detection
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