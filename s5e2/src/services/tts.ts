/**
 * tts.ts — Polish Text-to-Speech service
 *
 * Uses Microsoft Edge TTS (via the Python `edge-tts` CLI) to produce
 * high-quality neural Polish speech.  The `pl-PL-MarekNeural` voice is
 * used because it sounds natural and is gender-appropriate for the name
 * "Tymon Gajewski".
 *
 * Fallback: google-tts-api (unofficial Google Translate TTS) when edge-tts
 * is not available or fails.
 *
 * Why edge-tts over Google TTS?
 *   The hub's operator checks for TTS-like audio and rejects robotic speech.
 *   Microsoft's neural voices pass this check; Google TTS does not.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from '../logger';

const execFileAsync = promisify(execFile);

// ── Edge TTS ──────────────────────────────────────────────────────────────────

const EDGE_VOICE = 'pl-PL-MarekNeural';  // natural male Polish voice

/**
 * Generate speech via edge-tts (Microsoft Azure Neural TTS, free).
 * Calls the `edge-tts` Python CLI as a subprocess.
 */
async function synthesizeViaEdgeTTS(text: string): Promise<Buffer> {
  const tmpFile = path.join(os.tmpdir(), `edge_tts_${Date.now()}.mp3`);

  try {
    // edge-tts CLI: edge-tts --voice VOICE --text "TEXT" --write-media FILE
    await execFileAsync('edge-tts', [
      '--voice',       EDGE_VOICE,
      '--text',        text,
      '--write-media', tmpFile,
    ], {
      timeout: 20_000,
    });

    if (!fs.existsSync(tmpFile)) {
      throw new Error('edge-tts did not create output file');
    }

    const buffer = fs.readFileSync(tmpFile);
    log('INFO', 'Edge TTS synthesis complete', { bytes: buffer.length, voice: EDGE_VOICE });
    return buffer;

  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

// ── Google TTS fallback ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const googleTTS = require('google-tts-api') as {
  getAudioBase64: (
    text: string,
    opts: { lang: string; slow: boolean; host: string; timeout?: number }
  ) => Promise<string>;
};

async function synthesizeViaGoogleTTS(text: string): Promise<Buffer> {
  log('INFO', 'Falling back to Google TTS');
  const base64 = await googleTTS.getAudioBase64(text, {
    lang:    'pl',
    slow:    false,
    host:    'https://translate.google.com',
    timeout: 15_000,
  });
  return Buffer.from(base64, 'base64');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert Polish text to an MP3 Buffer.
 * Tries edge-tts first (neural, high quality); falls back to Google TTS.
 *
 * @param text - Polish text to synthesise
 */
export async function synthesize(text: string): Promise<Buffer> {
  log('STEP', 'Synthesising Polish speech', { text, charCount: text.length, voice: EDGE_VOICE });

  try {
    return await synthesizeViaEdgeTTS(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('WARN', 'edge-tts failed, falling back to Google TTS', { error: msg });
    return await synthesizeViaGoogleTTS(text);
  }
}

/** Encode a Buffer to base64. */
export function toBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/** One-shot helper: synthesise text and immediately return base64. */
export async function synthesizeToBase64(text: string): Promise<string> {
  const buf = await synthesize(text);
  return toBase64(buf);
}
