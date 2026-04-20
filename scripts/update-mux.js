#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUTPUT_FILE = path.resolve(__dirname, '..', 'mux.min.js');
const versionArg = process.argv[2];

function getJson(url) {
  return getText(url).then((text) => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Failed to parse JSON from ${url}: ${error.message}`);
    }
  });
}

function getText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const statusCode = response.statusCode || 0;

      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        if (redirectCount >= 5) {
          reject(new Error(`Too many redirects while requesting ${url}`));
          return;
        }

        const redirectUrl = new URL(response.headers.location, url).toString();
        response.resume();
        getText(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Request failed for ${url} (HTTP ${statusCode})`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    request.on('error', reject);
  });
}

function validateMuxBundle(content, version) {
  if (!content || content.length < 5000) {
    throw new Error(`Downloaded bundle is too small for mux.js@${version}`);
  }

  if (!content.includes('muxjs') && !content.includes('Transmuxer')) {
    throw new Error(`Downloaded file does not look like mux.js@${version}`);
  }
}

async function resolveVersion() {
  if (versionArg && versionArg.trim()) {
    return versionArg.trim();
  }

  const latestMeta = await getJson('https://registry.npmjs.org/mux.js/latest');
  if (!latestMeta.version) {
    throw new Error('Could not resolve latest mux.js version from npm registry');
  }

  return latestMeta.version;
}

async function run() {
  const version = await resolveVersion();
  const url = `https://unpkg.com/mux.js@${version}/dist/mux.min.js`;

  console.log(`Downloading mux.js@${version} from ${url}`);
  const bundle = await getText(url);
  validateMuxBundle(bundle, version);

  fs.writeFileSync(OUTPUT_FILE, bundle, 'utf8');
  const bytes = Buffer.byteLength(bundle, 'utf8');

  console.log(`Updated ${path.basename(OUTPUT_FILE)} (${bytes.toLocaleString()} bytes)`);
  console.log('Done.');
}

run().catch((error) => {
  console.error(`update-mux failed: ${error.message}`);
  process.exit(1);
});
