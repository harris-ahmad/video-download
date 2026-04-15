const networkVideos = new Map();
const networkRequests = new Map();

const MAX_URLS_PER_TAB = 50;
const MAX_REQUESTS_PER_TAB = 100;

chrome.webRequest.onResponseStarted.addListener(details => {
    const {tabId, url, responseHeaders} = details;

    if (tabId === -1) return;

    if (isVideoUrl(url, responseHeaders) || isAudioUrl(url, responseHeaders)) {
        addNetworkVideo(tabId, url);
        addNetworkRequest(tabId, url, responseHeaders);
    }
},
{urls: ["<all_urls>"]},
["responseHeaders"]
);

function isVideoUrl(url, headers) {
    let pathname;
    try {
        const urlObj = new URL(url);
        pathname = urlObj.pathname.toLowerCase();
    } catch {
        pathname = url.split('?')[0].toLowerCase();
    }

    const videoExtensions = [".mp4", ".webm", ".m3u8", ".mpd", ".mov", ".ogg"];
    const hasVideoExtension = videoExtensions.some(ext => pathname.endsWith(ext));

    if (hasVideoExtension) return true;

    if (headers) {
        const contentType = headers.find(h => h.name.toLowerCase() === "content-type");
        if (contentType && contentType.value.toLowerCase().startsWith("video/")) return true;
    }

    return false;
}

function isAudioUrl(url, headers) {
    let pathname;
    try {
        const urlObj = new URL(url);
        pathname = urlObj.pathname.toLowerCase();
    } catch {
        pathname = url.split('?')[0].toLowerCase();
    }

    const audioExtensions = [".mp3", ".aac", ".wav", ".flac", ".m4a", ".opus"];
    const hasAudioExtension = audioExtensions.some(ext => pathname.endsWith(ext));

    if (hasAudioExtension) return true;

    if (headers) {
        const contentType = headers.find(h => h.name.toLowerCase() === "content-type");
        if (contentType && contentType.value.toLowerCase().startsWith("audio/")) return true;
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

function addNetworkRequest(tabId, url, headers) {
    if (!networkRequests.has(tabId)) networkRequests.set(tabId, []);

    const requests = networkRequests.get(tabId);

    if (requests.some(r => r.url === url)) return;

    const contentType = headers.find(h => h.name.toLowerCase() === "content-type");
    const contentLength = headers.find(h => h.name.toLowerCase() === "content-length");

    const mediaType = getMediaType(url, contentType ? contentType.value : '');
    const size = contentLength ? parseInt(contentLength.value) : null;

    const request = {
        url: url,
        type: mediaType,
        size: size,
        timestamp: Date.now()
    };

    requests.push(request);
    console.log(`Network request captured [Tab ${tabId}]:`, mediaType, url);

    if (requests.length > MAX_REQUESTS_PER_TAB) requests.shift();
}

function getMediaType(url, contentType) {
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';

    let pathname;
    try {
        const urlObj = new URL(url);
        pathname = urlObj.pathname.toLowerCase();
    } catch {
        pathname = url.split('?')[0].toLowerCase();
    }

    const videoExt = [".mp4", ".webm", ".m3u8", ".mpd", ".mov", ".ogg"];
    if (videoExt.some(ext => pathname.endsWith(ext))) return 'video';

    const audioExt = [".mp3", ".aac", ".wav", ".flac", ".m4a", ".opus"];
    if (audioExt.some(ext => pathname.endsWith(ext))) return 'audio';

    return 'unknown';
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
    networkRequests.delete(tabId);
})

chrome.webNavigation.onBeforeNavigate.addListener(details => {
    const {tabId, frameId} = details;

    if (frameId===0) {
        networkVideos.delete(tabId);
        networkRequests.delete(tabId);
    }
});

const downloadQueue = new Map();
let downloadIdCounter = 0;

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

    if (request.action === "getNetworkRequests") {
        const tabId = request.tabId;
        const requests = networkRequests.get(tabId) || [];
        console.log(`Sending ${requests.length} network requests for tab ${tabId}`);
        sendResponse({requests: requests});
        return true;
    }

    if (request.action === "clearNetworkRequests") {
        const tabId = request.tabId;
        networkRequests.set(tabId, []);
        sendResponse({success: true});
        return true;
    }

    if (request.action === "startDownload") {
        const downloadId = ++downloadIdCounter;
        const download = {
            id: downloadId,
            url: request.url,
            filename: request.filename,
            status: 'downloading',
            progress: 0,
            total: 0
        };

        downloadQueue.set(downloadId, download);

        chrome.downloads.download({
            url: request.url,
            filename: request.filename,
            saveAs: request.saveAs || false
        }, (chromeDownloadId) => {
            if (chromeDownloadId) {
                download.chromeDownloadId = chromeDownloadId;
                monitorDownload(downloadId, chromeDownloadId);
            }
        });

        sendResponse({downloadId: downloadId});
        return true;
    }

    if (request.action === "getQueueStatus") {
        const status = Array.from(downloadQueue.values());
        sendResponse({queue: status});
        return true;
    }

    if (request.action === "cancelDownload") {
        const download = downloadQueue.get(request.downloadId);
        if (download && download.chromeDownloadId) {
            chrome.downloads.cancel(download.chromeDownloadId);
            download.status = 'cancelled';
        }
        sendResponse({success: true});
        return true;
    }

    if (request.action === "clearQueue") {
        downloadQueue.clear();
        sendResponse({success: true});
        return true;
    }
});

function monitorDownload(downloadId, chromeDownloadId) {
    const interval = setInterval(() => {
        chrome.downloads.search({id: chromeDownloadId}, (results) => {
            if (results.length === 0) {
                clearInterval(interval);
                return;
            }

            const item = results[0];
            const download = downloadQueue.get(downloadId);

            if (!download) {
                clearInterval(interval);
                return;
            }

            download.progress = item.bytesReceived;
            download.total = item.totalBytes;

            if (item.state === 'complete') {
                download.status = 'completed';
                clearInterval(interval);
                setTimeout(() => downloadQueue.delete(downloadId), 5000);
            } else if (item.state === 'interrupted') {
                download.status = 'failed';
                clearInterval(interval);
            }
        });
    }, 500);
}