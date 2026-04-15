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

/**
 * Downloads a DASH video by parsing the MPD manifest
 * @param {string} manifestUrl - URL to the .mpd manifest file
 * @param {Function} onProgress - Callback for progress updates
 * @returns {Promise<Blob>} - Combined video blob
 */
async function downloadDASH(manifestUrl, onProgress) {
  try {
    // Fetch the MPD manifest
    const manifestResponse = await fetch(manifestUrl);
    const manifestText = await manifestResponse.text();

    // Parse XML
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(manifestText, 'text/xml');

    // Extract segment URLs (simplified - DASH is complex)
    const segmentUrls = parseMPD(xmlDoc, manifestUrl);

    if (segmentUrls.length === 0) {
      throw new Error('No video segments found in MPD manifest');
    }

    // Download all segments
    const segments = [];
    for (let i = 0; i < segmentUrls.length; i++) {
      if (onProgress) {
        onProgress(i + 1, segmentUrls.length);
      }

      try {
        const segmentResponse = await fetch(segmentUrls[i]);
        const segmentBlob = await segmentResponse.blob();
        segments.push(segmentBlob);
      } catch (error) {
        console.warn(`Failed to download segment ${i + 1}:`, error);
      }
    }

    // Concatenate segments
    const combinedBlob = new Blob(segments, { type: 'video/mp4' });
    return combinedBlob;

  } catch (error) {
    throw new Error(`DASH download failed: ${error.message}`);
  }
}

/**
 * Simplified MPD parser (DASH manifests are complex, this handles basic cases)
 * @param {Document} xmlDoc - Parsed XML document
 * @param {string} baseUrl - Base URL for resolving paths
 * @returns {Array<string>} - Array of segment URLs
 */
function parseMPD(xmlDoc, baseUrl) {
  // This is a simplified implementation
  // Full DASH support would require handling templates, timelines, etc.
  const segmentUrls = [];

  // Try to find SegmentList or SegmentTemplate
  const segmentLists = xmlDoc.getElementsByTagName('SegmentList');

  if (segmentLists.length > 0) {
    const segmentURLs = segmentLists[0].getElementsByTagName('SegmentURL');
    const urlObj = new URL(baseUrl);
    const basePath = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

    for (let i = 0; i < segmentURLs.length; i++) {
      const media = segmentURLs[i].getAttribute('media');
      if (media) {
        segmentUrls.push(resolveUrl(media, basePath));
      }
    }
  }

  return segmentUrls;
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
