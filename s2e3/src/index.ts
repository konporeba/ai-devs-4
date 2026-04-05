/**
 * AI Devs 4 - S2E3: Power Plant Failure Log Analysis Agent
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  ARCHITECTURE: Single Orchestrator Agent + Stateful Tool System          │
 * │                                                                           │
 * │  The lesson's core insight: agents must NOT keep large documents in       │
 * │  their context window. Instead, tools act as background "lenses" that    │
 * │  filter and transform data, returning only small metadata to the agent.  │
 * │                                                                           │
 * │  "Warto mieć narzędzie do przeszukiwania logów, zamiast trzymać je w    │
 * │   całości w pamięci głównego agenta."                                    │
 * │                                                                           │
 * │  Agent context sees:  "Filtered 114 CRIT lines → ~970 tokens"           │
 * │  Agent context NEVER: [2026-03-20 06:04] [CRIT] ECCS8 …(1000 lines)…  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * COMPRESSION STRATEGY (layered, cheap-first):
 *   Layer 1 — Pure JavaScript:  filter by severity → preprocess
 *             (free, removes ~97% of tokens with zero API cost)
 *   Layer 2 — Cheap LLM (gpt-4o-mini): compress further if still over limit
 *             (called only when JS preprocessing is not enough)
 *
 * ITERATION LOOP:
 *   download → filter(CRIT) → preprocess → count → [compress?] → submit
 *   → read feedback → add_component_logs → preprocess → [compress?] → submit
 *   → repeat until {FLG:...}
 */

import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const AI_DEVS_API_KEY = process.env.AI_DEVS_API_KEY!;

if (!OPENROUTER_API_KEY || !AI_DEVS_API_KEY) {
  throw new Error("Missing required env vars: OPENROUTER_API_KEY, AI_DEVS_API_KEY");
}

const LOG_URL = `https://hub.ag3nts.org/data/${AI_DEVS_API_KEY}/failure.log`;
const VERIFY_URL = "https://hub.ag3nts.org/verify";

/**
 * Conservative token estimate: 3.5 chars per token.
 * Real average for English technical text is ~4, but we overestimate for safety.
 * At 3.5, our 1500-token limit maps to ~5250 chars maximum.
 */
const CHARS_PER_TOKEN = 3.5;
const TARGET_TOKENS = 1350; // Submit target (150-token buffer under hard limit)
const HARD_LIMIT_TOKENS = 1500; // API hard rejection limit

/**
 * Model strategy:
 * - ORCHESTRATOR: claude-3-haiku (cheap, fast, capable for tool-use decisions)
 *   Sees only small metadata JSON payloads, so cost stays low across iterations.
 * - COMPRESSION: gpt-4o-mini (cheapest per-token, good for structured rewrites)
 *   Only called as a last resort after JavaScript preprocessing.
 */
const ORCHESTRATOR_MODEL = "anthropic/claude-3-haiku";
const COMPRESSION_MODEL = "openai/gpt-4o-mini";

const AGENT_LOG_FILE = "agent.log";
const RAW_LOG_FILE = "failure.log";
const CURRENT_LOGS_FILE = "current_logs.txt";

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

function log(level: "INFO" | "TOOL" | "AGENT" | "WARN" | "SUCCESS" | "ERROR", msg: string): void {
  const entry = `[${new Date().toISOString()}] [${level.padEnd(7)}] ${msg}`;
  console.log(entry);
  fs.appendFileSync(AGENT_LOG_FILE, entry + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STATE
// Stateful module variables — tools operate on these directly.
// The orchestrator LLM never sees raw log content; it only sees metadata.
// ─────────────────────────────────────────────────────────────────────────────

let fullLogLines: string[] = [];  // Full downloaded log (never modified)

/**
 * rawWorkingSet: the ORIGINAL (unabbreviated) lines selected for submission.
 * This is the source of truth for deduplication — it always contains full lines
 * with seconds-precision timestamps and untruncated descriptions.
 *
 * currentLogs: the PREPROCESSED version of rawWorkingSet, ready for submission.
 * It contains abbreviated, deduplicated, chronologically sorted lines.
 *
 * Separation is critical: after preprocess_logs abbreviates lines, the
 * dedup check in add_component_logs must compare against raw originals, not
 * abbreviated strings, otherwise it will always think everything is "new".
 */
let rawWorkingSet: string[] = []; // Original lines selected so far
let currentLogs = "";             // Preprocessed lines (for submission)

// ─────────────────────────────────────────────────────────────────────────────
// OPENROUTER CLIENT
// ─────────────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

async function callOpenRouter(
  messages: ChatMessage[],
  tools?: ToolDef[],
  model = ORCHESTRATOR_MODEL
): Promise<any> {
  const body: Record<string, unknown> = { model, messages };
  if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://aidevs.pl",
      "X-Title": "AI Devs 4 S2E3",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool: download_logs
 * Downloads the failure log and caches it. Returns metadata only.
 */
async function toolDownloadLogs(): Promise<string> {
  log("TOOL", `Downloading: ${LOG_URL}`);
  const res = await fetch(LOG_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const raw = await res.text();
  fs.writeFileSync(RAW_LOG_FILE, raw);
  fullLogLines = raw.split("\n").filter((l) => l.trim());

  const approxTokens = estimateTokens(raw);
  log("TOOL", `Cached ${fullLogLines.length} lines (~${approxTokens} tokens)`);

  return JSON.stringify({
    lines: fullLogLines.length,
    approxTokens,
    note: "Use filter_by_severity to extract relevant events.",
  });
}

/**
 * Tool: filter_by_severity
 *
 * Filters cached log by severity levels. Optionally restrict to specific
 * component IDs (useful for targeted feedback-driven additions).
 * REPLACES currentLogs with the filtered result.
 */
function toolFilterBySeverity(levels: string[], componentIds?: string[]): string {
  if (!fullLogLines.length) return JSON.stringify({ error: "Call download_logs first." });

  const patterns = levels.map((l) => `[${l.toUpperCase()}]`);
  log("TOOL", `Filtering: severity=${patterns.join(",")} components=${componentIds?.join(",") ?? "all"}`);

  let filtered = fullLogLines.filter((line) => patterns.some((p) => line.includes(p)));

  if (componentIds?.length) {
    filtered = filtered.filter((line) =>
      componentIds.some((id) => new RegExp(`\\b${id}\\b`, "i").test(line))
    );
  }

  // Store originals as the source-of-truth working set
  rawWorkingSet = filtered;
  currentLogs = filtered.join("\n");
  fs.writeFileSync(CURRENT_LOGS_FILE, currentLogs);

  const approxTokens = estimateTokens(currentLogs);
  log("TOOL", `Filtered: ${filtered.length} lines (~${approxTokens} tokens)`);

  return JSON.stringify({
    found: filtered.length,
    approxTokens,
    fitsInLimit: approxTokens <= HARD_LIMIT_TOKENS,
    preview: filtered.slice(0, 3).join("\n"),
  });
}

/**
 * Tool: add_component_logs
 *
 * Searches fullLogLines for specific component IDs and APPENDS matches to
 * currentLogs (deduplicating). Called after feedback identifies missing components.
 *
 * This is the iterative refinement step from the lesson — feedback drives
 * targeted log expansion rather than re-processing everything.
 */
function toolAddComponentLogs(componentIds: string[], levels?: string[]): string {
  if (!fullLogLines.length) return JSON.stringify({ error: "Call download_logs first." });

  log("TOOL", `Adding components: [${componentIds.join(", ")}] levels=${levels?.join(",") ?? "all"}`);

  // Dedup against rawWorkingSet (ORIGINAL lines), not currentLogs (which may be abbreviated).
  // This is the critical fix: after preprocess_logs abbreviates lines, currentLogs strings
  // no longer match fullLogLines strings, so the old Set check always failed.
  const existingRaw = new Set(rawWorkingSet);
  const levelPatterns = levels?.map((l) => `[${l.toUpperCase()}]`);
  const newLines: string[] = [];

  for (const id of componentIds) {
    const regex = new RegExp(`\\b${id}\\b`, "i");
    const matches = fullLogLines.filter(
      (line) =>
        regex.test(line) &&
        !existingRaw.has(line) &&
        (levelPatterns ? levelPatterns.some((p) => line.includes(p)) : true)
    );
    matches.forEach((l) => existingRaw.add(l));
    newLines.push(...matches);
  }

  if (newLines.length > 0) {
    rawWorkingSet.push(...newLines);
    // Rebuild currentLogs from the updated rawWorkingSet
    currentLogs = rawWorkingSet.join("\n");
    fs.writeFileSync(CURRENT_LOGS_FILE, currentLogs);
  }

  const approxTokens = estimateTokens(rawWorkingSet.join("\n"));
  log("TOOL", `Added ${newLines.length} lines. Working set: ${rawWorkingSet.length} lines (~${approxTokens} tokens)`);

  return JSON.stringify({
    newLinesAdded: newLines.length,
    totalLines: rawWorkingSet.length,
    approxTokens,
    fitsInLimit: approxTokens <= HARD_LIMIT_TOKENS,
    preview: newLines.slice(0, 3).join("\n"),
  });
}

/**
 * Tool: preprocess_logs  ← KEY NEW TOOL
 *
 * Pure JavaScript log normalization — costs nothing, dramatically reduces tokens:
 *   1. Remove seconds from timestamps: [HH:MM:SS] → [HH:MM]  (saves ~3 chars/line)
 *   2. Truncate descriptions to `maxDescChars` characters  (saves ~60% of text)
 *   3. Deduplicate: identical (severity+component+message_prefix) → keep first
 *      occurrence, then next occurrence only after `minGap` entries have passed
 *      (preserves the timeline for recurring failures without flooding)
 *
 * This is a form of "Reflector" from Observational Memory: it compresses the
 * log's information density without losing the critical structure.
 *
 * Typical reduction: 890 lines (30,940 tokens) → ~80 lines (~970 tokens)
 */
function toolPreprocessLogs(maxDescChars = 200, minGap = 20): string {
  if (!rawWorkingSet.length) return JSON.stringify({ error: "No working set. Call filter_by_severity first." });

  // Always process from rawWorkingSet (original lines), not currentLogs.
  // This makes preprocess idempotent: calling it multiple times gives the same result.
  const lines = rawWorkingSet;
  const processed: string[] = [];
  // Map from signature → index of last kept entry
  const lastKept = new Map<string, number>();

  for (const line of lines) {
    // Step 1: Remove seconds from timestamp
    let shortened = line.replace(
      /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\d{2}\]/,
      "[$1]"
    );

    // Step 2: Truncate the description part (everything after COMPONENT_ID)
    // Pattern: [timestamp] [SEVERITY] COMPONENT_ID description...
    shortened = shortened.replace(
      /^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[(?:CRIT|ERRO|WARN|INFO)\] \S+)\s+(.+)$/,
      (_, prefix, desc) => `${prefix} ${desc.slice(0, maxDescChars)}`
    );

    // Step 3: Build deduplication signature from severity + component + first words
    const sigMatch = shortened.match(/\[(CRIT|ERRO|WARN|INFO)\] (\S+)\s*([\w ]{0,40})/);
    const sig = sigMatch
      ? `${sigMatch[1]}:${sigMatch[2]}:${sigMatch[3].trim().toLowerCase()}`
      : shortened.slice(20, 80);

    const last = lastKept.get(sig);
    if (last === undefined || processed.length - last >= minGap) {
      processed.push(shortened);
      lastKept.set(sig, processed.length - 1);
    }
  }

  // Sort chronologically — timestamps are [YYYY-MM-DD HH:MM] so lexicographic = chronological.
  // This ensures correct order when entries from multiple filter/add calls are merged.
  processed.sort((a, b) => {
    const ta = a.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/)?.[1] ?? "";
    const tb = b.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/)?.[1] ?? "";
    return ta.localeCompare(tb);
  });

  const before = estimateTokens(currentLogs);
  currentLogs = processed.join("\n");
  fs.writeFileSync(CURRENT_LOGS_FILE, currentLogs);

  const after = estimateTokens(currentLogs);
  log("TOOL", `Preprocessed: ${lines.length} → ${processed.length} lines (${before} → ~${after} tokens)`);

  return JSON.stringify({
    inputLines: lines.length,
    outputLines: processed.length,
    beforeTokens: before,
    afterTokens: after,
    fitsInLimit: after <= HARD_LIMIT_TOKENS,
    safeToSubmit: after <= TARGET_TOKENS,
    preview: processed.slice(0, 5).join("\n"),
  });
}

/**
 * Tool: count_tokens
 * Returns the current token estimate. Always call before submitting.
 */
function toolCountTokens(): string {
  const approxTokens = estimateTokens(currentLogs);
  return JSON.stringify({
    chars: currentLogs.length,
    approxTokens,
    hardLimit: HARD_LIMIT_TOKENS,
    targetLimit: TARGET_TOKENS,
    fitsInLimit: approxTokens <= HARD_LIMIT_TOKENS,
    safeToSubmit: approxTokens <= TARGET_TOKENS,
  });
}

/**
 * Tool: compress_logs  (LLM-based, last resort)
 *
 * Uses gpt-4o-mini to compress currentLogs to fit within targetTokens.
 * Should only be called AFTER preprocess_logs has already reduced the size.
 * Maps to the "Reflector" in Observational Memory — compresses when volume
 * exceeds threshold, preserving essential structure.
 */
async function toolCompressLogs(targetTokens: number): Promise<string> {
  if (!currentLogs) return JSON.stringify({ error: "No logs to compress." });

  const before = estimateTokens(currentLogs);
  const maxChars = Math.floor(targetTokens * CHARS_PER_TOKEN * 0.9);
  log("TOOL", `LLM-compressing: ~${before} tokens → target ~${targetTokens}`);

  const res = await callOpenRouter(
    [
      {
        role: "system",
        content: `You are a power plant log compression specialist.

TASK: Compress log entries so the TOTAL output fits within ${targetTokens} tokens (~${maxChars} chars).

NON-NEGOTIABLE RULES:
1. Keep ALL unique events — do not silently drop any component
2. REQUIRED format per line: [YYYY-MM-DD HH:MM] [SEVERITY] COMPONENT_ID short-description
3. Abbreviate descriptions to ≤ 40 characters — the ONLY mandatory parts are timestamp, severity, component ID
4. Priority order if forced to cut: CRIT > ERRO > WARN
5. Remove ONLY exact duplicate lines (same timestamp + identical text)
6. Exactly ONE event per line — no blank lines, no headers, no commentary
7. Output ONLY the compressed log lines — nothing else

Example:
[2026-03-20 06:04] [CRIT] ECCS8 outlet temp runaway. Trip.
[2026-03-20 06:11] [WARN] PWR01 input ripple over limit.`,
      },
      { role: "user", content: currentLogs },
    ],
    undefined,
    COMPRESSION_MODEL
  );

  const compressed = (res.choices[0].message.content as string).trim();
  const after = estimateTokens(compressed);

  // Only accept if compression actually reduced the size
  if (after < before) {
    currentLogs = compressed;
    fs.writeFileSync(CURRENT_LOGS_FILE, currentLogs);
    log("TOOL", `LLM-compressed: ${before} → ~${after} tokens`);
  } else {
    log("WARN", `LLM compression made it larger (${before} → ${after}), keeping original`);
  }

  return JSON.stringify({
    beforeTokens: before,
    afterTokens: after < before ? after : before,
    fitsInLimit: Math.min(after, before) <= HARD_LIMIT_TOKENS,
    safeToSubmit: Math.min(after, before) <= TARGET_TOKENS,
    note:
      after > HARD_LIMIT_TOKENS
        ? "Still over limit — try compress_logs again or remove less-critical events"
        : "Within limit — proceed to submit",
  });
}

/**
 * Tool: submit_logs
 * Submits currentLogs to the Central verification API.
 * Returns raw technician feedback or the flag string.
 */
async function toolSubmitLogs(): Promise<string> {
  if (!currentLogs) return JSON.stringify({ error: "No logs to submit." });

  const approxTokens = estimateTokens(currentLogs);
  if (approxTokens > HARD_LIMIT_TOKENS) {
    return JSON.stringify({
      error: `Over hard limit: ~${approxTokens} tokens (max ${HARD_LIMIT_TOKENS}). Compress first.`,
    });
  }

  log("TOOL", `Submitting ~${approxTokens} tokens`);

  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: AI_DEVS_API_KEY,
      task: "failure",
      answer: { logs: currentLogs },
    }),
  });

  const result = await res.json();
  log("TOOL", `Response: ${JSON.stringify(result)}`);

  // Persist submission snapshot for audit
  fs.appendFileSync(
    AGENT_LOG_FILE,
    `\n${"─".repeat(60)}\nSUBMISSION [${new Date().toISOString()}] ~${approxTokens} tokens\n` +
      `RESPONSE: ${JSON.stringify(result)}\n${"─".repeat(60)}\n\n`
  );

  return JSON.stringify(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL SCHEMA DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "download_logs",
      description: "Download the power plant failure log file. Call this ONCE at the start.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "filter_by_severity",
      description:
        'Filter downloaded logs by severity levels and set as working set. Start with CRIT only: ["CRIT"]. ' +
        "Optionally restrict to specific component IDs. REPLACES currentLogs.",
      parameters: {
        type: "object",
        properties: {
          levels: {
            type: "array",
            items: { type: "string", enum: ["CRIT", "ERRO", "WARN", "INFO"] },
            description: 'e.g. ["CRIT"] or ["CRIT","ERRO","WARN"]',
          },
          component_ids: {
            type: "array",
            items: { type: "string" },
            description: "Optional: restrict to these component IDs only",
          },
        },
        required: ["levels"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_component_logs",
      description:
        "Search full log for specific component IDs and APPEND matches to working set. " +
        "Use ONLY after receiving server feedback that lists missing components. " +
        "Optionally filter by severity levels to add only WARN/ERRO for those components.",
      parameters: {
        type: "object",
        properties: {
          component_ids: {
            type: "array",
            items: { type: "string" },
            description: "Component IDs from the feedback, e.g. [\"STMTURB12\", \"WTRPMP\"]",
          },
          levels: {
            type: "array",
            items: { type: "string" },
            description: "Optional: only add entries with these severity levels",
          },
        },
        required: ["component_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "preprocess_logs",
      description:
        "JavaScript-based log normalization (free, no API cost): " +
        "(1) removes seconds from timestamps, (2) truncates descriptions to 60 chars, " +
        "(3) deduplicates repeated events. Call this BEFORE count_tokens and before compress_logs. " +
        "Typical reduction: 890 lines → ~80 lines, 30K tokens → ~900 tokens.",
      parameters: {
        type: "object",
        properties: {
          max_desc_chars: {
            type: "number",
            description: "Max chars to keep in each event description (default: 60)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_tokens",
      description:
        "Count approximate tokens in current working log. ALWAYS call this before submit_logs.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "compress_logs",
      description:
        "LAST RESORT AI compression (gpt-4o-mini). Use ONLY if count_tokens shows fitsInLimit=FALSE. " +
        "WARNING: LLM compression can strip component identifiers — only call if genuinely over 1500 tokens. " +
        "target_tokens should be 1350.",
      parameters: {
        type: "object",
        properties: {
          target_tokens: { type: "number", description: "Target token count (use 1350)" },
        },
        required: ["target_tokens"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_logs",
      description:
        "Submit current working log to Central verification. Returns feedback or flag {FLG:...}. " +
        "ALWAYS verify count_tokens ≤ 1500 first.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "download_logs":
        return await toolDownloadLogs();
      case "filter_by_severity":
        return toolFilterBySeverity(
          (args.levels as string[]) ?? [],
          args.component_ids as string[] | undefined
        );
      case "add_component_logs":
        return toolAddComponentLogs(
          (args.component_ids as string[]) ?? [],
          args.levels as string[] | undefined
        );
      case "preprocess_logs":
        return toolPreprocessLogs(
          typeof args.max_desc_chars === "number" ? args.max_desc_chars : undefined
        );
      case "count_tokens":
        return toolCountTokens();
      case "compress_logs":
        return await toolCompressLogs((args.target_tokens as number) ?? TARGET_TOKENS);
      case "submit_logs":
        return await toolSubmitLogs();
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Tool '${name}' threw: ${msg}`);
    return JSON.stringify({ error: msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a power plant failure log analysis agent.

MISSION: Compress failure logs to ≤ 1500 tokens and submit to Central to get a diagnostic flag {FLG:...}.

═══════════════════════════════════════════════════════
OPTIMAL WORKFLOW (follow this EXACTLY):
═══════════════════════════════════════════════════════

PHASE 1 — Build initial submission:
  1. download_logs
  2. filter_by_severity(["CRIT"])          ← Start with CRIT only
  3. preprocess_logs                       ← JavaScript dedup+abbreviate (free!)
  4. count_tokens                          ← Check size
  5. If safeToSubmit=true: go to step 7
     If NOT safe: filter_by_severity(["CRIT"]) + preprocess_logs(40)  ← shorter descriptions
  6. count_tokens again
  7. submit_logs

PHASE 2 — Iterative improvement from feedback:
  8. Read the response carefully
     → If it contains "{FLG:...}" → DONE! Report the flag.
     → If feedback mentions missing/unclear components:
       a. Extract component IDs from feedback text (e.g. "STMTURB12", "WTRPMP")
       b. add_component_logs(componentIds, ["CRIT","ERRO","WARN"])
       c. preprocess_logs
       d. count_tokens
       e. If NOT safeToSubmit: compress_logs(1350)
       f. submit_logs
       g. Repeat from step 8

═══════════════════════════════════════════════════════
RULES (never violate these):
═══════════════════════════════════════════════════════
• NEVER submit without calling count_tokens first
• NEVER submit if approxTokens > 1500 (hard rejection)
• NEVER call compress_logs if count_tokens shows fitsInLimit=true — compression REMOVES component info
• NEVER call add_component_logs unless server feedback explicitly mentions that component is missing
• preprocess_logs is FREE — use it instead of compress_logs whenever possible
• Log format: [YYYY-MM-DD HH:MM] [SEVERITY] COMPONENT_ID description
• The flag format is {FLG:...} — report it immediately when you see it`;

// ─────────────────────────────────────────────────────────────────────────────
// MAIN AGENT LOOP
// ─────────────────────────────────────────────────────────────────────────────

async function runAgent(): Promise<void> {
  fs.writeFileSync(
    AGENT_LOG_FILE,
    `${"═".repeat(60)}\nPower Plant Failure Log Agent\nStarted: ${new Date().toISOString()}\n${"═".repeat(60)}\n\n`
  );

  log("INFO", "Agent starting");

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        "Start the analysis. Download logs, filter CRIT events, preprocess them (deduplicate + abbreviate), verify token count, and submit. Then iterate based on feedback until you receive the flag.",
    },
  ];

  const MAX_ITERATIONS = 30;
  let flagFound = false;

  for (let iter = 1; iter <= MAX_ITERATIONS && !flagFound; iter++) {
    log("INFO", `── Iteration ${iter}/${MAX_ITERATIONS} ──`);

    const response = await callOpenRouter(messages, AGENT_TOOLS);
    const msg = response.choices[0].message as ChatMessage;
    messages.push(msg);

    if (msg.content) {
      log("AGENT", `Reasoning: ${msg.content}`);
    }

    // Flag in text response
    if (msg.content?.includes("{FLG:")) {
      const m = msg.content.match(/\{FLG:[^}]+\}/);
      if (m) {
        log("SUCCESS", `FLAG: ${m[0]}`);
        console.log(`\n${"═".repeat(50)}\n🎯 FLAG: ${m[0]}\n${"═".repeat(50)}\n`);
        flagFound = true;
        break;
      }
    }

    if (!msg.tool_calls?.length) {
      log("INFO", "Agent done (no more tool calls)");
      break;
    }

    for (const tc of msg.tool_calls) {
      const { name, arguments: argsStr } = tc.function;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(argsStr); } catch { /**/ }

      log("TOOL", `→ ${name}(${JSON.stringify(args)})`);
      const result = await executeTool(name, args);
      log("TOOL", `← ${result.length > 400 ? result.slice(0, 400) + "…" : result}`);

      if (result.includes("{FLG:")) {
        const m = result.match(/\{FLG:[^}]+\}/);
        if (m) {
          log("SUCCESS", `FLAG IN TOOL RESULT: ${m[0]}`);
          console.log(`\n${"═".repeat(50)}\n🎯 FLAG: ${m[0]}\n${"═".repeat(50)}\n`);
          flagFound = true;
        }
      }

      messages.push({ role: "tool", content: result, tool_call_id: tc.id, name });
    }
  }

  if (!flagFound) log("WARN", "Reached max iterations without flag.");
  log("INFO", `Done. Logs: ${AGENT_LOG_FILE} | Current set: ${CURRENT_LOGS_FILE}`);
}

runAgent().catch((e) => { console.error("Fatal:", e); process.exit(1); });
