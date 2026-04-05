/**
 * NARZĘDZIE: openRouter — klient LLM przez OpenRouter
 *
 * OpenRouter to agregator modeli AI — pozwala używać wielu modeli (GPT, Gemini, Claude, itp.)
 * przez jeden spójny API kompatybilny z OpenAI Chat Completions.
 *
 * W tym projekcie używamy modelu google/gemini-2.5-pro.
 *
 * Ten plik dostarcza dwie funkcje:
 *   callLLM()    — wysyła wiadomości do modelu i zwraca odpowiedź tekstową
 *   extractJSON() — parsuje JSON z odpowiedzi LLM (obsługuje markdown code fences)
 *
 * Wzorzec: każdy agent wywołuje callLLM() z własnym system/user promptem
 * i oczekuje odpowiedzi w formacie JSON, który następnie parsuje przez extractJSON().
 */

import { logger, AgentTag } from "../utils/logger";

// ── Typy ──────────────────────────────────────────────────────────────────────

/**
 * Jedna wiadomość w konwersacji z LLM.
 * Rola "system" definiuje zachowanie modelu (instrukcje).
 * Rola "user" to dane wejściowe lub pytanie.
 * Rola "assistant" to poprzednia odpowiedź modelu (używana w multi-turn rozmowach).
 */
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Format odpowiedzi OpenRouter (identyczny z OpenAI Chat Completions API).
 * Interesuje nas choices[0].message.content oraz usage (tokeny — dla kontroli kosztów).
 */
interface OpenRouterResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ── Konfiguracja ───────────────────────────────────────────────────────────────

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL          = "google/gemini-2.5-pro";

// ── Główna funkcja wywołania LLM ───────────────────────────────────────────────

/**
 * Wysyła wiadomości do modelu Gemini 2.5 Pro przez OpenRouter.
 * Loguje wywołanie i odpowiedź pod tagiem agenta wywołującego.
 *
 * @param agent       - tag loggera identyfikujący który agent wywołuje LLM
 * @param apiKey      - klucz OpenRouter z .env
 * @param messages    - tablica wiadomości (system + user, opcjonalnie assistant)
 * @param description - opis celu wywołania (tylko do logów, dla czytelności)
 * @returns           - tekst odpowiedzi modelu (content pierwszego choice)
 */
export async function callLLM(
  agent: AgentTag,
  apiKey: string,
  messages: Message[],
  description: string
): Promise<string> {
  // Logujemy wywołanie z podglądem wiadomości (obcinamy długie treści)
  logger.llmCall(agent, `LLM call: ${description}`, {
    model: MODEL,
    messages: messages.map(m => ({
      role: m.role,
      // Podgląd — nie logujemy całych promptów (mogą być bardzo długie)
      content: m.content.length > 500
        ? m.content.slice(0, 500) + `... [+${m.content.length - 500} chars]`
        : m.content,
    })),
  });

  const startTime = Date.now();

  // Wysyłamy żądanie do OpenRouter — format identyczny z OpenAI API
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer":  "https://github.com/ai-devs/s4e3", // wymagane przez OpenRouter
      "X-Title":       "Domatowo Rescue Operation",        // pojawia się w panelu OpenRouter
    },
    body: JSON.stringify({ model: MODEL, messages }),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error(agent, `OpenRouter HTTP ${response.status}`, { text });
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }

  const data    = (await response.json()) as OpenRouterResponse;
  const elapsed = Date.now() - startTime;
  const content = data.choices[0]?.message?.content ?? "";

  // Logujemy odpowiedź z czasem i zużyciem tokenów
  logger.llmCall(agent, `LLM response (${elapsed}ms)`, {
    usage:   data.usage,
    preview: content.length > 800
      ? content.slice(0, 800) + `... [+${content.length - 800} chars]`
      : content,
  });

  return content;
}

// ── Parser JSON z odpowiedzi LLM ──────────────────────────────────────────────

/**
 * Wyciąga i parsuje JSON z tekstu odpowiedzi LLM.
 *
 * Problem: LLM często opakowuje JSON w markdown code fences:
 *   ```json
 *   { "key": "value" }
 *   ```
 * Mimo że prosimy o "ONLY valid JSON — no markdown fences", modele czasem to ignorują.
 * Ta funkcja usuwa fence'y przed parsowaniem, żeby JSON.parse() zadziałał poprawnie.
 *
 * @param raw - surowy tekst z odpowiedzi LLM
 * @returns   - sparsowany obiekt jako typ T (bez runtime type checking — ufamy LLM)
 * @throws    - SyntaxError jeśli JSON jest niepoprawny
 */
export function extractJSON<T>(raw: string): T {
  // Usuwamy początkowe ``` lub ```json oraz kończące ```
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  return JSON.parse(stripped) as T;
}
