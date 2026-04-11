/**
 * hub.ts — HTTP client for the central hub at hub.ag3nts.org/verify
 *
 * Responsibilities:
 *  - startSession()  → POST {action: "start"} to kick off the phonecall task
 *  - sendAudio()     → POST {audio: <base64>} for each conversational turn
 *  - Both return a typed HubResponse so the agent can decide what to do next
 */

import axios, { AxiosError } from 'axios';
import { log } from '../logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HubResponse {
  /** 0 = success; non-zero = some kind of error from the hub */
  code: number;
  /** Text message from the operator (may or may not be present) */
  message?: string;
  /** Base64-encoded MP3 audio from the operator (may or may not be present) */
  audio?: string;
  /** Direct flag answer if the task is complete */
  flag?: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

const HUB_URL    = process.env.CENTRAL_HUB ?? 'https://hub.ag3nts.org/verify';
const API_KEY    = process.env.AI_DEVS_API_KEY!;
const TASK_NAME  = 'phonecall';

// Retry settings
const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 2000;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST to the hub with automatic retry on transient errors.
 */
async function postToHub(body: Record<string, unknown>): Promise<HubResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log('DEBUG', `POST to hub (attempt ${attempt}/${MAX_RETRIES})`, {
        url: HUB_URL,
        bodyKeys: Object.keys(body.answer as object),
      });

      const response = await axios.post<HubResponse>(HUB_URL, body, {
        timeout: 30_000,
        headers: { 'Content-Type': 'application/json' },
      });

      log('DEBUG', 'Hub raw response', {
        status:      response.status,
        code:        response.data.code,
        hasMessage:  !!response.data.message,
        hasAudio:    !!response.data.audio,
        hasFlag:     !!response.data.flag,
        messageSnippet: response.data.message?.substring(0, 120),
      });

      return response.data;

    } catch (err) {
      lastError = err;
      const axiosErr = err as AxiosError;
      const status       = axiosErr.response?.status ?? 'network error';
      const responseBody = axiosErr.response?.data;
      log('WARN', `Hub request failed (attempt ${attempt}/${MAX_RETRIES})`, {
        status,
        message: axiosErr.message,
        responseBody,   // <— shows the hub's actual error payload
      });

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start a new phonecall session.
 * Must be called before any audio turns.
 */
export async function startSession(): Promise<HubResponse> {
  log('STEP', 'Starting phonecall session with hub');

  const response = await postToHub({
    apikey: API_KEY,
    task:   TASK_NAME,
    answer: { action: 'start' },
  });

  log('INFO', 'Session started successfully');
  return response;
}

/**
 * Send a single base64-encoded MP3 audio turn to the operator.
 *
 * @param base64mp3 - Full base64 string of the MP3 audio clip
 */
export async function sendAudio(base64mp3: string): Promise<HubResponse> {
  log('STEP', 'Sending audio turn to hub', { base64Length: base64mp3.length });

  const response = await postToHub({
    apikey: API_KEY,
    task:   TASK_NAME,
    answer: { audio: base64mp3 },
  });

  return response;
}
