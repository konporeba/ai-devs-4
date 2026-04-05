/**
 * AI Devs 4 – S02E01 – Categorize Task
 * ======================================
 * Architecture: Single Orchestrator Agent with Tool Use
 *
 * An LLM (Claude Sonnet via OpenRouter) acts as an autonomous "prompt engineer".
 * It is given four tools that model the real-world actions it can take:
 *
 *   fetchCSV       – download fresh item data from the hub
 *   classifyItem   – send a prompt+item to the hub, receive DNG/NEU
 *   resetBudget    – reset the token budget counter on the hub
 *   runFullCycle   – convenience: reset → fetchCSV → classify all 10 items
 *
 * The agent runs in a loop, calling runFullCycle, reading the results,
 * and iterating on its classification prompt until all 10 items pass
 * and the hub returns the {FLG:...} flag.
 *
 * Lesson concepts applied:
 *  • Agentic loop        – agent retries autonomously based on tool feedback
 *  • Context as signal   – full hub error messages go back into the context
 *  • Prompt caching      – static instruction prefix first; variable data last
 *  • Token budget        – the prompt must stay ≤ 100 tokens per item
 */

import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// ─── Configuration ────────────────────────────────────────────────────────────

dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const AI_DEVS_API_KEY = process.env.AI_DEVS_API_KEY!;
const HUB_BASE = "https://hub.ag3nts.org";
const LOG_FILE = path.join(
  process.cwd(),
  `categorize_${new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "_")
    .slice(0, 15)}.log`
);

// ─── Logger ───────────────────────────────────────────────────────────────────

/**
 * Dual-sink logger: writes to stdout AND a timestamped log file.
 * The log file lets you inspect every request/response after the run.
 */
const log = (...args: unknown[]) => {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
};

// ─── OpenRouter client (OpenAI-compatible) ────────────────────────────────────

/**
 * OpenRouter exposes an OpenAI-compatible endpoint.
 * We set the base URL and pass OPENROUTER_API_KEY as the bearer token.
 * The model is Claude Sonnet 4.6 – the recommended "prompt engineer" model.
 */
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://aidevs.pl",
    "X-Title": "AI Devs 4 - categorize",
  },
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface CsvItem {
  id: string;
  description: string;
}

interface HubResponse {
  code: number;
  message: string;
  note?: string;
  flag?: string;
}

interface ClassificationResult {
  id: string;
  description: string;
  hubResponse: HubResponse;
}

interface FullCycleResult {
  results: ClassificationResult[];
  flag: string | null;
  error: string | null;
}

// ─── Tool implementations ─────────────────────────────────────────────────────

/**
 * fetchCSV: Downloads the always-fresh CSV from the hub.
 * The file changes every few minutes, so we always fetch before a new attempt.
 */
async function fetchCSV(): Promise<CsvItem[]> {
  const url = `${HUB_BASE}/data/${AI_DEVS_API_KEY}/categorize.csv`;
  log(`[fetchCSV] GET ${url}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchCSV failed: ${res.status} ${res.statusText}`);

  const text = await res.text();
  log(`[fetchCSV] Received ${text.split("\n").length - 1} lines`);

  // Parse CSV: skip header, split on first comma only (description may contain commas)
  const lines = text.trim().split("\n").slice(1);
  return lines
    .filter((l) => l.trim())
    .map((line) => {
      const commaIdx = line.indexOf(",");
      return {
        id: line.slice(0, commaIdx).trim(),
        description: line.slice(commaIdx + 1).trim(),
      };
    });
}

/**
 * classifyItem: Sends a single item through the hub's archaic 100-token classifier.
 *
 * The hub accepts our prompt template and substitutes {id} and {description}.
 * It returns DNG (dangerous) or NEU (neutral) plus metadata.
 *
 * Design note: variable data ({id}, {description}) should come LAST in the prompt
 * so the static instruction prefix can be cached by the hub's internal model.
 */
async function classifyItem(
  promptTemplate: string,
  item: CsvItem
): Promise<ClassificationResult> {
  log(`[classify] Item ${item.id}: "${item.description.slice(0, 60)}..."`);

  // The hub checks that the actual item ID (e.g. "i7145") appears literally
  // in the prompt text — it cannot find a {id} placeholder.
  // We must materialise the prompt before sending.
  const materialisedPrompt = promptTemplate
    .replace("{id}", item.id)
    .replace("{description}", item.description);

  const body = {
    apikey: AI_DEVS_API_KEY,
    task: "categorize",
    answer: {
      prompt: materialisedPrompt,
    },
  };

  log(`[classify] Sending materialised: "${materialisedPrompt}"`);

  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json() as HubResponse;
  log(`[classify] Hub response for ${item.id}: ${JSON.stringify(json)}`);

  return { id: item.id, description: item.description, hubResponse: json };
}

/**
 * resetBudget: Resets the token budget counter on the hub.
 * Must be called before every new attempt to avoid budget exhaustion.
 */
async function resetBudget(): Promise<HubResponse> {
  log("[reset] Sending reset signal to hub");
  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: AI_DEVS_API_KEY,
      task: "categorize",
      answer: { prompt: "reset" },
    }),
  });
  const json = await res.json() as HubResponse;
  log(`[reset] Hub response: ${JSON.stringify(json)}`);
  return json;
}

/**
 * runFullCycle: The agent's main tool for one complete attempt.
 * Orchestrates: reset → fetchCSV → classify all 10 items sequentially.
 *
 * Returns all classification results plus the flag if all 10 pass.
 * The agent calls this tool, reads the results, and decides whether to iterate.
 */
async function runFullCycle(promptTemplate: string): Promise<FullCycleResult> {
  log(`\n${"=".repeat(60)}`);
  log(`[cycle] Starting full cycle with prompt: "${promptTemplate}"`);

  // Step 1: Reset budget counter
  await resetBudget();

  // Step 2: Fetch fresh CSV (content changes every few minutes)
  let items: CsvItem[];
  try {
    items = await fetchCSV();
  } catch (err) {
    return { results: [], flag: null, error: String(err) };
  }
  log(`[cycle] Loaded ${items.length} items`);

  // Step 3: Classify each item sequentially (hub processes one prompt at a time)
  const results: ClassificationResult[] = [];
  let flag: string | null = null;

  for (const item of items) {
    const result = await classifyItem(promptTemplate, item);
    results.push(result);

    // Check for flag in any response (hub returns flag when all items pass)
    if (result.hubResponse.flag) {
      flag = result.hubResponse.flag;
      log(`[cycle] FLAG FOUND: ${flag}`);
      break;
    }

    // Check for hard failure modes that require immediate abort
    if (result.hubResponse.message?.toLowerCase().includes("budget")) {
      log("[cycle] Budget exhausted — aborting cycle early");
      return {
        results,
        flag: null,
        error: `Budget exhausted after item ${item.id}: ${result.hubResponse.message}`,
      };
    }
  }

  const summary = results
    .map(
      (r) =>
        `  ${r.id}: ${r.hubResponse.message ?? "?"} | ${r.hubResponse.note ?? ""}`
    )
    .join("\n");

  log(`[cycle] Results summary:\n${summary}`);

  return { results, flag, error: null };
}

// ─── Tool schemas for the OpenAI function-calling API ─────────────────────────

/**
 * These JSON Schema descriptions are what the LLM sees when deciding which
 * tool to call. Clear, specific descriptions reduce hallucination and guide
 * the agent toward correct tool usage.
 */
const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "runFullCycle",
      description:
        "Run a complete classification attempt: reset budget → fetch fresh CSV → classify all 10 items with the given prompt template. " +
        "Returns per-item hub responses AND the flag if all items are classified correctly. " +
        "Call this tool with each new prompt candidate. " +
        "The prompt template MUST use {id} and {description} placeholders and MUST be ≤ 100 tokens total including the item data.",
      parameters: {
        type: "object",
        properties: {
          promptTemplate: {
            type: "string",
            description:
              "The classification prompt template. MUST contain {id} and {description} placeholders. " +
              "Static instruction should come FIRST (enables caching), variable data LAST. " +
              "Reactor/nuclear parts MUST always be classified NEU even if they sound dangerous. " +
              "Keep total token count (instruction + item data) ≤ 100 tokens.",
          },
        },
        required: ["promptTemplate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetchCSV",
      description:
        "Download the current list of 10 items from the hub without running classifications. " +
        "Use this to inspect item descriptions before crafting a prompt.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "resetBudget",
      description: "Reset the token budget counter on the hub. Call before starting a new attempt.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

/**
 * Maps tool call names to their implementations.
 * This pattern cleanly separates tool routing from tool logic.
 */
async function dispatchTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "runFullCycle":
      return runFullCycle(args.promptTemplate as string);
    case "fetchCSV":
      return fetchCSV();
    case "resetBudget":
      return resetBudget();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Agent orchestrator ───────────────────────────────────────────────────────

/**
 * The main agentic loop.
 *
 * This is where the lesson concept of "agentic loop" is most visible:
 *  1. We send an initial message to the LLM with the system prompt
 *  2. The LLM calls a tool (runFullCycle with an initial prompt candidate)
 *  3. We execute the tool and return the result
 *  4. The LLM reads the result, sees which items failed, and refines the prompt
 *  5. Repeat until the flag is obtained or max iterations is reached
 *
 * Context is maintained across all iterations in the `messages` array —
 * this is the "conversation history" that gives the agent memory of past attempts.
 */
async function runAgent(): Promise<void> {
  log("=".repeat(60));
  log("AI Devs 4 – S02E01 – Categorize Agent starting");
  log(`Log file: ${LOG_FILE}`);

  // System prompt: gives the agent its role, constraints, and strategy
  // This is the "map" described in the lesson — high-level orientation,
  // not low-level specifics that would just be noise.
  const systemPrompt = `You are a prompt engineering agent solving the "categorize" task from AI Devs 4.

TASK:
You must create a classification prompt that correctly classifies 10 items as DNG (dangerous) or NEU (neutral).
The hub passes your prompt to an internal archaic model with a 100-token context window.
Your prompt + the item data must total ≤ 100 tokens.

CRITICAL RULES:
1. ALL reactor/nuclear-related items (reactor cassettes, nuclear parts, reactor components) MUST be classified as NEU (neutral), even if they sound dangerous. This is intentional — we want to avoid inspection.
2. Truly dangerous items (explosives, weapons, hazardous chemicals, poisons, etc.) MUST be classified as DNG.
3. Safe, neutral items MUST be classified as NEU.

PROMPT STRUCTURE (for caching efficiency):
- Put STATIC instruction text FIRST (this gets cached by the internal model)
- Put {id} and {description} placeholders LAST
- Keep it short — under 100 tokens including the item description

STRATEGY:
1. First call fetchCSV to see what items you're dealing with.
2. Craft a concise English prompt that handles the reactor exception.
3. Call runFullCycle with your prompt. Read every item's hub response carefully.
4. If items failed, analyze WHY and refine the prompt.
5. Repeat until you receive a flag.

GOOD STARTING PROMPT EXAMPLE (adapt as needed):
"Classify as DNG or NEU. Reactor/nuclear parts=NEU always. Dangerous items=DNG, safe items=NEU. Item {id}: {description}"

When you receive the flag, output it clearly as: FLAG: {the flag value}`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content:
        "Start by fetching the CSV to understand what items we're dealing with. Then craft a classification prompt and run the full cycle. Keep iterating until you get the flag.",
    },
  ];

  const MAX_ITERATIONS = 15; // Safety limit to prevent runaway loops
  let iteration = 0;
  let finalFlag: string | null = null;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    log(`\n--- Agent iteration ${iteration} ---`);

    // Call the LLM — it will decide which tool to call next
    const response = await client.chat.completions.create({
      model: "anthropic/claude-sonnet-4-6",
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 2048,
      temperature: 0, // Deterministic: we want consistent prompt engineering decisions
    });

    const choice = response.choices[0];
    log(`[agent] Stop reason: ${choice.finish_reason}`);

    // Push the assistant's message into history (maintains conversation context)
    messages.push(choice.message);

    // If the model has no more tool calls, it's done (or stuck)
    if (choice.finish_reason === "stop" || !choice.message.tool_calls?.length) {
      const content = choice.message.content ?? "";
      log(`[agent] Final message: ${content}`);

      // Extract flag from the final message if present
      const flagMatch = content.match(/FLAG:\s*(\{FLG:[^}]+\}|FLG:[^\s]+)/i);
      if (flagMatch) {
        finalFlag = flagMatch[1];
      }
      break;
    }

    // Process each tool call the LLM requested
    for (const toolCall of choice.message.tool_calls ?? []) {
      // The OpenAI SDK represents tool calls as a union; we narrow to the standard function call shape
      const tc = toolCall as { id: string; function: { name: string; arguments: string } };
      const toolName = tc.function.name;
      const toolArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;

      log(`[tool] Calling ${toolName} with args: ${JSON.stringify(toolArgs)}`);

      let toolResult: unknown;
      try {
        toolResult = await dispatchTool(toolName, toolArgs);
      } catch (err) {
        toolResult = { error: String(err) };
        log(`[tool] Error in ${toolName}: ${err}`);
      }

      const resultStr = JSON.stringify(toolResult);
      log(`[tool] ${toolName} returned: ${resultStr.slice(0, 500)}${resultStr.length > 500 ? "..." : ""}`);

      // Check if flag was obtained from a tool result (runFullCycle returns it directly)
      const cycleResult = toolResult as FullCycleResult;
      if (cycleResult?.flag) {
        finalFlag = cycleResult.flag;
        log(`\n${"*".repeat(60)}`);
        log(`SUCCESS! Flag obtained: ${finalFlag}`);
        log(`${"*".repeat(60)}\n`);
      }

      // Return tool result to the LLM — this is how it "sees" what happened
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: resultStr,
      });
    }

    // If we already have the flag, no need to continue
    if (finalFlag) {
      log("[agent] Flag acquired — stopping loop");
      break;
    }
  }

  if (finalFlag) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`TASK COMPLETE! Flag: ${finalFlag}`);
    console.log(`${"=".repeat(60)}\n`);
  } else {
    log(`[agent] Max iterations (${MAX_ITERATIONS}) reached without obtaining flag`);
    console.log("\nMax iterations reached. Check the log file for details.");
  }

  log(`\nLog saved to: ${LOG_FILE}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

runAgent().catch((err) => {
  log(`[FATAL] ${err}`);
  process.exit(1);
});
