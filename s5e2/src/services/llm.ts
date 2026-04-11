/**
 * llm.ts — LLM reasoning service via OpenRouter
 *
 * The LLM is used to INTERPRET the operator's responses, not to generate our
 * scripted lines (those are hardcoded in the agent).  Tasks:
 *
 *  - analyzeRoadStatus()      → Which of RD224, RD472, RD820 are passable?
 *  - detectPasswordRequest()  → Is the operator asking for a password?
 *  - extractFlag()            → Is there a {{FLG:...}} pattern in the text?
 *  - generatePoliteReply()    → Fallback: craft a sensible Polish response
 *                               when the operator says something unexpected.
 */

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

// Use a fast, cheap model for analysis tasks
const ANALYSIS_MODEL = 'openai/gpt-4o-mini';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function chat(systemPrompt: string, userMessage: string): Promise<string> {
  const response = await client.chat.completions.create({
    model:       ANALYSIS_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  },
    ],
  });
  return response.choices[0]?.message?.content?.trim() ?? '';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Determine which of the three roads are described as passable/safe.
 *
 * Returns an array of road IDs (e.g. ["RD224", "RD820"]).
 * Falls back to keyword search if the LLM response is unparseable.
 */
export async function analyzeRoadStatus(operatorText: string): Promise<string[]> {
  log('STEP', 'LLM: analysing road status from operator message', { text: operatorText });

  const system = `
Jesteś asystentem analizującym komunikaty operatora systemu w języku polskim.
Twoim zadaniem jest ustalenie, które z podanych dróg są PRZEJEZDNE (bezpieczne, wolne, drożne, bez problemu itp.).
Drogi do sprawdzenia: RD224, RD472, RD820.

Odpowiedz WYŁĄCZNIE tablicą JSON zawierającą identyfikatory przejezdnych dróg, np.:
["RD224", "RD820"]
Jeśli żadna nie jest przejezdna, zwróć: []
Nie dodawaj żadnych komentarzy — tylko tablicę JSON.
`.trim();

  let raw = '';
  try {
    raw = await chat(system, operatorText);
    log('DEBUG', 'LLM road analysis raw response', { raw });
    const roads = JSON.parse(raw) as string[];
    log('INFO', 'Passable roads identified by LLM', { roads });
    return roads;
  } catch {
    log('WARN', 'LLM response unparseable — falling back to keyword search', { raw });
    // Simple keyword extraction as safety net
    const found: string[] = [];
    if (operatorText.includes('RD224')) found.push('RD224');
    if (operatorText.includes('RD472')) found.push('RD472');
    if (operatorText.includes('RD820')) found.push('RD820');
    log('INFO', 'Fallback keyword extraction result', { found });
    return found;
  }
}

/**
 * Decide if the operator is requesting a secret password / authorisation code.
 * Checks common Polish keywords first (fast path), then LLM (slow path).
 */
export async function detectPasswordRequest(operatorText: string): Promise<boolean> {
  log('STEP', 'LLM: detecting password request', { text: operatorText });

  // Fast keyword check
  const passwordKeywords = [
    'hasło', 'kod dostępu', 'autoryzacja', 'weryfikacja',
    'identyfikator', 'podaj kod', 'password', 'klucz', 'pin',
    'przepustka', 'uwierzytelnienie',
  ];
  const lower = operatorText.toLowerCase();
  if (passwordKeywords.some(kw => lower.includes(kw))) {
    log('INFO', 'Password request detected via keyword match');
    return true;
  }

  // LLM confirmation for subtler phrasing
  const system = `
Analizujesz odpowiedź operatora systemu w języku polskim.
Odpowiedz TYLKO słowem "true" albo "false": czy operator prosi o hasło, kod autoryzacyjny lub tajne słowo?
`.trim();

  const raw = await chat(system, operatorText);
  const result = raw.toLowerCase().startsWith('true');
  log('INFO', 'Password request detection (LLM)', { result, raw });
  return result;
}

/**
 * Scan any text for the AI Devs flag pattern {{FLG:...}}.
 * Returns the full flag string if found, otherwise null.
 */
export function extractFlag(text: string): string | null {
  // The hub uses single-brace format: {FLG:VALUE}
  // Also accept double-brace {{FLG:VALUE}} as a safety net
  const match = text.match(/\{+FLG:[A-Z0-9_]+\}+/);
  if (match) {
    log('INFO', 'FLAG DETECTED', { flag: match[0] });
    return match[0];
  }
  return null;
}

/**
 * Generate a short, sensible Polish reply when the operator says something
 * we did not anticipate (unknown state / unexpected question).
 *
 * @param conversationHistory - Recent turns for context
 * @param operatorText        - What the operator just said
 */
export async function generatePoliteReply(
  conversationHistory: string,
  operatorText: string
): Promise<string> {
  log('STEP', 'LLM: generating ad-hoc Polish reply for unexpected operator message');

  const system = `
Jesteś agentem o imieniu Tymon Gajewski rozmawiającym telefonicznie z operatorem systemu.
Prowadzisz rozmowę w języku polskim.
Twoim celem jest:
1. Zidentyfikować, która z dróg (RD224, RD472, RD820) jest przejezdna.
2. Poprosić o wyłączenie monitoringu na przejezdnej drodze.
3. Podać hasło BARBAKAN jeśli zostaniesz o to poproszony.

Historia rozmowy (dla kontekstu):
${conversationHistory}

Napisz KRÓTKĄ, naturalną odpowiedź w języku polskim (max 2 zdania).
Nie ujawniaj, że jesteś botem. Odpowiedz tylko tekstem odpowiedzi, bez żadnych komentarzy.
`.trim();

  const reply = await chat(system, `Operator powiedział: "${operatorText}"`);
  log('INFO', 'Ad-hoc reply generated', { reply });
  return reply;
}
