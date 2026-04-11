import axios from 'axios';
import FormData from 'form-data';
import { ExtractedInfo } from '../types';
import { logger } from '../logger';

const MAX_AUDIO_SIZE = 5 * 1024 * 1024; // 5 MB
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function mimeToExt(mimeType: string): string {
  if (mimeType.includes('wav'))  return 'wav';
  if (mimeType.includes('ogg'))  return 'ogg';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4'))  return 'mp4';
  return 'mp3';
}

// --- Transcribe via Groq Whisper (preferred, if GROQ_API_KEY is set) ---

async function transcribeViaGroq(buffer: Buffer, mimeType: string): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY!;
  const ext  = mimeToExt(mimeType);
  const form = new FormData();
  form.append('file',            buffer, { filename: `audio.${ext}`, contentType: mimeType });
  form.append('model',           'whisper-large-v3');
  form.append('language',        'pl');
  form.append('response_format', 'text');

  const res = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    {
      headers: { Authorization: `Bearer ${groqKey}`, ...form.getHeaders() },
      timeout: 30_000,
    }
  );
  return typeof res.data === 'string' ? res.data : (res.data.text ?? '');
}

// --- Transcribe via Gemini 2.0 Flash (fallback, uses OPENROUTER_API_KEY) ---
// Gemini supports audio natively — send as base64 data URL via OpenRouter

async function transcribeViaGemini(buffer: Buffer, mimeType: string): Promise<string> {
  const base64  = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const res = await axios.post(
    OPENROUTER_URL,
    {
      model: 'google/gemini-2.0-flash-001',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            {
              type: 'text',
              text: 'Przetransliteruj dokładnie to nagranie audio na tekst po polsku. Zwróć TYLKO tekst transkrypcji, bez żadnych komentarzy.',
            },
          ],
        },
      ],
      temperature: 0,
      max_tokens:  1024,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 45_000,
    }
  );

  return res.data.choices[0]?.message?.content ?? '';
}

// --- Public entry point (returns extracted info + raw transcript for synthesis) ---

export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
): Promise<{ extracted: ExtractedInfo; transcript: string }> {
  logger.debug('AudioTranscriber: received', { mimeType, sizeBytes: buffer.length });

  if (buffer.length > MAX_AUDIO_SIZE) {
    logger.warn('Audio too large, skipping', { sizeBytes: buffer.length });
    return { extracted: {}, transcript: '' };
  }

  let transcript = '';

  try {
    if (process.env.GROQ_API_KEY) {
      logger.debug('AudioTranscriber: using Groq Whisper');
      transcript = await transcribeViaGroq(buffer, mimeType);
    } else {
      logger.debug('AudioTranscriber: falling back to Gemini via OpenRouter');
      transcript = await transcribeViaGemini(buffer, mimeType);
    }
  } catch (err) {
    logger.error('AudioTranscriber transcription failed', { error: String(err) });
    return { extracted: {}, transcript: '' };
  }

  logger.info('Audio transcribed', { length: transcript.length, preview: transcript.slice(0, 150) });

  if (transcript.trim().length === 0) return { extracted: {}, transcript: '' };

  const { analyzeText } = await import('./textAnalyst');
  const extracted = await analyzeText(transcript);
  return { extracted, transcript };
}
