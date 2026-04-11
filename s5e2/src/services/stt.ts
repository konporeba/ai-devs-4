/**
 * stt.ts — Polish Speech-to-Text service
 *
 * Strategy (two approaches, automatic fallback):
 *
 * 1. PRIMARY — OpenRouter → GPT-4o-audio-preview
 *    Sends base64 audio as an `input_audio` content block inside a chat
 *    completion request. Works with the standard /v1/chat/completions endpoint
 *    that OpenRouter definitely supports.
 *
 * 2. FALLBACK — OpenRouter → Whisper via /v1/audio/transcriptions
 *    Uses the OpenAI SDK's audio.transcriptions.create(), routed through
 *    OpenRouter. OpenRouter may or may not proxy this endpoint — if it fails
 *    we catch the error and fall back to approach 1.
 *
 * Both approaches ask the model to transcribe Polish audio.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import OpenAI from 'openai';
import { log } from '../logger';

// ── OpenRouter client ─────────────────────────────────────────────────────────
const client = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY!,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/ai-devs4',
    'X-Title':      'AI Devs 4 - S05E02 Phonecall Agent',
  },
});

// ── Primary: GPT-4o-audio-preview via chat completions ────────────────────────

async function transcribeViaAudioPreview(base64audio: string): Promise<string> {
  log('INFO', 'STT attempt 1: GPT-4o-audio-preview via chat completions');

  // The OpenAI SDK's types don't fully expose input_audio content yet,
  // so we cast the messages array to any for this specific call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    {
      role: 'user',
      content: [
        {
          type: 'input_audio',
          input_audio: {
            data:   base64audio,
            format: 'mp3',
          },
        },
        {
          type: 'text',
          text: 'Proszę dokładnie przepisać tę wiadomość audio w języku polskim. Zwróć tylko transkrypcję, bez żadnych komentarzy.',
        },
      ],
    },
  ];

  const response = await client.chat.completions.create({
    model:       'openai/gpt-4o-audio-preview',
    messages,
    temperature: 0,
  });

  const text = response.choices[0]?.message?.content?.trim() ?? '';
  log('INFO', 'STT (audio-preview) result', { text });
  return text;
}

// ── Fallback: Whisper via /v1/audio/transcriptions ────────────────────────────

async function transcribeViaWhisper(base64audio: string): Promise<string> {
  log('INFO', 'STT attempt 2: Whisper via /v1/audio/transcriptions');

  // Write base64 to a temp MP3 file so the SDK can upload it
  const tmpFile = path.join(os.tmpdir(), `stt_${Date.now()}.mp3`);
  const audioBuffer = Buffer.from(base64audio, 'base64');
  fs.writeFileSync(tmpFile, audioBuffer);

  try {
    const transcription = await (client.audio.transcriptions as OpenAI.Audio.Transcriptions).create({
      file:     fs.createReadStream(tmpFile) as Parameters<typeof client.audio.transcriptions.create>[0]['file'],
      model:    'whisper-1',
      language: 'pl',
    });

    const text = transcription.text.trim();
    log('INFO', 'STT (whisper) result', { text });
    return text;
  } finally {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Transcribe a base64-encoded MP3 audio clip to Polish text.
 * Tries GPT-4o-audio-preview first; falls back to Whisper on any error.
 *
 * @param base64audio - Base64-encoded MP3 from the hub
 * @returns           - Transcribed Polish text
 */
export async function transcribe(base64audio: string): Promise<string> {
  log('STEP', 'Transcribing operator audio', { base64Length: base64audio.length });

  // Try primary approach
  try {
    return await transcribeViaAudioPreview(base64audio);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('WARN', 'GPT-4o-audio-preview transcription failed, trying Whisper', { error: msg });
  }

  // Fallback
  try {
    return await transcribeViaWhisper(base64audio);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', 'Both STT approaches failed', { error: msg });
    throw new Error(`STT failed: ${msg}`);
  }
}
