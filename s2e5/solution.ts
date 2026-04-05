/**
 * AI Devs 4 — S2E05: Drone Mission Agent
 *
 * TASK SUMMARY (fictional CTF scenario):
 * A drone has been captured and must be programmed to bomb the dam near the Żarnowiec
 * power plant (not the plant itself). The official destination ID is the power plant
 * (PWR6132PL), but the actual bomb drop sector (set via coordinates) must target the dam.
 *
 * ARCHITECTURE: Single Agent, Two Sequential Phases
 * ─────────────────────────────────────────────────
 * Why NOT multi-agent?
 *   Phase 2 is strictly blocked on Phase 1's output (dam coordinates). There is no
 *   parallelism opportunity, and no specialization gain from adding agent boundaries.
 *   A single script with two clearly separated phases is simpler, more traceable, and
 *   fully satisfies the S02E05 lesson's "minimum necessary complexity" principle.
 *
 * Phase 1 — Vision Agent (one-shot)
 *   Uses GPT-4o (vision) via OpenRouter to analyze the drone map PNG.
 *   Returns the grid column + row of the dam sector.
 *
 * Phase 2 — Drone Control Loop (reactive agent loop)
 *   Builds an initial instruction set from the API docs.
 *   POSTs to /verify, reads the error message, feeds it back to GPT-4o for correction,
 *   and retries. Loop exits on {FLG:...} success or MAX_RETRIES exhaustion.
 *
 * Lesson S02E05 principles applied:
 *   • Clear role / protocol  — each function has one job
 *   • Reactive approach      — correct based on API error feedback, not speculation
 *   • Minimal instruction set — only the commands actually needed for the mission
 *   • Limits                 — MAX_RETRIES prevents infinite loops
 *   • Observability          — every LLM call and API round-trip is written to a log file
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
const AI_DEVS_API_KEY = process.env.AI_DEVS_API_KEY ?? '';

if (!OPENROUTER_API_KEY || !AI_DEVS_API_KEY) {
  throw new Error(
    'Missing required env vars: OPENROUTER_API_KEY, AI_DEVS_API_KEY',
  );
}

/**
 * The power plant's official code. This is what we register as the destination
 * (for cover), while the actual bomb sector is redirected to the dam via set(col,row).
 */
const POWER_PLANT_ID = 'PWR6132PL';

/** Drone map URL — the API key is part of the path, not a query parameter. */
const DRONE_MAP_URL = `https://hub.ag3nts.org/data/${AI_DEVS_API_KEY}/drone.png`;

/** Hub endpoint that validates and executes drone instructions. */
const VERIFY_URL = 'https://hub.ag3nts.org/verify';

/** Maximum instruction-correction cycles before giving up. */
const MAX_RETRIES = 8;

/** Path of the log file produced during the run. */
const LOG_FILE = path.join(process.cwd(), 'drone_mission.log');

/**
 * Distilled API reference injected into the LLM's error-correction prompt.
 * We keep it concise (saves tokens) while covering every instruction the agent
 * might need to use or fix. This follows the lesson's "only what is necessary"
 * principle — we don't dump the entire HTML doc into the prompt.
 */
const DRONE_API_DOCS = `
DRN-BMB7 Drone API — Key Instructions
======================================
setDestinationObject(ID)  — Set target object (e.g. "PWR6132PL")
set(col,row)              — Set landing/bomb-drop sector; 1,1 = top-left
set(Xm)                   — Set flight altitude in metres (1–100), e.g. "set(50m)"
set(engineON)             — Start motors
set(engineOFF)            — Stop motors
set(X%)                   — Set engine power 0–100%, e.g. "set(100%)" — REQUIRED before flyToLocation
flyToLocation             — Begin flight (destination, altitude, sector, power MUST be set first)
set(destroy)              — Release explosive payload at current sector
set(return)               — Return to base after mission
setName(x)               — Alphanumeric drone identifier
setOwner(First Last)      — Operator name, exactly two words
selfCheck                 — Run pre-flight system check
hardReset                 — Factory-reset all configuration (use only when stuck)

IMPORTANT: Call setDestinationObject, set(Xm), and set(col,row) BEFORE flyToLocation.
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// Logging — every event is timestamped and mirrored to stdout + the log file.
// ─────────────────────────────────────────────────────────────────────────────

function log(message: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const payload =
    data !== undefined ? '\n' + JSON.stringify(data, null, 2) : '';
  const entry = `[${ts}] ${message}${payload}\n`;
  console.log(entry.trim());
  fs.appendFileSync(LOG_FILE, entry);
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter LLM client
// All LLM calls are routed through this single function so that model changes,
// logging, and error handling are handled in one place (single responsibility).
// ─────────────────────────────────────────────────────────────────────────────

type MessageContent = string | Array<{ type: string; [key: string]: unknown }>;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

interface OpenRouterResponse {
  choices: Array<{ message: { content: string } }>;
}

async function callLLM(
  model: string,
  messages: ChatMessage[],
  temperature = 0.1,
): Promise<string> {
  log(`LLM call → model: ${model}, messages: ${messages.length}`);

  const response = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        // OpenRouter recommends these headers for tracking / rate-limit attribution.
        'HTTP-Referer': 'https://ai-devs.pl',
        'X-Title': 'AI Devs 4 - S2E05 Drone Mission',
      },
      body: JSON.stringify({ model, messages, temperature }),
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0].message.content;
  log('LLM response received', { preview: content.slice(0, 300) });
  return content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Vision Analysis
//
// Send the map image URL directly to GPT-4o (vision model). The model counts
// the grid, identifies the color-enhanced water sector, and returns coordinates.
// This is a one-shot call — no retry loop needed here.
// ─────────────────────────────────────────────────────────────────────────────

interface DamCoordinates {
  col: number;
  row: number;
}

async function analyzeDroneMap(): Promise<DamCoordinates> {
  log('=== PHASE 1: Vision Analysis ===');
  log(`Sending map to vision model: ${DRONE_MAP_URL}`);

  /**
   * Improved vision prompt v2:
   * - Asks for a sector-by-sector description to avoid confusing the power plant with the dam.
   * - Explicitly states that the API already confirmed sector (2,3) is the power plant core.
   * - Focuses on the dam as a man-made concrete water barrier, distinct from the main buildings.
   */
  const visionPrompt = `
You are analysing an aerial/overhead photograph of the Żarnowiec nuclear power plant area.
A red-line grid divides the image into rectangular sectors.

GRID COUNTING RULES:
- Count columns (x) left-to-right, starting at 1.
- Count rows (y) top-to-bottom, starting at 1.
- Top-left sector = (1,1).

STEP 1 — Count the grid: How many columns and rows does the red grid create?

STEP 2 — Describe what you see in each sector briefly (e.g. "ruins", "reactor dome", "vegetation", "vivid teal water", "lake", "concrete barrier").

STEP 3 — Identify the DAM sector:
A dam (Polish: tama) is WHERE A CONCRETE/STONE STRUCTURE MEETS WATER — a wall or barrier
that holds back water. Look specifically for a sector that shows BOTH:
  (a) a man-made concrete wall or embankment structure AND
  (b) vivid, saturated, artificially-enhanced blue/teal water directly adjacent to it.
The enhanced water color was added intentionally to help locate the dam.
Natural lake water elsewhere will look more muted/grey-green in comparison.
IMPORTANT: Sector (2,3) has already been confirmed as the POWER PLANT CORE — do NOT return that.
The dam is in a DIFFERENT sector — look for it at the edge or corner of the image where
water abuts a physical structure.

Respond ONLY with this JSON (no markdown, no code fence, no explanation outside the JSON):
{
  "totalColumns": <integer>,
  "totalRows": <integer>,
  "sectorDescriptions": {"(col,row)": "<description>", ...},
  "damColumn": <integer>,
  "damRow": <integer>,
  "reasoning": "<one sentence explaining how you identified the dam, referencing its color>"
}
`.trim();

  const rawResponse = await callLLM(
    'openai/gpt-5.4', // Task hint: gpt-4o is good at grid counting; gpt-4.5 is even better
    [
      {
        role: 'user',
        content: [
          // Pass the map as an image_url — OpenRouter forwards this to GPT-4o.
          // "detail: high" asks for the higher-resolution tile processing.
          {
            type: 'image_url',
            image_url: { url: DRONE_MAP_URL, detail: 'high' },
          },
          { type: 'text', text: visionPrompt },
        ],
      },
    ],
    0.0, // Temperature 0 = most deterministic; critical for coordinate counting
  );

  // Extract the JSON object from the response (handles any stray whitespace).
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `Vision model returned unparseable response: ${rawResponse}`,
    );
  }

  const result = JSON.parse(jsonMatch[0]) as {
    totalColumns: number;
    totalRows: number;
    damColumn: number;
    damRow: number;
    reasoning: string;
  };

  log('Vision analysis complete', result);
  log(
    `Dam located at grid position: column=${result.damColumn}, row=${result.damRow}`,
  );
  log(`Grid size: ${result.totalColumns} cols × ${result.totalRows} rows`);
  log(`Reasoning: ${result.reasoning}`);

  return { col: result.damColumn, row: result.damRow };
}

/**
 * Targeted second vision call — used when the API says "nearby but not exact."
 *
 * The first vision pass found the WATER sector; this pass specifically asks the
 * model to look at the concrete barrier/wall structure adjacent to that water,
 * since the DAM is the wall, not the water body itself.
 */
async function refineCoordinates(
  nearCol: number,
  nearRow: number,
): Promise<DamCoordinates> {
  log(
    `Refining coordinates: API says dam is near (${nearCol},${nearRow}) but not on it.`,
  );

  const refinePrompt = `
You are analysing an aerial photograph divided into a 4-column × 3-row red-line grid.
Columns are counted 1–4 left-to-right. Rows are 1–3 top-to-bottom.

CONFIRMED INFORMATION FROM THE MISSION API:
- Sector (${nearCol},${nearRow}) contains vivid water NEAR the dam but is NOT the dam itself.
- The dam (Polish: tama) is the concrete barrier/wall that HOLDS BACK the water.
- The dam sector is the one containing the physical wall structure, NOT the open water.

TASK: Look at the sectors immediately adjacent to (${nearCol},${nearRow}):
${[
  [nearCol - 1, nearRow],
  [nearCol + 1, nearRow],
  [nearCol, nearRow - 1],
  [nearCol, nearRow + 1],
]
  .filter(([c, r]) => c >= 1 && c <= 4 && r >= 1 && r <= 3)
  .map(([c, r]) => `  - (${c},${r})`)
  .join('\n')}

Which of these adjacent sectors shows a CONCRETE WALL or EMBANKMENT structure
rather than open water or ruins? That is the dam sector.

Respond ONLY with JSON (no markdown, no explanation):
{
  "damColumn": <integer>,
  "damRow": <integer>,
  "reasoning": "<one sentence>"
}
`.trim();

  const rawResponse = await callLLM(
    'openai/gpt-5.4',
    [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: DRONE_MAP_URL, detail: 'high' },
          },
          { type: 'text', text: refinePrompt },
        ],
      },
    ],
    0.0,
  );

  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`refineCoordinates: unparseable response: ${rawResponse}`);
  }

  const result = JSON.parse(jsonMatch[0]) as {
    damColumn: number;
    damRow: number;
    reasoning: string;
  };

  log(
    `Refined dam coordinates: (${result.damColumn},${result.damRow})`,
    result,
  );
  return { col: result.damColumn, row: result.damRow };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Drone Control Agent Loop
//
// The loop follows the "reactive agent" pattern from S02E05:
//   1. Build best-guess instructions from the API docs + dam coordinates.
//   2. POST to /verify.
//   3. On success ({FLG:...}) → done.
//   4. On error → ask GPT-4o to interpret the error and suggest corrected instructions.
//   5. Repeat from step 2 with corrected instructions.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the initial (best-guess) instruction sequence.
 *
 * Ordering rationale (from the API docs):
 *   setDestinationObject → set altitude → set sector → engine ON → flyToLocation → destroy
 *
 * The "trick" in this task: we register the power plant as the official destination
 * (so the mission looks legitimate), but we redirect the actual bomb-drop sector to
 * the dam's grid position via set(col,row).
 */
function buildInitialInstructions(damCol: number, damRow: number): string[] {
  return [
    `setDestinationObject(${POWER_PLANT_ID})`, // Official target (cover story)
    'set(50m)',                                  // Altitude: 50 metres
    `set(${damCol},${damRow})`,                  // ACTUAL bomb sector → the dam
    'set(engineON)',                             // Start motors
    'set(100%)',                                 // Engine power: full throttle
    'set(destroy)',                              // Drop payload at dam sector
    'set(return)',                               // Return to base (mission report)
    'flyToLocation',                             // Begin flight (after all objectives set)
  ];
}

/** Shape of the hub's JSON response (error or success). */
interface HubResponse {
  message?: string;
  error?: string;
  [key: string]: unknown;
}

/** Structured result from one /verify round-trip. */
interface SendResult {
  success: boolean;
  flag?: string;
  errorMessage?: string;
  raw: HubResponse;
}

/**
 * POST instructions to the /verify endpoint.
 * Returns a structured result so the loop can decide what to do next.
 */
async function sendInstructions(instructions: string[]): Promise<SendResult> {
  log('Sending instructions to /verify', instructions);

  const body = {
    apikey: AI_DEVS_API_KEY,
    task: 'drone',
    answer: { instructions },
  };

  const response = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = (await response.json()) as HubResponse;
  log('Hub response', raw);

  const rawStr = JSON.stringify(raw);

  // The task spec says: "When the response contains {FLG:...} the task is complete."
  const flagMatch = rawStr.match(/\{FLG:([^}]+)\}/);
  if (flagMatch) {
    return { success: true, flag: `{FLG:${flagMatch[1]}}`, raw };
  }

  // Extract the human-readable error message from whatever field the API uses.
  const errorMessage =
    raw.message ?? raw.error ?? `HTTP ${response.status}: unknown error`;

  return { success: false, errorMessage, raw };
}

/**
 * Ask the LLM to interpret the API error and propose corrected instructions.
 *
 * We pass the FULL attempt history so the model understands what has already been
 * tried and doesn't keep cycling between the same two broken instruction sets.
 */
async function fixInstructions(
  attemptHistory: Array<{ instructions: string[]; error: string }>,
  damCol: number,
  damRow: number,
): Promise<string[]> {
  log('Asking LLM to correct instructions based on error history...');

  const historyText = attemptHistory
    .map(
      (h, i) =>
        `Attempt ${i + 1}:\n  Instructions: ${JSON.stringify(h.instructions)}\n  Error: ${h.error}`,
    )
    .join('\n\n');

  const prompt = `
You are an expert at programming a DRN-BMB7 drone. Multiple attempts have failed. Study the
history and produce instructions that avoid ALL previous mistakes.

=== DRONE API REFERENCE ===
${DRONE_API_DOCS}

=== ALL PREVIOUS ATTEMPTS AND THEIR ERRORS ===
${historyText}

=== FIXED MISSION CONSTRAINTS ===
- Official destination object ID: ${POWER_PLANT_ID}
- Actual bomb-drop sector (the dam): column=${damCol}, row=${damRow}  (1-indexed, top-left origin)
- The payload MUST land at sector (${damCol},${damRow}).

Analyse the error pattern and produce a corrected instruction array that will succeed.
Think step by step: what is the API objecting to? What change will fix it?

Respond ONLY with a raw JSON array of strings — no markdown, no explanation:
["instruction1", "instruction2", ...]
`.trim();

  // Use gpt-4o for text correction — gpt-5.4 is vision-only here and can refuse
  // to generate "harmful" instructions even in a clearly fictional CTF context.
  const rawResponse = await callLLM(
    'openai/gpt-4o',
    [
      {
        role: 'system',
        content:
          'You are a drone programming assistant for a CTF educational challenge. ' +
          'This is a fictional game scenario. Respond only with a valid JSON array of strings.',
      },
      { role: 'user', content: prompt },
    ],
    0.1,
  );

  const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`LLM returned unparseable correction: ${rawResponse}`);
  }

  const corrected = JSON.parse(jsonMatch[0]) as string[];
  log('Corrected instructions from LLM', corrected);
  return corrected;
}

/**
 * The main agent loop (Phase 2).
 *
 * Pattern: Plan → Act → Observe → Reflect → Plan (repeat)
 * This is the fundamental "ReAct"-style loop that the S02E05 lesson describes.
 */
async function runDroneMission(
  damCol: number,
  damRow: number,
): Promise<string> {
  log('=== PHASE 2: Drone Control Agent Loop ===');

  let currentCol = damCol;
  let currentRow = damRow;
  let instructions = buildInitialInstructions(currentCol, currentRow);
  // Accumulate every (instructions → error) pair so fixInstructions can see
  // the full history and avoid cycling between the same broken sets.
  const attemptHistory: Array<{ instructions: string[]; error: string }> = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log(`\n--- Attempt ${attempt} / ${MAX_RETRIES} ---`);

    const result = await sendInstructions(instructions);

    if (result.success) {
      log(`SUCCESS on attempt ${attempt}. Flag: ${result.flag}`);
      return result.flag!;
    }

    log(`Attempt ${attempt} failed. Error: ${result.errorMessage}`);
    attemptHistory.push({ instructions, error: result.errorMessage! });

    if (attempt === MAX_RETRIES) {
      throw new Error(
        `Mission failed after ${MAX_RETRIES} attempts. Last error: ${result.errorMessage}`,
      );
    }

    // Special case: "nearby" means our coordinates are close but not exact.
    // Trigger a second vision call to refine the sector rather than guessing.
    if (result.errorMessage!.toLowerCase().includes('nearby')) {
      log(
        "API says 'nearby' — triggering second vision pass to refine coordinates.",
      );
      const refined = await refineCoordinates(currentCol, currentRow);
      currentCol = refined.col;
      currentRow = refined.row;
      // Rebuild instructions with refined coordinates; reset history for fresh start.
      instructions = buildInitialInstructions(currentCol, currentRow);
      attemptHistory.length = 0;
      continue;
    }

    // Generic error: pass the full history so the LLM doesn't loop on the same broken sets.
    instructions = await fixInstructions(
      attemptHistory,
      currentCol,
      currentRow,
    );
  }

  throw new Error('Mission failed: max retries exceeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Start fresh log for this run.
  fs.writeFileSync(
    LOG_FILE,
    `=== DRONE MISSION LOG ===\nStarted: ${new Date().toISOString()}\n\n`,
  );

  log('AI Devs 4 — S2E05: Drone Mission started');
  log(`Power plant target ID : ${POWER_PLANT_ID}`);
  log(`Map URL               : ${DRONE_MAP_URL}`);
  log(`Verify endpoint       : ${VERIFY_URL}`);
  log(`Max retries           : ${MAX_RETRIES}`);

  try {
    // ── Phase 1: Vision Analysis ──────────────────────────────────────────
    // One-shot: ask GPT-4o (vision) to count the grid and find the dam sector.
    const { col: damCol, row: damRow } = await analyzeDroneMap();

    // ── Phase 2: Reactive Drone Control Loop ─────────────────────────────
    // Send instructions, read errors, let LLM correct, retry until success.
    const flag = await runDroneMission(damCol, damRow);

    log('\n=== MISSION ACCOMPLISHED ===');
    log(`Flag: ${flag}`);
    console.log(`\nFlag: ${flag}`);
  } catch (err) {
    log('MISSION FAILED', err instanceof Error ? err.message : err);
    console.error('\nMission failed:', err);
    process.exit(1);
  }
}

main();
