#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const hostPath = path.resolve(__dirname, 'index.js');
const inputPath = process.argv[2];

if (!inputPath) {
  console.error('Usage: node native-helper/test-host.js /absolute/path/to/input.ts');
  process.exit(1);
}

const message = {
  action: 'convertTsToMp4',
  inputPath: inputPath
};

const body = Buffer.from(JSON.stringify(message), 'utf8');
const header = Buffer.alloc(4);
header.writeUInt32LE(body.length, 0);

const child = spawn(hostPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });

const outputChunks = [];
child.stdout.on('data', (chunk) => outputChunks.push(chunk));

child.on('close', (code) => {
  if (code !== 0) {
    console.error(`Host exited with code ${code}`);
    process.exit(code || 1);
  }

  const data = Buffer.concat(outputChunks);
  if (data.length < 4) {
    console.error('No native message returned');
    process.exit(1);
  }

  const length = data.readUInt32LE(0);
  const payload = data.subarray(4, 4 + length).toString('utf8');
  console.log(payload);
});

child.stdin.write(header);
child.stdin.write(body);
child.stdin.end();
