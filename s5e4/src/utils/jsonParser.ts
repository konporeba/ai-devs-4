import { callLlm } from "../services/llmClient";
import { logger } from "./logger";
import { RadarDetection } from "../types";

// ─── Tier 1: Standard JSON parse ─────────────────────────────────────────────

/**
 * Try a plain JSON.parse on the raw string.
 * If it works, extract frequency + detectionCode directly.
 */
function tryDirectParse(raw: string): RadarDetection | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.frequency === "number" &&
      typeof parsed.detectionCode === "string"
    ) {
      return { frequency: parsed.frequency, detectionCode: parsed.detectionCode };
    }
  } catch {
    // Not valid JSON — fall through
  }
  return null;
}

// ─── Tier 2: Regex extraction ─────────────────────────────────────────────────

/**
 * Use regex to extract fields from corrupted JSON-like text.
 * Handles cases where JSON is malformed but field names are still recognisable.
 *
 * Examples of corrupted input that regex can handle:
 *   {frequency: 12345, detectionCode: "abc123"}  (unquoted keys)
 *   {"frequ3ncy": 12345, "d3tectionCode": "abc123"}  (garbled chars)
 *   frequency=12345 detectionCode=abc123  (non-JSON format)
 */
function tryRegexExtract(raw: string): RadarDetection | null {
  // Normalize a lowercase copy of the raw string to find garbled key names.
  // Handles common leet-speak and shape-similarity substitutions:
  //   0 → o, 3 → e, 1 → i, B → D (D and B look similar)
  const norm = raw
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/1/g, "i");

  // ── Frequency ──────────────────────────────────────────────────────────────
  // Find the position of the (normalized) word "frequency" in the text, then
  // extract the numeric value that follows the colon/equals in the ORIGINAL string.
  const freqPos = norm.indexOf("frequency");
  let frequency: number | null = null;
  if (freqPos >= 0) {
    const afterKey = raw.substring(freqPos);
    const m = afterKey.match(/[`"']*\s*[:`=]\s*[`"']?(\d+)/);
    if (m) frequency = parseInt(m[1], 10);
  }

  // ── detectionCode ──────────────────────────────────────────────────────────
  // Same approach: find the normalized "detectioncode" substring, then extract
  // its value from the original string.
  const codePos = norm.indexOf("detectioncode");
  let detectionCode: string | null = null;
  if (codePos >= 0) {
    const afterKey = raw.substring(codePos);
    const m = afterKey.match(/[`"']*\s*[:`=]\s*[`"']([a-zA-Z0-9+/=_-]+)/);
    if (m) detectionCode = m[1].replace(/["'`}\s]/g, "");
  }

  if (frequency !== null && !isNaN(frequency) && detectionCode && detectionCode.length > 0) {
    return { frequency, detectionCode };
  }
  return null;
}

// ─── Tier 3: LLM extraction ───────────────────────────────────────────────────

/**
 * Ask the LLM to extract frequency and detectionCode from heavily corrupted data.
 * This is the last resort — used when direct parse and regex both fail.
 *
 * The LLM is instructed to return ONLY a clean JSON object, nothing else.
 */
async function tryLlmExtract(raw: string): Promise<RadarDetection | null> {
  logger.warn("RADAR", "Regex extraction failed — escalating to LLM for JSON repair");

  const messages = [
    {
      role: "system" as const,
      content: `You are a data extraction assistant. You will receive corrupted or malformed text that was supposed to be a JSON object containing two fields: "frequency" (a number) and "detectionCode" (a string).

Your task:
1. Identify the numeric value associated with "frequency" (may be spelled with numbers replacing letters, e.g. "fr3qu3ncy")
2. Identify the alphanumeric string associated with "detectionCode" (may be spelled with numbers replacing letters, e.g. "d3t3ct10nCod3")
3. Return ONLY a valid JSON object like: {"frequency": 12345, "detectionCode": "abc123xyz"}
4. If you cannot find either field, return: {"error": "not found"}

Do not include any explanation, markdown, or extra text — return ONLY the JSON object.`,
    },
    {
      role: "user" as const,
      content: `Extract frequency and detectionCode from this corrupted data:\n\n${raw}`,
    },
  ];

  try {
    const response = await callLlm(messages, { temperature: 0.0, maxTokens: 150 });

    // Strip markdown code fences if present
    const cleaned = response.replace(/```[a-z]*\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (parsed.error) {
      logger.error("RADAR", `LLM could not extract fields: ${parsed.error}`);
      return null;
    }

    if (typeof parsed.frequency === "number" && typeof parsed.detectionCode === "string") {
      return { frequency: parsed.frequency, detectionCode: parsed.detectionCode };
    }
  } catch (err) {
    logger.error("RADAR", `LLM extraction failed to parse result: ${err}`);
  }

  return null;
}

// ─── Public function ──────────────────────────────────────────────────────────

/**
 * Extracts `frequency` and `detectionCode` from a potentially corrupted radar
 * response string using a 3-tier strategy:
 *
 *   Tier 1: Standard JSON.parse
 *   Tier 2: Regex pattern matching (handles garbled keys/values)
 *   Tier 3: LLM-assisted extraction (for heavily corrupted data)
 *
 * This resilience is critical because the task spec states that scanner
 * responses are deliberately corrupted by OKO jamming systems.
 */
export async function extractRadarFields(raw: string): Promise<RadarDetection> {
  // Tier 1
  const direct = tryDirectParse(raw);
  if (direct) {
    logger.info("RADAR", "Parsed scanner response via standard JSON.parse");
    return direct;
  }

  // Tier 2
  const regex = tryRegexExtract(raw);
  if (regex) {
    logger.info("RADAR", "Parsed scanner response via regex extraction");
    return regex;
  }

  // Tier 3
  logger.radarCorrupted(raw);
  const llm = await tryLlmExtract(raw);
  if (llm) {
    logger.info("RADAR", "Parsed scanner response via LLM extraction");
    return llm;
  }

  throw new Error(
    `Failed to extract radar fields from corrupted response after all 3 tiers. Raw: ${raw}`
  );
}
