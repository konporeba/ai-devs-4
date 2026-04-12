import { getRadioHint } from "../services/apiClient";
import { callLlm } from "../services/llmClient";
import { logger } from "../utils/logger";
import { RockDirection, ScoutResult } from "../types";

// ─── Valid directions ──────────────────────────────────────────────────────────

const VALID_DIRECTIONS: RockDirection[] = ["left", "right", "front"];

// ─── LLM prompt ───────────────────────────────────────────────────────────────

/**
 * The system prompt teaches the LLM the spatial context of the game and all
 * nautical/directional vocabulary it might encounter in the radio hints.
 *
 * Key insight from the task spec: "Komunikaty radiowe czasami bywają dziwne
 * i używają języka stosowanego w żegludze." (Radio messages sometimes use
 * nautical language.)
 */
const SCOUT_SYSTEM_PROMPT = `You are the navigator of a ground-to-air rocket travelling forward on a 3-row grid.
The rocket is always moving forward (to the right). In the NEXT column, there is exactly ONE rock.

Your task: Read the radio hint and determine where the rock is RELATIVE TO THE ROCKET.

Return exactly one word — nothing else:
- "left"  — the rock is in the row ABOVE the rocket (port side, north, upper)
- "right" — the rock is in the row BELOW the rocket (starboard side, south, lower)
- "front" — the rock is in the SAME row as the rocket (dead ahead, bow)

Nautical vocabulary reference:
- port / left / larboard = LEFT
- starboard / right = RIGHT
- bow / ahead / forward / dead ahead / straight ahead = FRONT
- north / above / upper = LEFT (the rocket travels east, so north is left)
- south / below / lower = RIGHT (south relative to eastward travel is right)
- aft / stern / behind = irrelevant (the rock is AHEAD, focus on which row)

If the hint says something like "rock is to your left" or "obstacle on port side" → "left"
If the hint says "obstacle dead ahead" or "rock straight in front" → "front"
If the hint says "danger to starboard" or "rock on the right" → "right"

Important: return ONLY ONE of these three words: left, right, front`;

// ─── Parse LLM response ───────────────────────────────────────────────────────

/**
 * Extracts the rock direction from the LLM's response.
 * The LLM is instructed to return a single word, but we clean up just in case.
 */
function parseDirection(llmResponse: string): RockDirection | null {
  const cleaned = llmResponse.toLowerCase().trim();

  // Try exact match first
  if (VALID_DIRECTIONS.includes(cleaned as RockDirection)) {
    return cleaned as RockDirection;
  }

  // Try to find the direction word anywhere in the response (fallback)
  for (const dir of VALID_DIRECTIONS) {
    if (cleaned.includes(dir)) {
      return dir;
    }
  }

  return null;
}

// ─── Scout Agent ──────────────────────────────────────────────────────────────

/**
 * The Scout Agent fetches a radio hint from the game API and uses the LLM
 * to interpret it into a structured rock direction.
 *
 * This agent handles the "nautical language" challenge described in the task:
 * radio messages may use sailing terminology (port/starboard/bow) or unusual
 * spatial references that require semantic understanding rather than simple
 * keyword matching.
 *
 * Flow:
 *   1. Fetch raw hint from /api/getmessage
 *   2. Send hint to LLM with game context prompt
 *   3. Parse LLM output into one of: "left" | "right" | "front"
 *   4. If LLM output is ambiguous, retry once with a clarifying prompt
 */
export async function runScoutCheck(): Promise<ScoutResult> {
  logger.info("SCOUT", "Fetching radio hint about next column...");

  const rawHint = await getRadioHint();
  logger.scoutHint(rawHint);

  // ── First attempt: standard prompt ────────────────────────────────────────
  const messages = [
    { role: "system" as const, content: SCOUT_SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: `Radio hint: "${rawHint}"\n\nWhere is the rock? (respond with exactly one word: left, right, or front)`,
    },
  ];

  let llmResponse = await callLlm(messages, { temperature: 0.0, maxTokens: 20 });
  let direction = parseDirection(llmResponse);

  // ── Retry with clarifying prompt if first attempt failed ──────────────────
  if (!direction) {
    logger.warn(
      "SCOUT",
      `LLM returned unrecognised direction: "${llmResponse}" — retrying with clarifying prompt`
    );

    const retryMessages = [
      ...messages,
      { role: "assistant" as const, content: llmResponse },
      {
        role: "user" as const,
        content: `That is not a valid answer. You MUST respond with exactly one of these three words only: "left", "right", or "front". Which one is it based on the hint: "${rawHint}"?`,
      },
    ];

    llmResponse = await callLlm(retryMessages, { temperature: 0.0, maxTokens: 10 });
    direction = parseDirection(llmResponse);
  }

  // ── Final fallback: if LLM still can't determine direction ────────────────
  if (!direction) {
    // Default to "front" as a conservative fallback — we'll avoid that row.
    // This prevents a total failure; the decision maker will find an alternative.
    logger.error(
      "SCOUT",
      `Could not determine rock direction from hint: "${rawHint}" (LLM: "${llmResponse}"). Defaulting to "front".`
    );
    direction = "front";
  }

  logger.scoutDirection(direction);

  return {
    rawHint,
    rockDirection: direction,
  };
}
