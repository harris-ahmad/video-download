// video-downloader.js - Handles advanced video downloads (HLS, DASH)

/**
 * Downloads an HLS video by parsing the m3u8 manifest and downloading all segments
 * @param {string} manifestUrl - URL to the .m3u8 manifest file
 * @param {Function} onProgress - Callback for progress updates (current, total)
 * @returns {Promise<Blob>} - Combined video blob
 */
async function downloadHLS(manifestUrl, onProgress) {
  try {
    const manifestResponse = await fetch(manifestUrl);
    const manifestText = await manifestResponse.text();

    const parseResult = parseM3U8(manifestText, manifestUrl);

    let segmentUrls;
    if (parseResult.isMasterPlaylist) {
      console.log(`Master playlist detected with ${parseResult.variants.length} variants`);

      const selectedVariant = parseResult.variants[parseResult.variants.length - 1];
      console.log('Fetching variant playlist:', selectedVariant.url);

      const variantResponse = await fetch(selectedVariant.url);
      const variantText = await variantResponse.text();

      const variantResult = parseM3U8(variantText, selectedVariant.url);

      if (variantResult.isMasterPlaylist) {
        throw new Error('Nested master playlists are not supported');
      }

      segmentUrls = variantResult.segments;
    } else {
      segmentUrls = parseResult.segments;
    }

    if (segmentUrls.length === 0) {
      throw new Error('No video segments found in manifest');
    }

    const segments = [];
    for (let i = 0; i < segmentUrls.length; i++) {
      const segmentUrl = segmentUrls[i];

      if (onProgress) {
        onProgress(i + 1, segmentUrls.length, 'Downloading segments');
      }

      try {
        const segmentResponse = await fetch(segmentUrl);
        const segmentBlob = await segmentResponse.blob();
        segments.push(segmentBlob);
      } catch (error) {
        console.warn(`Failed to download segment ${i + 1}/${segmentUrls.length}:`, error);
      }
    }

    if (onProgress) {
      onProgress(segmentUrls.length, segmentUrls.length, 'Remuxing to MP4');
    }

    const mp4Blob = await transmuxToMP4(segments);
    return mp4Blob;

  } catch (error) {
    throw new Error(`HLS download failed: ${error.message}`);
  }
}

/**
 * Parses an m3u8 manifest file to extract segment URLs or variant playlists
 * @param {string} manifestText - The m3u8 file content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {Object} - { isMasterPlaylist: boolean, segments?: Array, variants?: Array }
 */
function parseM3U8(manifestText, baseUrl) {
  const lines = manifestText.split('\n').map(line => line.trim());

  // Get base URL for resolving relative paths
  const urlObj = new URL(baseUrl);
  const basePath = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

  // Check if this is a master playlist (contains #EXT-X-STREAM-INF)
  const isMasterPlaylist = manifestText.includes('#EXT-X-STREAM-INF');

  if (isMasterPlaylist) {
    // Parse variant playlists from master playlist
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-STREAM-INF')) {
        // Extract bandwidth/quality info
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0;

        const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
        const resolution = resolutionMatch ? resolutionMatch[1] : 'unknown';

        // Next non-comment line is the variant URL
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] && !lines[j].startsWith('#')) {
            const variantUrl = resolveUrl(lines[j], basePath);
            variants.push({
              url: variantUrl,
              bandwidth: bandwidth,
              resolution: resolution
            });
            break;
          }
        }
      }
    }

    return {
      isMasterPlaylist: true,
      variants: variants
    };
  } else {
    // Parse segment URLs from variant playlist
    const segmentUrls = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip comments and empty lines
      if (!line || line.startsWith('#')) {
        continue;
      }

      // This is a segment URL
      const segmentUrl = resolveUrl(line, basePath);
      segmentUrls.push(segmentUrl);
    }

    return {
      isMasterPlaylist: false,
      segments: segmentUrls
    };
  }
}

async function downloadDASH(manifestUrl, onProgress) {
  try {
    const manifestResponse = await fetch(manifestUrl);
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

    const trackData = extractSegments(bestRepresentation, basePath, adaptationSet);

    if (contentType.includes('video') || (!contentType && trackData.hasVideo)) {
      result.video = trackData;
    } else if (contentType.includes('audio') || (!contentType && trackData.hasAudio)) {
      result.audio = trackData;
    }
  }

  return result;
}

function extractSegments(representation, basePath, adaptationSet) {
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

async function getHLSVariants(manifestUrl) {
  const manifestResponse = await fetch(manifestUrl);
  const manifestText = await manifestResponse.text();
  const parseResult = parseM3U8(manifestText, manifestUrl);

  if (parseResult.isMasterPlaylist) {
    return parseResult.variants.map((v, i) => ({
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
    isLow: false
  }];
}

async function downloadHLSWithQuality(variantUrl, onProgress) {
  const variantResponse = await fetch(variantUrl);
  const variantText = await variantResponse.text();
  const variantResult = parseM3U8(variantText, variantUrl);

  const segmentUrls = variantResult.segments;

  if (!segmentUrls || segmentUrls.length === 0) {
    throw new Error('No segments found');
  }

  const segments = [];
  for (let i = 0; i < segmentUrls.length; i++) {
    if (onProgress) {
      onProgress(i + 1, segmentUrls.length, 'Downloading segments');
    }

    try {
      const segmentResponse = await fetch(segmentUrls[i]);
      const segmentBlob = await segmentResponse.blob();
      segments.push(segmentBlob);
    } catch (error) {
      console.warn(`Segment ${i + 1} failed:`, error);
    }
  }

  if (onProgress) {
    onProgress(segmentUrls.length, segmentUrls.length, 'Remuxing to MP4');
  }

  return await transmuxToMP4(segments);
}

async function transmuxToMP4(tsSegments) {
  return new Promise(async (resolve) => {
    try {
      if (typeof muxjs === 'undefined') {
        console.warn('mux.js not available, returning raw TS');
        const combinedBlob = new Blob(tsSegments, { type: 'video/mp2t' });
        resolve(combinedBlob);
        return;
      }

      const transmuxer = new muxjs.mp4.Transmuxer({
        keepOriginalTimestamps: true
      });

      const mp4Segments = [];

      transmuxer.on('data', (segment) => {
        if (segment.initSegment) {
          mp4Segments.push(new Uint8Array(segment.initSegment.byteLength));
          mp4Segments[mp4Segments.length - 1].set(segment.initSegment);
        }

        mp4Segments.push(new Uint8Array(segment.data.byteLength));
        mp4Segments[mp4Segments.length - 1].set(segment.data);
      });

      transmuxer.on('done', () => {
        const mp4Blob = new Blob(mp4Segments, { type: 'video/mp4' });
        resolve(mp4Blob);
      });

      for (let i = 0; i < tsSegments.length; i++) {
        const arrayBuffer = await tsSegments[i].arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        transmuxer.push(uint8Array);
      }

      transmuxer.flush();

    } catch (error) {
      console.error('Transmux failed:', error);
      const combinedBlob = new Blob(tsSegments, { type: 'video/mp2t' });
      resolve(combinedBlob);
    }
  });
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

/**
 * Triggers download of a blob with a filename
 * @param {Blob} blob - The blob to download
 * @param {string} filename - Suggested filename
 */
function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Clean up the object URL after a delay
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
