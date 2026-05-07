const DEFAULT_HLS_SEGMENT_CONCURRENCY = 16;
const MAX_HLS_SEGMENT_CONCURRENCY = 32;
const HLS_SEGMENT_RETRIES = 2;
const HLS_SEGMENT_TIMEOUT_MS = 15000;


async function downloadHLS(manifestUrl, onProgress, options = {}) {
  try {
    const manifestText = await fetchHLSPlaylistText(manifestUrl, options, 'Manifest');

    const parseResult = parseM3U8(manifestText, manifestUrl);
    const hlsOptions = resolveHLSDownloadOptions(options);

    if (parseResult.hasEncryption && !parseResult.isMasterPlaylist) {
      const encryptionError = new Error('This HLS stream is encrypted and cannot be downloaded directly.');
      encryptionError.code = 'HLS_ENCRYPTED';
      encryptionError.encryptionMethods = parseResult.encryptionMethods;
      throw encryptionError;
    }

    let segmentUrls;
    let initSegmentUrl = null;
    if (parseResult.isMasterPlaylist) {
      console.log(`Master playlist detected with ${parseResult.variants.length} variants`);

      const selectedVariant = parseResult.variants[parseResult.variants.length - 1];
      console.log('Fetching variant playlist:', selectedVariant.url);

      const variantText = await fetchHLSPlaylistText(selectedVariant.url, options, 'Variant playlist');

      const variantResult = parseM3U8(variantText, selectedVariant.url);

      if (variantResult.hasEncryption) {
        const encryptionError = new Error('This HLS quality variant is encrypted and cannot be downloaded directly.');
        encryptionError.code = 'HLS_ENCRYPTED';
        encryptionError.encryptionMethods = variantResult.encryptionMethods;
        throw encryptionError;
      }

      if (variantResult.isMasterPlaylist) {
        throw new Error('Nested master playlists are not supported');
      }

      segmentUrls = variantResult.segments;
      initSegmentUrl = variantResult.initSegmentUrl || null;
    } else {
      segmentUrls = parseResult.segments;
      initSegmentUrl = parseResult.initSegmentUrl || null;
    }

    if (segmentUrls.length === 0) {
      throw new Error('No video segments found in manifest');
    }

    const segments = await downloadSegmentsConcurrently(
      segmentUrls,
      hlsOptions.hlsConcurrency,
      HLS_SEGMENT_RETRIES,
      onProgress,
      hlsOptions
    );

    if (initSegmentUrl) {
      const initBlob = await fetchInitSegmentBlob(initSegmentUrl, HLS_SEGMENT_RETRIES, hlsOptions);
      segments.unshift(initBlob);
    }

    if (segments.length === 0) {
      throw new Error('All segments failed to download');
    }

    if (onProgress) {
      onProgress(segmentUrls.length, segmentUrls.length, 'Finalizing TS');
    }

    return new Blob(segments, { type: 'video/mp2t' });

  } catch (error) {
    const wrappedError = new Error(`HLS download failed: ${error.message}`);
    if (error && typeof error === 'object') {
      if (error.code) wrappedError.code = error.code;
      if (error.encryptionMethods) wrappedError.encryptionMethods = error.encryptionMethods;
      if (typeof error.failedSegments === 'number') wrappedError.failedSegments = error.failedSegments;
      if (typeof error.totalSegments === 'number') wrappedError.totalSegments = error.totalSegments;
    }
    throw wrappedError;
  }
}

function parseM3U8(manifestText, baseUrl) {
  if (!manifestText || typeof manifestText !== 'string') {
    throw new Error('Invalid manifest: not a string');
  }
  
  const trimmedText = manifestText.trim();
  if (!trimmedText.startsWith('#EXTM3U')) {
    if (trimmedText.startsWith('<') || trimmedText.includes('<!DOCTYPE')) {
      throw new Error('Invalid manifest: received HTML instead of M3U8 playlist');
    }
    throw new Error('Invalid manifest: does not start with #EXTM3U tag');
  }

  const lines = trimmedText.split('\n').map(line => line.trim());
  const encryptionMethods = [];
  const encryptionMethodSet = new Set();

  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY')) {
      const methodMatch = line.match(/METHOD=([^,]+)/);
      const method = methodMatch ? methodMatch[1].trim() : 'UNKNOWN';

      if (!encryptionMethodSet.has(method)) {
        encryptionMethodSet.add(method);
        encryptionMethods.push(method);
      }
    }
  }

  const hasEncryption = encryptionMethods.length > 0;

  const urlObj = new URL(baseUrl);
  const basePath = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
  const isMasterPlaylist = manifestText.includes('#EXT-X-STREAM-INF');

  if (isMasterPlaylist) {
    const variants = [];
    const fallbackVariants = [];
    const subtitleTracks = [];
    const subtitleSeen = new Set();

    const pushSubtitleTrack = (track) => {
      if (!track?.url) return;

      const key = `${track.url}|${track.label || ''}|${track.language || ''}`;
      if (subtitleSeen.has(key)) return;
      subtitleSeen.add(key);
      subtitleTracks.push(track);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-MEDIA')) {
        const typeMatch = line.match(/TYPE=([^,]+)/);
        const type = typeMatch ? typeMatch[1].replace(/"/g, '').trim().toUpperCase() : '';

        if (type === 'SUBTITLES') {
          const uriMatch = line.match(/URI="([^"]+)"/);
          if (uriMatch && uriMatch[1]) {
            const nameMatch = line.match(/NAME="([^"]+)"/);
            const langMatch = line.match(/LANGUAGE="([^"]+)"/);
            const defaultMatch = line.match(/DEFAULT=(YES|NO)/i);
            const autoselectMatch = line.match(/AUTOSELECT=(YES|NO)/i);
            const forcedMatch = line.match(/FORCED=(YES|NO)/i);

            pushSubtitleTrack({
              url: resolveUrl(uriMatch[1], basePath),
              label: nameMatch ? nameMatch[1] : 'Subtitles',
              language: langMatch ? langMatch[1] : '',
              isDefault: defaultMatch ? defaultMatch[1].toUpperCase() === 'YES' : false,
              autoSelect: autoselectMatch ? autoselectMatch[1].toUpperCase() === 'YES' : false,
              forced: forcedMatch ? forcedMatch[1].toUpperCase() === 'YES' : false,
              type: 'subtitle'
            });
          }
        }
      }

      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0;

        const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
        const resolution = resolutionMatch ? resolutionMatch[1] : 'unknown';

        const codecsMatch = line.match(/CODECS="([^"]+)"/);
        const codecs = codecsMatch ? codecsMatch[1] : '';
        const isLikelyVideo = isLikelyVideoVariant(resolution, codecs);

        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] && !lines[j].startsWith('#')) {
            const variantUrl = resolveUrl(lines[j], basePath);
            const variant = {
              url: variantUrl,
              bandwidth: bandwidth,
              resolution: resolution,
              codecs: codecs,
              isLikelyVideo: isLikelyVideo
            };

            fallbackVariants.push(variant);
            if (isLikelyVideo) {
              variants.push(variant);
            }
            break;
          }
        }
      }
    }

    const selectedVariants = variants.length > 0 ? variants : fallbackVariants;
    selectedVariants.sort((a, b) => a.bandwidth - b.bandwidth);

    return {
      isMasterPlaylist: true,
      variants: selectedVariants,
      subtitleTracks: subtitleTracks,
      hasEncryption: hasEncryption,
      encryptionMethods: encryptionMethods
    };
  } else {
    const segmentUrls = [];
    let initSegmentUrl = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-MAP')) {
        const uriMatch = line.match(/URI="([^"]+)"/);
        if (uriMatch && uriMatch[1]) {
          initSegmentUrl = resolveUrl(uriMatch[1], basePath);
        }
        continue;
      }

      if (!line || line.startsWith('#')) {
        continue;
      }
      const segmentUrl = resolveUrl(line, basePath);
      segmentUrls.push(segmentUrl);
    }

    return {
      isMasterPlaylist: false,
      segments: segmentUrls,
      initSegmentUrl: initSegmentUrl,
      subtitleTracks: [],
      hasEncryption: hasEncryption,
      encryptionMethods: encryptionMethods
    };
  }
}

async function downloadDASH(manifestUrl, onProgress) {
  try {
    const manifestResponse = await fetch(manifestUrl);
    if (!manifestResponse.ok) {
      throw new Error(`MPD request failed (${manifestResponse.status})`);
    }
    const manifestText = await manifestResponse.text();

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(manifestText, 'text/xml');

    const parsed = parseMPD(xmlDoc, manifestUrl);

    if (!parsed.video && !parsed.audio) {
      throw new Error('No video or audio tracks found in MPD');
    }

    const allSegments = [];
    let totalSegments = 0;
    let downloadedSegments = 0;

    if (parsed.video) {
      totalSegments += parsed.video.segments.length;
    }
    if (parsed.audio) {
      totalSegments += parsed.audio.segments.length;
    }

    if (parsed.video) {
      if (parsed.video.init) {
        const initResponse = await fetch(parsed.video.init);
        const initBlob = await initResponse.blob();
        allSegments.push(initBlob);
      }

      for (let i = 0; i < parsed.video.segments.length; i++) {
        if (onProgress) {
          downloadedSegments++;
          onProgress(downloadedSegments, totalSegments, 'Downloading video');
        }

        try {
          const response = await fetch(parsed.video.segments[i]);
          const blob = await response.blob();
          allSegments.push(blob);
        } catch (error) {
          console.warn(`Video segment ${i + 1} failed:`, error);
        }
      }
    }

    if (parsed.audio) {
      if (parsed.audio.init) {
        const initResponse = await fetch(parsed.audio.init);
        const initBlob = await initResponse.blob();
        allSegments.push(initBlob);
      }

      for (let i = 0; i < parsed.audio.segments.length; i++) {
        if (onProgress) {
          downloadedSegments++;
          onProgress(downloadedSegments, totalSegments, 'Downloading audio');
        }

        try {
          const response = await fetch(parsed.audio.segments[i]);
          const blob = await response.blob();
          allSegments.push(blob);
        } catch (error) {
          console.warn(`Audio segment ${i + 1} failed:`, error);
        }
      }
    }

    if (onProgress) {
      onProgress(totalSegments, totalSegments, 'Muxing MP4');
    }

    const combinedBlob = new Blob(allSegments, { type: 'video/mp4' });
    return combinedBlob;

  } catch (error) {
    throw new Error(`DASH download failed: ${error.message}`);
  }
}

function parseMPD(xmlDoc, baseUrl) {
  const urlObj = new URL(baseUrl);
  const basePath = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

  const result = { video: null, audio: null };

  const adaptationSets = xmlDoc.getElementsByTagName('AdaptationSet');

  for (let i = 0; i < adaptationSets.length; i++) {
    const adaptationSet = adaptationSets[i];
    const contentType = adaptationSet.getAttribute('contentType') ||
                       adaptationSet.getAttribute('mimeType') || '';

    const representations = adaptationSet.getElementsByTagName('Representation');

    if (representations.length === 0) continue;

    let bestRepresentation = representations[0];
    let bestBandwidth = parseInt(bestRepresentation.getAttribute('bandwidth') || '0');

    for (let j = 1; j < representations.length; j++) {
      const bandwidth = parseInt(representations[j].getAttribute('bandwidth') || '0');
      if (bandwidth > bestBandwidth) {
        bestBandwidth = bandwidth;
        bestRepresentation = representations[j];
      }
    }

    const trackData = extractSegments(bestRepresentation, basePath, adaptationSet, xmlDoc);

    if (contentType.includes('video') || (!contentType && trackData.hasVideo)) {
      result.video = trackData;
    } else if (contentType.includes('audio') || (!contentType && trackData.hasAudio)) {
      result.audio = trackData;
    }
  }

  return result;
}

function extractSegments(representation, basePath, adaptationSet, xmlDoc) {
  const segments = [];
  let initSegment = null;
  let hasVideo = false;
  let hasAudio = false;

  const mimeType = representation.getAttribute('mimeType') ||
                  adaptationSet.getAttribute('mimeType') || '';

  if (mimeType.includes('video')) hasVideo = true;
  if (mimeType.includes('audio')) hasAudio = true;

  const segmentTemplate = representation.getElementsByTagName('SegmentTemplate')[0] ||
                         adaptationSet.getElementsByTagName('SegmentTemplate')[0];

  if (segmentTemplate) {
    const mediaTemplate = segmentTemplate.getAttribute('media');
    const initTemplate = segmentTemplate.getAttribute('initialization');
    const startNumber = parseInt(segmentTemplate.getAttribute('startNumber') || '1');
    const duration = parseInt(segmentTemplate.getAttribute('duration') || '0');
    const timescale = parseInt(segmentTemplate.getAttribute('timescale') || '1');

    const repId = representation.getAttribute('id');
    const bandwidth = representation.getAttribute('bandwidth');

    if (initTemplate) {
      initSegment = resolveTemplate(initTemplate, repId, bandwidth, 0, 0);
      initSegment = resolveUrl(initSegment, basePath);
    }

    const segmentTimeline = segmentTemplate.getElementsByTagName('SegmentTimeline')[0];

    if (segmentTimeline) {
      const S = segmentTimeline.getElementsByTagName('S');
      let currentTime = 0;
      let currentNumber = startNumber;

      for (let i = 0; i < S.length; i++) {
        const t = parseInt(S[i].getAttribute('t') || currentTime.toString());
        const d = parseInt(S[i].getAttribute('d') || '0');
        const r = parseInt(S[i].getAttribute('r') || '0');

        for (let j = 0; j <= r; j++) {
          const segmentUrl = resolveTemplate(mediaTemplate, repId, bandwidth, currentNumber, t + (j * d));
          segments.push(resolveUrl(segmentUrl, basePath));
          currentNumber++;
        }

        currentTime = t + ((r + 1) * d);
      }
    } else if (duration > 0) {
      const mediaPresentationDuration = xmlDoc.documentElement.getAttribute('mediaPresentationDuration');
      let totalDuration = 0;

      if (mediaPresentationDuration) {
        totalDuration = parseDuration(mediaPresentationDuration);
      } else {
        totalDuration = 3600;
      }

      const segmentCount = Math.ceil((totalDuration * timescale) / duration);

      for (let i = 0; i < segmentCount; i++) {
        const number = startNumber + i;
        const time = i * duration;
        const segmentUrl = resolveTemplate(mediaTemplate, repId, bandwidth, number, time);
        segments.push(resolveUrl(segmentUrl, basePath));
      }
    }
  }

  const segmentList = representation.getElementsByTagName('SegmentList')[0] ||
                     adaptationSet.getElementsByTagName('SegmentList')[0];

  if (segmentList) {
    const initialization = segmentList.getElementsByTagName('Initialization')[0];
    if (initialization) {
      const sourceURL = initialization.getAttribute('sourceURL');
      if (sourceURL) {
        initSegment = resolveUrl(sourceURL, basePath);
      }
    }

    const segmentURLs = segmentList.getElementsByTagName('SegmentURL');
    for (let i = 0; i < segmentURLs.length; i++) {
      const media = segmentURLs[i].getAttribute('media');
      if (media) {
        segments.push(resolveUrl(media, basePath));
      }
    }
  }

  return {
    init: initSegment,
    segments: segments,
    hasVideo: hasVideo,
    hasAudio: hasAudio
  };
}

function resolveTemplate(template, repId, bandwidth, number, time) {
  return template
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Bandwidth\$/g, bandwidth)
    .replace(/\$Number\$/g, number.toString())
    .replace(/\$Time\$/g, time.toString())
    .replace(/\$Number%0(\d+)d\$/g, (_, width) => {
      return number.toString().padStart(parseInt(width), '0');
    });
}

function parseDuration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseFloat(match[3] || '0');

  return hours * 3600 + minutes * 60 + seconds;
}

async function getHLSVariants(manifestUrl, options = {}) {
  const manifestText = await fetchHLSPlaylistText(manifestUrl, options, 'Manifest');
  const parseResult = parseM3U8(manifestText, manifestUrl);

  if (parseResult.hasEncryption && !parseResult.isMasterPlaylist) {
    const encryptionError = new Error('This HLS stream is encrypted and cannot be downloaded directly.');
    encryptionError.code = 'HLS_ENCRYPTED';
    encryptionError.encryptionMethods = parseResult.encryptionMethods;
    throw encryptionError;
  }

  if (parseResult.isMasterPlaylist) {
    const withMetadata = await Promise.all(parseResult.variants.map(async (variant) => {
      const probe = await probeVariantPlaylistMetadata(variant.url, options);
      return {
        ...variant,
        segmentType: probe.segmentType,
        hasInitSegment: probe.hasInitSegment,
        estimatedSegmentCount: probe.segmentCount,
        subtitleTracks: parseResult.subtitleTracks || []
      };
    }));

    return withMetadata.map((v, i) => ({
      ...v,
      label: v.resolution || `Variant ${i + 1}`,
      isBest: i === parseResult.variants.length - 1,
      isLow: i === 0
    }));
  }

  return [{
    url: manifestUrl,
    label: 'Original',
    bandwidth: 0,
    resolution: 'unknown',
    isBest: true,
    isLow: false,
    subtitleTracks: parseResult.subtitleTracks || []
  }];
}

async function probeVariantPlaylistMetadata(variantUrl, options = {}) {
  try {
    const text = await fetchHLSPlaylistText(variantUrl, options, 'Variant probe');
    const parsed = parseM3U8(text, variantUrl);
    const firstSegment = Array.isArray(parsed.segments) && parsed.segments.length > 0
      ? parsed.segments[0]
      : '';

    return {
      segmentType: detectHlsSegmentType(firstSegment, parsed.initSegmentUrl),
      hasInitSegment: Boolean(parsed.initSegmentUrl),
      segmentCount: Array.isArray(parsed.segments) ? parsed.segments.length : 0
    };
  } catch {
    return {
      segmentType: 'unknown',
      hasInitSegment: false,
      segmentCount: 0
    };
  }
}

function detectHlsSegmentType(segmentUrl, initSegmentUrl) {
  const first = String(segmentUrl || '').toLowerCase();
  const init = String(initSegmentUrl || '').toLowerCase();

  if (first.includes('.ts') || first.includes('format=ts')) {
    return 'ts';
  }

  if (
    init.includes('.mp4') ||
    init.includes('.m4s') ||
    first.includes('.m4s') ||
    first.includes('.mp4') ||
    first.includes('format=mp4') ||
    first.includes('cmf')
  ) {
    return 'fmp4';
  }

  return 'unknown';
}

async function downloadHLSWithQuality(variantUrl, onProgress, options = {}) {
  const hlsOptions = resolveHLSDownloadOptions(options);
  const variantText = await fetchHLSPlaylistText(variantUrl, hlsOptions, 'Variant playlist');
  const variantResult = parseM3U8(variantText, variantUrl);

  if (variantResult.hasEncryption) {
    const encryptionError = new Error('This HLS quality variant is encrypted and cannot be downloaded directly.');
    encryptionError.code = 'HLS_ENCRYPTED';
    encryptionError.encryptionMethods = variantResult.encryptionMethods;
    throw encryptionError;
  }

  const segmentUrls = variantResult.segments;
  const initSegmentUrl = variantResult.initSegmentUrl || null;

  if (!segmentUrls || segmentUrls.length === 0) {
    throw new Error('No segments found');
  }

  let segments;
  try {
    segments = await downloadSegmentsConcurrently(
      segmentUrls,
      hlsOptions.hlsConcurrency,
      HLS_SEGMENT_RETRIES,
      onProgress,
      hlsOptions
    );
  } catch (error) {
    throw error;
  }

  if (segments.length === 0) {
    throw new Error('All segments failed to download');
  }

  if (initSegmentUrl) {
    const initBlob = await fetchInitSegmentBlob(initSegmentUrl, HLS_SEGMENT_RETRIES, hlsOptions);
    segments.unshift(initBlob);
  }

  if (onProgress) {
    onProgress(segmentUrls.length, segmentUrls.length, 'Finalizing TS');
  }

  return new Blob(segments, { type: 'video/mp2t' });
}

async function downloadSegmentsConcurrently(segmentUrls, concurrency, retries, onProgress, options = {}) {
  const total = segmentUrls.length;
  const segments = new Array(total);
  let completed = 0;
  let nextIndex = 0;
  const failures = new Map();

  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex++;

      if (currentIndex >= total) {
        return;
      }

      const segmentUrl = segmentUrls[currentIndex];

      try {
        const segmentBlob = await fetchSegmentWithRetry(segmentUrl, retries, options);
        segments[currentIndex] = segmentBlob;
        failures.delete(currentIndex);
      } catch (error) {
        failures.set(currentIndex, error);
        console.warn(`Segment ${currentIndex + 1}/${total} failed:`, error);
      } finally {
        completed++;
        if (onProgress) {
          onProgress(completed, total, 'Downloading segments');
        }
      }
    }
  });

  await Promise.all(workers);

  if (failures.size > 0) {
    await recoverFailedSegments(
      segmentUrls,
      segments,
      failures,
      retries,
      concurrency,
      options,
      onProgress
    );
  }

  const failed = failures.size;
  const authFailed = Array.from(failures.values()).filter(error => error?.code === 'HLS_AUTH_FORBIDDEN').length;

  if (failed > 0 && authFailed === failed) {
    const authError = new Error(`All HLS segments were unauthorized (${failed}/${total})`);
    authError.code = 'HLS_AUTH_FORBIDDEN';
    authError.failedSegments = failed;
    authError.totalSegments = total;
    throw authError;
  }

  if (failed > 0) {
    const segmentError = new Error(`Failed to download ${failed} of ${total} HLS segment(s)`);
    segmentError.code = 'HLS_SEGMENT_DOWNLOAD_FAILED';
    segmentError.failedSegments = failed;
    segmentError.totalSegments = total;
    throw segmentError;
  }

  return segments.filter(Boolean);
}

async function recoverFailedSegments(segmentUrls, segments, failures, retries, originalConcurrency, options, onProgress) {
  const firstPassIndexes = Array.from(failures.keys());
  const recoveryConcurrency = Math.max(1, Math.min(4, Math.floor(originalConcurrency / 2)));

  await retrySegmentIndexes(
    firstPassIndexes,
    segmentUrls,
    segments,
    failures,
    recoveryConcurrency,
    retries + 1,
    options,
    onProgress,
    'Recovering failed segments'
  );

  if (failures.size > 0) {
    const finalPassIndexes = Array.from(failures.keys());

    await retrySegmentIndexes(
      finalPassIndexes,
      segmentUrls,
      segments,
      failures,
      1,
      retries + 2,
      options,
      onProgress,
      'Final segment recovery'
    );
  }
}

async function retrySegmentIndexes(indexes, segmentUrls, segments, failures, concurrency, retries, options, onProgress, statusLabel) {
  if (indexes.length === 0) {
    return;
  }

  let pointer = 0;
  let completed = 0;

  const workers = Array.from({ length: Math.min(concurrency, indexes.length) }, async () => {
    while (true) {
      const pointerIndex = pointer;
      pointer++;

      if (pointerIndex >= indexes.length) {
        return;
      }

      const segmentIndex = indexes[pointerIndex];
      const segmentUrl = segmentUrls[segmentIndex];

      try {
        const blob = await fetchSegmentWithRetry(segmentUrl, retries, options);
        segments[segmentIndex] = blob;
        failures.delete(segmentIndex);
      } catch (error) {
        failures.set(segmentIndex, error);
      } finally {
        completed++;
        if (onProgress) {
          onProgress(completed, indexes.length, statusLabel);
        }
      }
    }
  });

  await Promise.all(workers);
}

function resolveHLSDownloadOptions(options) {
  const requestedConcurrency = Number(options?.hlsConcurrency);
  const normalizedConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.floor(requestedConcurrency)
    : DEFAULT_HLS_SEGMENT_CONCURRENCY;

  return {
    hlsConcurrency: Math.max(1, Math.min(MAX_HLS_SEGMENT_CONCURRENCY, normalizedConcurrency)),
    fetchTextFn: typeof options?.fetchTextFn === 'function' ? options.fetchTextFn : null,
    fetchSegmentFn: typeof options?.fetchSegmentFn === 'function' ? options.fetchSegmentFn : null
  };
}

async function fetchHLSPlaylistText(url, options = {}, label = 'Playlist') {
  const fetchTextFn = typeof options?.fetchTextFn === 'function' ? options.fetchTextFn : null;

  const response = fetchTextFn
    ? await fetchTextFn(url)
    : await fetch(url, { credentials: 'include', cache: 'no-store' });

  if (!response) {
    const err = new Error(`${label} request failed (network error)`);
    throw err;
  }

  const status = response?.status || 'unknown';
  const text = typeof response.text === 'function' ? await response.text() : '';

  if (isHtmlContent(text)) {
    const extractedUrl = extractPlaylistUrlFromHtml(text, url);
    if (extractedUrl && extractedUrl !== url) {
      console.warn(`${label} returned HTML; retrying extracted playlist URL:`, extractedUrl);
      return await fetchHLSPlaylistText(extractedUrl, options, `${label} (extracted)`);
    }
  }

  if (!response.ok) {
    const err = new Error(`${label} request failed (${status})`);

    if (status === 401 || status === 403) {
      err.code = 'HLS_AUTH_FORBIDDEN';
      err.httpStatus = status;
    }

    throw err;
  }

  return text;
}

function isHtmlContent(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return normalized.startsWith('<') || normalized.includes('<!doctype html') || normalized.includes('<html');
}

function extractPlaylistUrlFromHtml(html, baseUrl) {
  const text = String(html || '');
  const candidates = [];

  try {
    const base = new URL(baseUrl);
    const directUrl = base.searchParams.get('url');
    if (directUrl) {
      candidates.push(decodeURIComponent(directUrl));
    }
  } catch {
  }

  const regexes = [
    /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi,
    /\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi,
    /url=([^"'&\s<>]+)/gi,
    /sourceURL=([^"'&\s<>]+)/gi
  ];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const value = match[1] || match[0];
      if (!value) continue;

      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
      }

      if (/\.m3u8(?:[?#].*)?$/i.test(decoded) || decoded.includes('.m3u8')) {
        candidates.push(decoded);
      }
    }
  }

  for (const candidate of candidates) {
    try {
      return resolveUrl(candidate, baseUrl);
    } catch {
    }
  }

  return null;
}

async function fetchSegmentWithRetry(segmentUrl, retries, options = {}) {
  const fetchSegmentFn = typeof options?.fetchSegmentFn === 'function' ? options.fetchSegmentFn : null;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchSegmentResponse(segmentUrl, fetchSegmentFn);

      if (!response.ok) {
        const httpError = new Error(`HTTP ${response.status}`);
        if (response.status === 401 || response.status === 403) {
          httpError.code = 'HLS_AUTH_FORBIDDEN';
          httpError.httpStatus = response.status;
        }
        throw httpError;
      }

      const contentType = typeof response.headers?.get === 'function'
        ? (response.headers.get('content-type') || '')
        : '';

      const blob = await response.blob();

      if (!(await isLikelyMediaSegmentBlob(blob, segmentUrl, contentType))) {
        const invalidError = new Error('Received non-media content for HLS segment');
        invalidError.code = 'HLS_INVALID_SEGMENT';
        invalidError.contentType = contentType;
        throw invalidError;
      }

      return blob;
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        const backoffMs = 150 * (attempt + 1);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw lastError;
}

async function fetchInitSegmentBlob(initSegmentUrl, retries, options = {}) {
  return await fetchSegmentWithRetry(initSegmentUrl, retries, options);
}

async function isLikelyMediaSegmentBlob(blob, segmentUrl, contentType = '') {
  const normalizedContentType = String(contentType || '').toLowerCase();

  if (normalizedContentType.includes('text/') || normalizedContentType.includes('html') || normalizedContentType.includes('json') || normalizedContentType.includes('xml')) {
    return false;
  }

  if (!blob || typeof blob.size !== 'number' || blob.size <= 0) {
    return false;
  }

  const headerBytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const headerText = new TextDecoder('utf-8', { fatal: false }).decode(headerBytes).trim().toLowerCase();

  if (headerText.startsWith('<!doctype') || headerText.startsWith('<html') || headerText.includes('<html') || headerText.startsWith('<?xml') || headerText.startsWith('{')) {
    return false;
  }

  const lowerUrl = String(segmentUrl || '').toLowerCase();
  const looksLikeTs = lowerUrl.includes('.ts') || lowerUrl.includes('format=ts') || lowerUrl.includes('mpegts');
  const looksLikeFmp4 = lowerUrl.includes('.m4s') || lowerUrl.includes('.mp4') || lowerUrl.includes('format=mp4') || lowerUrl.includes('cmf');

  if (looksLikeTs) {
    return headerBytes.length >= 1 && headerBytes[0] === 0x47;
  }

  if (looksLikeFmp4) {
    if (headerBytes.length < 8) {
      return false;
    }

    const boxType = String.fromCharCode(headerBytes[4], headerBytes[5], headerBytes[6], headerBytes[7]).toLowerCase();
    return boxType === 'ftyp' || boxType === 'moof' || boxType === 'mdat';
  }

  return blob.size >= 128;
}

async function fetchSegmentResponse(segmentUrl, fetchSegmentFn) {
  if (fetchSegmentFn) {
    return await fetchSegmentFn(segmentUrl);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HLS_SEGMENT_TIMEOUT_MS);

  try {
    return await fetch(segmentUrl, {
      signal: controller.signal,
      credentials: 'include',
      cache: 'no-store'
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isLikelyVideoVariant(resolution, codecs) {
  if (resolution && resolution !== 'unknown') {
    return true;
  }

  const normalizedCodecs = String(codecs || '').toLowerCase();
  if (!normalizedCodecs) {
    return true;
  }

  const hasVideoCodec = /avc1|avc3|hvc1|hev1|dvhe|dvh1|vp09|vp9|av01|theora/.test(normalizedCodecs);
  const hasAudioOnlyCodec = /mp4a|ac-3|ec-3|opus|vorbis|flac/.test(normalizedCodecs) && !hasVideoCodec;

  if (hasVideoCodec) {
    return true;
  }

  if (hasAudioOnlyCodec) {
    return false;
  }

  return true;
}

function resolveUrl(url, baseUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  try {
    return new URL(url, baseUrl).href;
  } catch (error) {
    console.warn('Failed to resolve URL:', url, baseUrl);
    return url;
  }
}


function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
