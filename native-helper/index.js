#!/usr/bin/env node

const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

function writeNativeMessage(obj, exitCode = 0) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  const payload = Buffer.concat([header, json]);

  process.stdout.write(payload, () => {
    process.exit(exitCode);
  });
}

function readMessageFromStdin() {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expectedLength = null;

    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (expectedLength === null && buffer.length < 4) {
        cleanup();
        reject(new Error('Native host received empty or malformed message'));
      }
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (expectedLength === null && buffer.length >= 4) {
        expectedLength = buffer.readUInt32LE(0);
      }

      if (expectedLength !== null && buffer.length >= 4 + expectedLength) {
        const body = buffer.subarray(4, 4 + expectedLength).toString('utf8');
        cleanup();

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON payload: ${error.message}`));
        }
      }
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

function ensureFileReadable(filePath) {
  if (!path.isAbsolute(filePath)) {
    throw new Error('inputPath must be an absolute path');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file does not exist: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Input path is not a file: ${filePath}`);
  }
}

function ensureParentDirExists(filePath) {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) {
    throw new Error(`Output directory does not exist: ${parent}`);
  }
}

function runFfmpegConvert(inputPath, outputPath) {
  const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
    throw new Error('ffmpeg is not installed or not available in PATH');
  }

  const args = [
    '-y',
    '-i', inputPath,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    outputPath
  ];

  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });

  if (result.error) {
    throw new Error(`Failed to execute ffmpeg: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const errOutput = (result.stderr || result.stdout || '').trim();
    throw new Error(errOutput || `ffmpeg exited with code ${result.status}`);
  }

  return true;
}

function buildOutputPath(inputPath, requestedOutputPath) {
  if (requestedOutputPath && typeof requestedOutputPath === 'string') {
    if (!path.isAbsolute(requestedOutputPath)) {
      throw new Error('outputPath must be absolute when provided');
    }
    return requestedOutputPath;
  }

  if (/\.ts$/i.test(inputPath)) {
    return inputPath.replace(/\.ts$/i, '.mp4');
  }

  return `${inputPath}.mp4`;
}

async function main() {
  try {
    const message = await readMessageFromStdin();

    if (message?.action !== 'convertTsToMp4') {
      writeNativeMessage({
        success: false,
        error: `Unsupported action: ${message?.action || 'unknown'}`
      }, 0);
      return;
    }

    const inputPath = message.inputPath;
    if (!inputPath || typeof inputPath !== 'string') {
      throw new Error('inputPath is required');
    }

    ensureFileReadable(inputPath);

    const outputPath = buildOutputPath(inputPath, message.outputPath);
    ensureParentDirExists(outputPath);

    runFfmpegConvert(inputPath, outputPath);

    writeNativeMessage({
      success: true,
      outputPath: outputPath
    }, 0);
  } catch (error) {
    writeNativeMessage({
      success: false,
      error: error.message
    }, 0);
  }
}

main();
