import axios, { AxiosError, AxiosResponse } from "axios";
import { config } from "../config";
import { logger } from "../utils/logger";
import {
  GameCommand,
  GameRequest,
  HintRequest,
  HintResponse,
  DisarmRequest,
  DisarmResponse,
} from "../types";

// ─── Retry helper ─────────────────────────────────────────────────────────────

/**
 * Wraps an async operation with exponential-backoff retry logic.
 *
 * The task spec explicitly states: "API może losowo zwracać błędy, nawet jeśli
 * Twoje zapytanie jest poprawne. Twój kod musi być odporny... w razie błędu po
 * prostu ponów zapytanie."
 *
 * Strategy: attempt up to `maxRetries` times with doubling delay between retries.
 */
async function withRetry<T>(
  operationName: string,
  fn: (attempt: number) => Promise<T>,
  maxRetries = config.apiMaxRetries
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // HTTP 4xx handling:
      //   400 Bad Request  → permanent (game session dead / invalid command) — do NOT retry
      //   403 Forbidden    → permanent (auth / permission)                   — do NOT retry
      //   429 Too Many Req → transient (rate limiting)                       — DO retry with longer delay
      //   Other 4xx        → treated as permanent — do NOT retry
      if (err instanceof AxiosError && err.response?.status) {
        const status = err.response.status;
        if (status === 429) {
          // Rate limited — wait longer than normal before retrying
          if (attempt < maxRetries) {
            const delayMs = config.apiRetryDelayMs * Math.pow(2, attempt) * 3; // Longer backoff for 429
            logger.warn("API", `${operationName} received HTTP 429 (rate limited) — retrying in ${delayMs}ms`);
            await sleep(delayMs);
            continue;
          }
        } else if (status >= 400 && status < 500) {
          logger.error("API", `${operationName} received HTTP ${status} — not retrying (client error): ${error.message}`);
          throw error;
        }
      }

      lastError = error;

      if (attempt < maxRetries) {
        const delayMs = config.apiRetryDelayMs * Math.pow(2, attempt - 1);
        logger.apiRetry(attempt, maxRetries, error.message, delayMs);
        await sleep(delayMs);
      } else {
        logger.error("API", `${operationName} failed after ${maxRetries} attempts: ${error.message}`);
      }
    }
  }

  throw lastError ?? new Error(`${operationName} failed`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Game Control API (/verify) ───────────────────────────────────────────────

/**
 * Sends a command to the central game hub.
 * Used for both `start` and movement commands (go/left/right).
 */
export async function sendGameCommand(command: GameCommand): Promise<unknown> {
  const url = config.centralHubUrl;
  const body: GameRequest = {
    apikey: config.aiDevsApiKey,
    task: config.taskName,
    answer: { command },
  };

  return withRetry(`sendGameCommand(${command})`, async (attempt) => {
    logger.apiRequest("POST", url, { ...body, apikey: "***" });

    const response: AxiosResponse = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    logger.apiResponse(response.status, url, response.data, attempt - 1);
    return response.data;
  });
}

// ─── Radio Hint API (/api/getmessage) ────────────────────────────────────────

/**
 * Fetches a radio hint describing where the rock is in the next column.
 * The hint is in English and may use nautical/directional language.
 */
export async function getRadioHint(): Promise<string> {
  const url = config.getMessageUrl;
  const body: HintRequest = { apikey: config.aiDevsApiKey };

  return withRetry("getRadioHint", async (attempt) => {
    logger.apiRequest("POST", url, { apikey: "***" });

    const response: AxiosResponse<HintResponse> = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    logger.apiResponse(response.status, url, response.data, attempt - 1);

    const hint = response.data?.hint;
    if (!hint || typeof hint !== "string") {
      throw new Error(`Unexpected hint response shape: ${JSON.stringify(response.data)}`);
    }

    return hint;
  });
}

// ─── Frequency Scanner API (GET /api/frequencyScanner) ───────────────────────

/**
 * Queries the OKO frequency scanner.
 *
 * Returns the RAW response string — caller is responsible for interpretation.
 * The response is often corrupted by jamming systems and may not be valid JSON.
 *
 * - Safe: response contains "It's clear!" (case-insensitive)
 * - Danger: response contains JSON with `frequency` and `detectionCode`
 */
export async function scanFrequency(): Promise<string> {
  const url = `${config.frequencyScannerBaseUrl}?key=${config.aiDevsApiKey}`;

  return withRetry("scanFrequency", async (attempt) => {
    logger.apiRequest("GET", url.replace(config.aiDevsApiKey, "***"));

    // We use responseType: 'text' because the response may be corrupted JSON
    // that axios would fail to auto-parse
    const response: AxiosResponse<string> = await axios.get(url, {
      responseType: "text",
      timeout: 15000,
      // Don't throw on non-2xx — server may return 200 with error text
      validateStatus: () => true,
    });

    const rawText =
      typeof response.data === "string"
        ? response.data
        : JSON.stringify(response.data);

    logger.apiResponse(response.status, url.replace(config.aiDevsApiKey, "***"), rawText, attempt - 1);

    // Only retry on network-level errors (caught by axios), not on 4xx/5xx content.
    // The 200 with corrupted body is intentional per task spec.
    if (response.status >= 500) {
      throw new Error(`Scanner returned HTTP ${response.status}`);
    }

    return rawText;
  });
}

// ─── Frequency Scanner Disarm API (POST /api/frequencyScanner) ───────────────

/**
 * Sends the computed disarm hash to neutralise an active OKO radar trap.
 * Returns the raw response for the Radar Agent to inspect.
 */
export async function disarmRadar(
  frequency: number,
  disarmHash: string
): Promise<DisarmResponse> {
  const url = config.frequencyScannerBaseUrl;
  const body: DisarmRequest = {
    apikey: config.aiDevsApiKey,
    frequency,
    disarmHash,
  };

  return withRetry("disarmRadar", async (attempt) => {
    logger.apiRequest("POST", url, { ...body, apikey: "***" });

    const response: AxiosResponse<DisarmResponse> = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: () => true,
    });

    logger.apiResponse(response.status, url, response.data, attempt - 1);

    // Treat HTTP 5xx as retriable; 4xx means wrong data (not retriable)
    if (response.status >= 500) {
      throw new Error(`Disarm returned HTTP ${response.status}`);
    }

    return response.data;
  });
}
