import OpenAI from "openai";
import { config } from "../config";
import { logger } from "../utils/logger";
import { LlmMessage } from "../types";

// ─── OpenAI client pointed at OpenRouter ──────────────────────────────────────

/**
 * OpenRouter exposes an OpenAI-compatible API.
 * We configure the base URL and pass the OpenRouter key as the auth token.
 */
const client = new OpenAI({
  apiKey: config.openRouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    // OpenRouter attribution headers (good practice)
    "HTTP-Referer": "https://github.com/AI-Devs4",
    "X-Title": "AI-Devs4 s5e4 Rocket Navigation Agent",
  },
});

// ─── Core LLM call ────────────────────────────────────────────────────────────

/**
 * Calls the LLM with the given messages and returns the response text.
 *
 * Uses the configured primary model (Gemini Flash 1.5) which is fast and
 * cost-effective for the simple classification/extraction tasks in this project:
 *   - Interpret nautical radio hints → one of "left"/"right"/"front"
 *   - Extract fields from corrupted JSON → frequency + detectionCode
 *
 * Falls back to the secondary model if the primary fails repeatedly.
 */
export async function callLlm(
  messages: LlmMessage[],
  options: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  } = {}
): Promise<string> {
  const model = options.model ?? config.llmModel;
  const temperature = options.temperature ?? 0.0; // Deterministic for classification
  const maxTokens = options.maxTokens ?? 200;     // Short answers expected

  logger.llmPrompt(model, messages);

  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    });

    const responseText = completion.choices[0]?.message?.content?.trim() ?? "";
    logger.llmResponse(model, responseText);
    return responseText;
  } catch (err) {
    // If primary model fails, try fallback before propagating the error
    if (model !== config.llmFallbackModel) {
      logger.warn("LLM", `Primary model ${model} failed, retrying with fallback ${config.llmFallbackModel}`);
      return callLlm(messages, { ...options, model: config.llmFallbackModel });
    }
    throw err;
  }
}
