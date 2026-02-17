#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAPPINGS_FILE = path.join(process.cwd(), 'relayer-mappings.json');

function encryptPayload(payload, key) {
  const iv = crypto.randomBytes(16);
  const hash = crypto.createHash('sha256').update(String(key)).digest();
  const cipher = crypto.createCipheriv('aes-256-cbc', hash, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(payload, 'utf8')), cipher.final()]);
  return `${iv.toString('base64')}:${encrypted.toString('base64')}`;
}

function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.$$tmp$$`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8' });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (e) { }
}

function main() {
  const key = process.env.RELAYER_MAPPINGS_KEY;
  const initial = {};
  let payload = JSON.stringify(initial, null, 2);
  if (key) {
    try {
      payload = encryptPayload(payload, key);
    } catch (e) {
      console.error('Failed to encrypt initial mappings:', e?.message || e);
      process.exit(2);
    }
  }

  try {
    writeFileAtomic(MAPPINGS_FILE, payload);
    console.log('Initialized mappings file at', MAPPINGS_FILE, key ? '(encrypted)' : '(plaintext)');
  } catch (e) {
    console.error('Failed to write mappings file:', e?.message || e);
    process.exit(3);
  }
}

main();
