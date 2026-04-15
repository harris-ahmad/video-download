// video-downloader.js - Handles advanced video downloads (HLS, DASH)

/**
 * Downloads an HLS video by parsing the m3u8 manifest and downloading all segments
 * @param {string} manifestUrl - URL to the .m3u8 manifest file
 * @param {Function} onProgress - Callback for progress updates (current, total)
 * @returns {Promise<Blob>} - Combined video blob
 */
async function downloadHLS(manifestUrl, onProgress) {
  try {
    // Step 1: Fetch the m3u8 manifest
    const manifestResponse = await fetch(manifestUrl);
    const manifestText = await manifestResponse.text();

    // Step 2: Parse the manifest to get segment URLs
    const segmentUrls = parseM3U8(manifestText, manifestUrl);

    if (segmentUrls.length === 0) {
      throw new Error('No video segments found in manifest');
    }

    // Step 3: Download all segments
    const segments = [];
    for (let i = 0; i < segmentUrls.length; i++) {
      const segmentUrl = segmentUrls[i];

      // Update progress
      if (onProgress) {
        onProgress(i + 1, segmentUrls.length);
      }

      try {
        const segmentResponse = await fetch(segmentUrl);
        const segmentBlob = await segmentResponse.blob();
        segments.push(segmentBlob);
      } catch (error) {
        console.warn(`Failed to download segment ${i + 1}/${segmentUrls.length}:`, error);
        // Continue anyway - partial download is better than nothing
      }
    }

    // Step 4: Concatenate all segments into one blob
    const combinedBlob = new Blob(segments, { type: 'video/mp2t' });
    return combinedBlob;

  } catch (error) {
    throw new Error(`HLS download failed: ${error.message}`);
  }
}

/**
 * Parses an m3u8 manifest file to extract segment URLs
 * @param {string} manifestText - The m3u8 file content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {Array<string>} - Array of segment URLs
 */
function parseM3U8(manifestText, baseUrl) {
  const lines = manifestText.split('\n').map(line => line.trim());
  const segmentUrls = [];

  // Get base URL for resolving relative paths
  const urlObj = new URL(baseUrl);
  const basePath = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comments and empty lines
    if (!line || line.startsWith('#')) {
      // Check if this is a master playlist pointing to another m3u8
      if (line.includes('#EXT-X-STREAM-INF')) {
        // This is a master playlist, we need the variant playlist URL
        // The next non-comment line is the variant playlist
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] && !lines[j].startsWith('#')) {
            const variantUrl = resolveUrl(lines[j], basePath);
            // For simplicity, just use the first variant (could be improved to select quality)
            console.log('Master playlist detected, fetching variant:', variantUrl);
            // This is a recursive case - we'd need to fetch this URL
            // For now, just return empty and let the user know
            throw new Error('Master playlist detected - please use a direct variant playlist URL');
          }
        }
      }
      continue;
    }

    // This is a segment URL
    const segmentUrl = resolveUrl(line, basePath);
    segmentUrls.push(segmentUrl);
  }

  return segmentUrls;
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

/**
 * Resolves a URL (absolute or relative) against a base URL
 * @param {string} url - URL to resolve
 * @param {string} baseUrl - Base URL
 * @returns {string} - Resolved absolute URL
 */
function resolveUrl(url, baseUrl) {
  // If already absolute, return as-is
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  // Handle relative URLs
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
