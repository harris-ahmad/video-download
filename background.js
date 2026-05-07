const networkVideos = new Map();
const networkRequests = new Map();
const DOWNLOAD_QUEUE_STORAGE_KEY = 'downloadQueueSnapshot';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

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
const chromeDownloadToQueueId = new Map();
const hlsTaskToQueueId = new Map();
let downloadIdCounter = 0;
let queueHydrationPromise = null;
let queuePersistTimer = null;

async function findLatestDownloadedTs() {
    const downloads = await chrome.downloads.search({
        state: 'complete',
        exists: true,
        orderBy: ['-startTime'],
        limit: 100
    });

    return downloads.find(item => typeof item.filename === 'string' && item.filename.toLowerCase().endsWith('.ts')) || null;
}

function getMp4PathForTs(tsPath) {
    if (/\.ts$/i.test(tsPath)) {
        return tsPath.replace(/\.ts$/i, '.mp4');
    }

    return `${tsPath}.mp4`;
}

function createDownloadSpeedTracker() {
    return {
        lastBytesReceived: 0,
        lastSampleTime: Date.now(),
        speedBps: 0
    };
}

function updateDownloadSpeed(download, bytesReceived) {
    const now = Date.now();
    const elapsedMs = now - download.speedTracker.lastSampleTime;

    if (elapsedMs > 0) {
        const byteDelta = Math.max(0, bytesReceived - download.speedTracker.lastBytesReceived);
        const speedBps = (byteDelta * 1000) / elapsedMs;

        if (Number.isFinite(speedBps) && speedBps >= 0) {
            download.speedTracker.speedBps = speedBps;
        }
    }

    download.speedTracker.lastBytesReceived = bytesReceived;
    download.speedTracker.lastSampleTime = now;
    download.speedBps = download.speedTracker.speedBps;
}

async function fetchMediaText(url) {
    const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store'
    });

    const text = await response.text();

    return {
        ok: response.ok,
        status: response.status,
        text,
        contentType: response.headers.get('content-type') || ''
    };
}

async function fetchMediaBlob(url) {
    const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store'
    });

    const buffer = await response.arrayBuffer();

    return {
        ok: response.ok,
        status: response.status,
        buffer,
        contentType: response.headers.get('content-type') || ''
    };
}

async function ensureOffscreenDocument(){
    if (!chrome.offscreen?.createDocument) {
        throw new Error('Offscreen API is not available');
    }

    const offscreenUrl=chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const existing=await chrome.runtime.getContexts({
        contextTypes:['OFFSCREEN_DOCUMENT'],
        documentUrls:[offscreenUrl]
    });
    if (existing.length>0) return;

    await chrome.offscreen.createDocument({
        url:OFFSCREEN_DOCUMENT_PATH,
        reasons:['BLOBS'],
        justification:'Run media segment downloads outside tab/popup lifetime'
    });
}

async function convertTsToMp4WithWasm(tsBuffer) {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
        action: 'offscreenConvertTsToMp4',
        tsBuffer: tsBuffer
    });

    if (!response?.success || !(response.mp4Buffer instanceof ArrayBuffer)) {
        throw new Error(response?.error || 'WASM conversion failed');
    }

    return response.mp4Buffer;
}

function buildDownloadSnapshot(download) {
    return {
        id: download.id,
        url: download.url,
        filename: download.filename,
        status: download.status,
        progress: download.progress,
        total: download.total,
        speedBps: download.speedBps,
        errorCode: download.errorCode || null,
        chromeDownloadId: download.chromeDownloadId || null,
        speedTracker: download.speedTracker ? {
            lastBytesReceived: download.speedTracker.lastBytesReceived,
            lastSampleTime: download.speedTracker.lastSampleTime,
            speedBps: download.speedTracker.speedBps
        } : null
    };
}

function restoreDownloadSnapshot(snapshot) {
    const download = {
        id: snapshot.id,
        url: snapshot.url,
        filename: snapshot.filename,
        status: snapshot.status || 'downloading',
        progress: snapshot.progress || 0,
        total: snapshot.total || 0,
        speedBps: snapshot.speedBps || 0,
        errorCode: snapshot.errorCode || null,
        chromeDownloadId: snapshot.chromeDownloadId || null,
        speedTracker: createDownloadSpeedTracker()
    };

    if (snapshot.speedTracker) {
        download.speedTracker.lastBytesReceived = snapshot.speedTracker.lastBytesReceived || download.progress;
        download.speedTracker.lastSampleTime = snapshot.speedTracker.lastSampleTime || Date.now();
        download.speedTracker.speedBps = snapshot.speedTracker.speedBps || download.speedBps;
    } else {
        download.speedTracker.lastBytesReceived = download.progress;
        download.speedTracker.lastSampleTime = Date.now();
        download.speedTracker.speedBps = download.speedBps;
    }

    return download;
}

function rebuildChromeDownloadMap() {
    chromeDownloadToQueueId.clear();
    hlsTaskToQueueId.clear();

    for (const download of downloadQueue.values()) {
        if (typeof download.chromeDownloadId === 'number') {
            chromeDownloadToQueueId.set(download.chromeDownloadId, download.id);
        }

        if (typeof download.hlsTaskId === 'string' && download.hlsTaskId) {
            hlsTaskToQueueId.set(download.hlsTaskId, download.id);
        }
    }
}

function findQueueIdByHlsTaskId(taskId) {
    if (!taskId) {
        return null;
    }

    const mappedId = hlsTaskToQueueId.get(taskId);
    if (mappedId) {
        return mappedId;
    }

    for (const [queueId, item] of downloadQueue.entries()) {
        if (item.hlsTaskId === taskId) {
            hlsTaskToQueueId.set(taskId, queueId);
            return queueId;
        }
    }

    return null;
}

function persistDownloadQueue() {
    return chrome.storage.session.set({
        [DOWNLOAD_QUEUE_STORAGE_KEY]: Array.from(downloadQueue.values()).map(buildDownloadSnapshot)
    });
}

function scheduleQueuePersist() {
    if (queuePersistTimer) {
        clearTimeout(queuePersistTimer);
    }

    queuePersistTimer = setTimeout(() => {
        queuePersistTimer = null;
        persistDownloadQueue().catch(error => {
            console.error('Failed to persist download queue:', error);
        });
    }, 100);
}

async function hydrateDownloadQueue() {
    const stored = await chrome.storage.session.get(DOWNLOAD_QUEUE_STORAGE_KEY);
    const snapshot = stored[DOWNLOAD_QUEUE_STORAGE_KEY];

    downloadQueue.clear();
    chromeDownloadToQueueId.clear();

    if (Array.isArray(snapshot)) {
        for (const item of snapshot) {
            const download = restoreDownloadSnapshot(item);
            downloadQueue.set(download.id, download);

            if (typeof download.chromeDownloadId === 'number') {
                chromeDownloadToQueueId.set(download.chromeDownloadId, download.id);
            }
        }

        rebuildChromeDownloadMap();
    }
}

function ensureQueueHydrated() {
    if (!queueHydrationPromise) {
        queueHydrationPromise = hydrateDownloadQueue().catch(error => {
            queueHydrationPromise = null;
            throw error;
        });
    }

    return queueHydrationPromise;
}

chrome.runtime.onStartup.addListener(() => {
    ensureQueueHydrated().catch(error => {
        console.error('Failed to hydrate download queue on startup:', error);
    });
});

chrome.runtime.onInstalled.addListener(() => {
    ensureQueueHydrated().catch(error => {
        console.error('Failed to hydrate download queue on install:', error);
    });
});

chrome.downloads.onChanged.addListener(async delta => {
    try {
        await ensureQueueHydrated();

        let queueId = chromeDownloadToQueueId.get(delta.id);

        if (!queueId) {
            for (const [id, download] of downloadQueue.entries()) {
                if (download.chromeDownloadId === delta.id) {
                    queueId = id;
                    chromeDownloadToQueueId.set(delta.id, id);
                    break;
                }
            }
        }

        if (!queueId) {
            return;
        }

        const download = downloadQueue.get(queueId);

        if (!download) {
            return;
        }

        if (delta.bytesReceived?.current != null) {
            updateDownloadSpeed(download, delta.bytesReceived.current);
            download.progress = delta.bytesReceived.current;
        }

        if (delta.totalBytes?.current != null) {
            download.total = delta.totalBytes.current;
        }

        if (delta.state?.current === 'complete') {
            download.status = 'completed';
            download.speedBps = 0;
            scheduleQueuePersist();

            setTimeout(() => {
                downloadQueue.delete(queueId);
                chromeDownloadToQueueId.delete(delta.id);
                persistDownloadQueue().catch(error => {
                    console.error('Failed to persist cleared download queue:', error);
                });
            }, 5000);
            return;
        }

        if (delta.state?.current === 'interrupted') {
            download.status = 'failed';
            download.speedBps = 0;
        }

        scheduleQueuePersist();
    } catch (error) {
        console.error('Failed to sync download progress:', error);
    }
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

    if (request.action === "getNetworkRequests") {
        const tabId = request.tabId;
        const requests = networkRequests.get(tabId) || [];
        sendResponse({requests: requests});
        return true;
    }

    if (request.action === "fetchMediaText") {
        (async () => {
            try {
                const result = await fetchMediaText(request.url);
                sendResponse({success: true, ...result});
            } catch (error) {
                sendResponse({success: false, error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "fetchMediaBlob") {
        (async () => {
            try {
                const result = await fetchMediaBlob(request.url);
                sendResponse({success: true, ...result});
            } catch (error) {
                sendResponse({success: false, error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "startDownload") {
        (async () => {
            try {
                await ensureQueueHydrated();

                const downloadId = ++downloadIdCounter;
                const download = {
                    id: downloadId,
                    url: request.url,
                    filename: request.filename,
                    status: 'downloading',
                    progress: 0,
                    total: 0,
                    speedBps: 0,
                    speedTracker: createDownloadSpeedTracker()
                };

                downloadQueue.set(downloadId, download);
                scheduleQueuePersist();

                chrome.downloads.download({
                    url: request.url,
                    filename: request.filename,
                    saveAs: request.saveAs || false
                }, (chromeDownloadId) => {
                    if (chrome.runtime.lastError || !chromeDownloadId) {
                        download.status = 'failed';
                        scheduleQueuePersist();
                        console.error('Failed to start download:', chrome.runtime.lastError?.message || 'Unknown error');
                        return;
                    }

                    download.chromeDownloadId = chromeDownloadId;
                    chromeDownloadToQueueId.set(chromeDownloadId, downloadId);
                    scheduleQueuePersist();
                });

                sendResponse({downloadId: downloadId});
            } catch (error) {
                sendResponse({success: false, error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "getQueueStatus") {
        (async () => {
            try {
                await ensureQueueHydrated();
                sendResponse({queue: Array.from(downloadQueue.values())});
            } catch (error) {
                sendResponse({queue: [], error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "cancelDownload") {
        (async () => {
            try {
                await ensureQueueHydrated();
                const download = downloadQueue.get(request.downloadId);

                if (download && download.chromeDownloadId) {
                    chrome.downloads.cancel(download.chromeDownloadId);
                    download.status = 'cancelled';
                    scheduleQueuePersist();
                }

                sendResponse({success: true});
            } catch (error) {
                sendResponse({success: false, error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "clearQueue") {
        (async () => {
            try {
                await ensureQueueHydrated();
                downloadQueue.clear();
                chromeDownloadToQueueId.clear();
                hlsTaskToQueueId.clear();
                await persistDownloadQueue();
                sendResponse({success: true});
            } catch (error) {
                sendResponse({success: false, error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "hlsTaskStart") {
        (async () => {
            try {
                await ensureQueueHydrated();

                if (!request.taskId || !request.filename) {
                    sendResponse({success: false, error: 'taskId and filename are required'});
                    return;
                }

                let queueId = findQueueIdByHlsTaskId(request.taskId);
                if (!queueId) {
                    queueId = ++downloadIdCounter;
                    const queueItem = {
                        id: queueId,
                        url: request.variantUrl || '',
                        filename: request.filename,
                        status: 'downloading',
                        statusText: 'Starting HLS task',
                        progress: 0,
                        total: 0,
                        speedBps: 0,
                        progressUnit: 'segments',
                        hlsTaskId: request.taskId,
                        speedTracker: createDownloadSpeedTracker()
                    };

                    downloadQueue.set(queueId, queueItem);
                    hlsTaskToQueueId.set(request.taskId, queueId);
                }

                scheduleQueuePersist();
                sendResponse({success: true, queueId: queueId});
            } catch (error) {
                sendResponse({success: false, error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "hlsTaskProgress") {
        (async () => {
            try {
                await ensureQueueHydrated();

                const queueId = findQueueIdByHlsTaskId(request.taskId);
                if (!queueId) {
                    sendResponse({success: false, error: 'Unknown HLS task'});
                    return;
                }

                const queueItem = downloadQueue.get(queueId);
                if (!queueItem) {
                    sendResponse({success: false, error: 'Missing queue item'});
                    return;
                }

                const current = Number(request.current || 0);
                const total = Number(request.total || 0);
                queueItem.status = 'downloading';
                queueItem.statusText = typeof request.status === 'string' ? request.status : '';
                queueItem.progressUnit = 'segments';

                if (Number.isFinite(current) && current >= 0) {
                    queueItem.progress = current;
                }
                if (Number.isFinite(total) && total >= 0) {
                    queueItem.total = total;
                }

                scheduleQueuePersist();
                sendResponse({success: true});
            } catch (error) {
                sendResponse({success: false, error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "hlsTaskComplete") {
        (async () => {
            try {
                await ensureQueueHydrated();

                const queueId = findQueueIdByHlsTaskId(request.taskId);
                if (!queueId) {
                    sendResponse({success: false, error: 'Unknown HLS task'});
                    return;
                }

                const queueItem = downloadQueue.get(queueId);
                if (!queueItem) {
                    sendResponse({success: false, error: 'Missing queue item'});
                    return;
                }

                queueItem.status = 'completed';
                queueItem.statusText = request.statusText || 'Saved to Downloads';
                queueItem.progressUnit = 'segments';
                if (Number.isFinite(Number(request.totalSegments))) {
                    const totalSegments = Number(request.totalSegments);
                    queueItem.total = totalSegments;
                    queueItem.progress = totalSegments;
                }

                scheduleQueuePersist();

                setTimeout(() => {
                    downloadQueue.delete(queueId);
                    hlsTaskToQueueId.delete(request.taskId);
                    persistDownloadQueue().catch(error => {
                        console.error('Failed to persist cleared HLS task:', error);
                    });
                }, 8000);

                sendResponse({success: true});
            } catch (error) {
                sendResponse({success: false, error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "hlsTaskFailed") {
        (async () => {
            try {
                await ensureQueueHydrated();

                const queueId = findQueueIdByHlsTaskId(request.taskId);
                if (!queueId) {
                    sendResponse({success: false, error: 'Unknown HLS task'});
                    return;
                }

                const queueItem = downloadQueue.get(queueId);
                if (!queueItem) {
                    sendResponse({success: false, error: 'Missing queue item'});
                    return;
                }

                queueItem.status = 'failed';
                queueItem.errorCode = typeof request.errorCode === 'string' ? request.errorCode : null;
                if (queueItem.errorCode === 'HLS_ENCRYPTED') {
                    queueItem.statusText = 'DRM/encrypted stream: this video is protected and cannot be downloaded by the extension.';
                } else {
                    queueItem.statusText = request.error || 'HLS task failed';
                }
                queueItem.progressUnit = 'segments';
                scheduleQueuePersist();
                sendResponse({success: true});
            } catch (error) {
                sendResponse({success: false, error: error.message});
            }
        })();

        return true;
    }

    if (request.action === "startBackgroundStreamDownload") {
        (async () => {
            try {
                await ensureQueueHydrated();
                await ensureOffscreenDocument();

                if (!request.taskId || !request.filename) {
                    sendResponse({success:false,error:'taskId and filename are required'});
                    return;
                }

                let queueId=findQueueIdByHlsTaskId(request.taskId);
                if (!queueId) {
                    queueId=++downloadIdCounter;
                    downloadQueue.set(queueId,{
                        id:queueId,
                        url:request.variantUrl || request.manifestUrl || '',
                        filename:request.filename,
                        status:'downloading',
                        statusText: request.streamType === 'dash' ? 'Preparing DASH task' : 'Starting HLS task',
                        progress:0,
                        total:0,
                        speedBps:0,
                        progressUnit:'segments',
                        hlsTaskId:request.taskId,
                        speedTracker:createDownloadSpeedTracker()
                    });
                    hlsTaskToQueueId.set(request.taskId,queueId);
                    scheduleQueuePersist();
                }

                const offscreenResult = await chrome.runtime.sendMessage({
                    action:'offscreenDownloadStream',
                    taskId:request.taskId,
                    streamType:request.streamType || 'hls',
                    manifestUrl:request.manifestUrl || '',
                    variantUrl:request.variantUrl || '',
                    filename:request.filename,
                    hlsConcurrency:request.hlsConcurrency,
                    saveAs:Boolean(request.saveAs)
                });

                if (!offscreenResult?.accepted) {
                    sendResponse({success:false,error:offscreenResult?.error || 'Offscreen task was rejected'});
                    return;
                }

                sendResponse({success:true,taskId:request.taskId,queueId:queueId});
            } catch (error) {
                sendResponse({success:false,error:error.message});
            }
        })();
        return true;
    }

    if (request.action === "convertLatestTsToMp4") {
        (async () => {
            try {
                const latestTs = await findLatestDownloadedTs();

                if (!latestTs) {
                    sendResponse({success: false, error: 'No completed .ts download found yet'});
                    return;
                }

                const sourceUrl = latestTs.finalUrl || latestTs.url;
                if (!sourceUrl) {
                    throw new Error('Could not determine source URL for latest .ts download');
                }

                const tsFetch = await fetchMediaBlob(sourceUrl);
                if (!tsFetch.ok || !(tsFetch.buffer instanceof ArrayBuffer) || tsFetch.buffer.byteLength === 0) {
                    throw new Error(`Failed to fetch TS bytes (${tsFetch.status})`);
                }

                const mp4Buffer = await convertTsToMp4WithWasm(tsFetch.buffer);
                const mp4Blob = new Blob([mp4Buffer], { type: 'video/mp4' });
                const mp4ObjectUrl = URL.createObjectURL(mp4Blob);
                const outputFilename = latestTs.filename.split('/').pop() || 'converted.mp4';
                const outputPath = getMp4PathForTs(outputFilename);

                try {
                    await chrome.downloads.download({
                        url: mp4ObjectUrl,
                        filename: outputPath,
                        saveAs: false
                    });
                } finally {
                    setTimeout(() => URL.revokeObjectURL(mp4ObjectUrl), 60_000);
                }

                sendResponse({
                    success: true,
                    inputPath: latestTs.filename,
                    outputPath: outputPath
                });
            } catch (error) {
                sendResponse({success: false, error: String(error?.message || error || 'Unknown conversion error')});
            }
        })();

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

            updateDownloadSpeed(download, item.bytesReceived || 0);
            download.progress = item.bytesReceived;
            download.total = item.totalBytes;

            if (item.state === 'complete') {
                download.status = 'completed';
                download.speedBps = 0;
                clearInterval(interval);
                setTimeout(() => downloadQueue.delete(downloadId), 5000);
            } else if (item.state === 'interrupted') {
                download.status = 'failed';
                download.speedBps = 0;
                clearInterval(interval);
            }
        });
    }, 500);
}