import "dotenv/config";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

// ============================================================
// CONFIGURATION
// ============================================================

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const AI_DEVS_API_KEY   = process.env.AI_DEVS_API_KEY!;
const HUB_URL           = "https://hub.ag3nts.org/verify";
const TASK_NAME         = "railway";

// Model choice matters here. With strict rate limits every LLM call
// that causes an extra API call costs quota. We want a model that:
//   - Understands undocumented APIs from the help text on the FIRST read
//   - Follows a documented sequence without trial-and-error
//   - Does NOT make "exploratory" calls it doesn't need
//
// Claude Sonnet is strong at instruction-following and structured reasoning,
// making it efficient on tasks with a clear documented path to follow.
const MODEL          = "anthropic/claude-sonnet-4-5";
const MAX_ITERATIONS = 25; // Safety ceiling for the agent loop

// ============================================================
// LOGGER
// ============================================================
//
// WHY A FILE LOGGER?
//
// Console output disappears when the terminal closes. With rate-limited,
// long-running agent tasks you NEED a persistent record to:
//
//   1. Debug failures — see exactly which action failed and what error it gave
//   2. Understand rate limit patterns — when are limits hit, how long do resets take?
//   3. Audit the full conversation — LLM reasoning + API calls interleaved
//   4. Resume after interruption — know exactly where execution stopped
//
// DESIGN: Each run creates a SEPARATE timestamped log file (not append-only).
// This lets you compare runs and avoids one huge file that's hard to read.
//
// LEVELS:
//   INFO    — normal flow (calls, responses, state changes)
//   WARN    — recoverable situations (503, rate limit wait)
//   ERROR   — failures (network errors, unexpected responses)
//   SUCCESS — goal achieved (flag found)

class Logger {
  private stream:  fs.WriteStream;
  public  logPath: string;

  constructor() {
    // Timestamp in filename makes each run distinguishable at a glance
    const ts      = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logsDir = path.join(process.cwd(), "logs");

    // Ensure the logs directory exists (creates it if missing)
    fs.mkdirSync(logsDir, { recursive: true });

    this.logPath = path.join(logsDir, `railway_${ts}.log`);

    // WriteStream keeps a file handle open — much more efficient than
    // fs.appendFileSync() on every write (avoids repeated open/close syscalls)
    this.stream = fs.createWriteStream(this.logPath, { flags: "a" });

    this.info("LOGGER", `Session started. Log: ${this.logPath}`);
  }

  private write(level: string, category: string, message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    // Pad strings for aligned columns — much easier to scan in the log file
    const header    = `[${timestamp}] [${level.padEnd(7)}] [${category.padEnd(10)}]`;
    const dataStr   = data !== undefined
      ? "\n" + JSON.stringify(data, null, 2)
      : "";
    const logLine   = `${header} ${message}${dataStr}`;

    // Always write full detail to the file
    this.stream.write(logLine + "\n");

    // Console gets color coding for quick visual scanning
    const colors: Record<string, string> = {
      ERROR:   "\x1b[31m", // red
      WARN:    "\x1b[33m", // yellow
      SUCCESS: "\x1b[32m", // green
      INFO:    "\x1b[36m", // cyan
    };
    const reset = "\x1b[0m";
    const color = colors[level] ?? "";
    console.log(`${color}${logLine}${reset}`);
  }

  info   (cat: string, msg: string, data?: unknown): void { this.write("INFO",    cat, msg, data); }
  warn   (cat: string, msg: string, data?: unknown): void { this.write("WARN",    cat, msg, data); }
  error  (cat: string, msg: string, data?: unknown): void { this.write("ERROR",   cat, msg, data); }
  success(cat: string, msg: string, data?: unknown): void { this.write("SUCCESS", cat, msg, data); }

  // Call close() at the end so the WriteStream flushes its buffer
  close(): void { this.stream.end(); }
}

const log = new Logger();

// ============================================================
// RATE LIMIT TRACKER
// ============================================================
//
// HTTP APIs communicate quota limits through response headers.
// We capture them after EVERY response and use them BEFORE the next request.
//
// Standard header names (RFC 6585 / IETF draft):
//   X-RateLimit-Limit     — total requests allowed in the current window
//   X-RateLimit-Remaining — requests remaining in the current window
//   X-RateLimit-Reset     — Unix timestamp (seconds) when the window resets
//   Retry-After           — seconds to wait before retrying (on 429 or 503)
//
// WHY PRE-CHECK BEFORE EACH CALL?
// If remaining === 0, sending a request anyway will:
//   a) Waste our retry attempt (guaranteed 429/503 response)
//   b) Potentially extend the rate limit window (some APIs do this)
// It's always cheaper to sleep until reset than to trigger another limit.

interface RateLimitInfo {
  limit:     number;
  remaining: number;
  reset:     Date | null; // null means "unknown" — the API didn't send a reset header
}

let rateLimitState: RateLimitInfo = {
  limit:     999, // Assume no limit until we learn otherwise
  remaining: 999,
  reset:     null,
};

function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
  const limit     = parseInt(headers.get("X-RateLimit-Limit")     ?? "999");
  const remaining = parseInt(headers.get("X-RateLimit-Remaining") ?? "999");
  const resetRaw  = headers.get("X-RateLimit-Reset");

  // Reset header is a Unix timestamp in SECONDS → convert to JS Date (milliseconds)
  const reset = resetRaw ? new Date(parseInt(resetRaw) * 1000) : null;

  return { limit, remaining, reset };
}

// ============================================================
// UTILITIES
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// RAILWAY API CALLER (with automatic retry + rate limiting)
// ============================================================
//
// This function is the INFRASTRUCTURE layer. It handles:
//   - Rate limit enforcement (pre-call wait)
//   - 503 retry with exponential backoff
//   - Network error retry
//   - Full logging of every request/response
//
// WHY HIDE THIS FROM THE AGENT?
//
// The LLM agent should only reason about WHAT to call (which action, which params).
// It should not need to reason about HOW to call reliably (timing, retries, headers).
// Mixing these concerns would make the agent's reasoning unfocused and prone
// to "should I wait or retry?" distractions instead of task reasoning.
//
// EXPONENTIAL BACKOFF:
// On 503, we wait: 2s → 4s → 8s → 16s → ... → max 60s
// This is standard practice. The idea: if the server is overloaded,
// hitting it repeatedly makes things worse. Space out your retries.
// "Exponential" means each retry doubles the wait — mathematically,
// this gives the server time to recover without holding you back for too long.

async function callRailwayAPI(
  action:      string,
  extraParams: Record<string, unknown> = {}
): Promise<string> {

  // Build the request body as documented in the task
  const requestBody = {
    apikey: AI_DEVS_API_KEY,
    task:   TASK_NAME,
    answer: { action, ...extraParams },
  };

  log.info("API", `→ action="${action}"`, Object.keys(extraParams).length ? extraParams : undefined);

  const MAX_ATTEMPTS = 12;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

    // ── STEP 1: Pre-call rate limit check ──────────────────────────────
    if (rateLimitState.remaining === 0 && rateLimitState.reset) {
      const waitMs = Math.max(0, rateLimitState.reset.getTime() - Date.now()) + 2000; // +2s safety buffer
      log.warn(
        "RATE_LIMIT",
        `Quota at 0. Waiting ${Math.round(waitMs / 1000)}s until reset ` +
        `(${rateLimitState.reset.toISOString()})`
      );
      await sleep(waitMs);
    }

    // ── STEP 2: HTTP request ───────────────────────────────────────────
    let res: Response;
    try {
      res = await fetch(HUB_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(requestBody),
      });
    } catch (networkErr) {
      // Pure network failure (DNS, connection refused, timeout)
      const msg = (networkErr as Error).message;
      log.error("API", `Network error on attempt ${attempt}/${MAX_ATTEMPTS}: ${msg}`);
      await sleep(Math.min(3000 * attempt, 30000));
      continue;
    }

    // ── STEP 3: Parse rate limit headers from this response ────────────
    const newRateLimit = parseRateLimitHeaders(res.headers);
    rateLimitState     = newRateLimit;
    log.info(
      "RATE_LIMIT",
      `After call: ${newRateLimit.remaining}/${newRateLimit.limit} remaining` +
      (newRateLimit.reset ? `, resets at ${newRateLimit.reset.toISOString()}` : "")
    );

    // ── STEP 4: Handle 503 (intentional overload simulation) ──────────
    if (res.status === 503) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const backoffMs =
        retryAfterHeader
          ? parseInt(retryAfterHeader) * 1000           // Server tells us exactly how long
          : Math.min(2000 * Math.pow(2, attempt - 1), 60_000); // Our own exponential backoff

      log.warn(
        "API",
        `503 on attempt ${attempt}/${MAX_ATTEMPTS}. ` +
        `Backing off ${Math.round(backoffMs / 1000)}s...`
      );
      await sleep(backoffMs);
      continue;
    }

    // ── STEP 5: Parse JSON body ────────────────────────────────────────
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      const rawText = await res.text().catch(() => "(unreadable body)");
      log.error("API", `Non-JSON response (HTTP ${res.status})`, rawText);
      return JSON.stringify({ error: `HTTP ${res.status}`, body: rawText });
    }

    log.info("API", `← HTTP ${res.status}`, data);
    return JSON.stringify(data);
  }

  const exhaustedMsg = `Exhausted ${MAX_ATTEMPTS} attempts for action "${action}"`;
  log.error("API", exhaustedMsg);
  return JSON.stringify({ error: exhaustedMsg });
}

// ============================================================
// OPENROUTER CLIENT
// ============================================================
//
// OpenRouter is a proxy that gives you access to many LLM providers
// (Anthropic, OpenAI, Google, etc.) through a SINGLE OpenAI-compatible API.
//
// The only change vs. vanilla OpenAI client:
//   baseURL → OpenRouter's endpoint instead of api.openai.com
//   apiKey  → your OpenRouter key (not Anthropic key)
//   model   → "provider/model-name" format (e.g., "anthropic/claude-sonnet-4-5")

const client = new OpenAI({
  apiKey:  OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// ============================================================
// TOOL SCHEMA
// ============================================================
//
// Tool descriptions are the agent's "API documentation".
// Write them like a README for a junior developer — precise and unambiguous.
//
// WHY ONLY ONE TOOL?
//
// The railway API is self-documenting. Once the agent calls "help",
// it knows ALL available actions and their parameters. A single
// `call_railway_api` tool is the right level of abstraction:
//   - The agent decides WHAT to call
//   - The infrastructure handles HOW to call it reliably
//
// Adding separate tools per action would require us to know the API in advance,
// which defeats the purpose of the self-documenting design.

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "call_railway_api",
      description: [
        "Calls the Railway activation API with an action and optional parameters.",
        "",
        "ALWAYS start with action='help' — the API is self-documenting.",
        "The help response lists ALL available actions, their parameters, and the required call sequence.",
        "",
        "Rules:",
        "- Use EXACT action names from the help response (case-sensitive)",
        "- Use EXACT parameter names from the help response",
        "- Follow the documented call order — the API enforces sequence",
        "- If a call fails, read the error: it tells you exactly what to fix",
        "",
        "Rate limits and 503 retries are handled automatically — you do not need to manage timing.",
        "Returns the API's JSON response as a string.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          action: {
            type:        "string",
            description: "The action name to call (e.g., 'help', or any action listed in the help response)",
          },
          params: {
            type:                 "object",
            description:          "Additional parameters for the action, as key-value pairs (from the help docs). Omit if the action takes no parameters.",
            additionalProperties: true,
          },
        },
        required: ["action"],
      },
    },
  },
];

// ============================================================
// SYSTEM PROMPT
// ============================================================
//
// DESIGN PHILOSOPHY FOR THIS TASK:
//
// 1. "Exploration agent" pattern — the agent knows its GOAL (activate X-01)
//    but NOT the steps. Steps live in the API documentation. The agent must
//    discover and follow them. This is more robust than hardcoding steps
//    that might change if the API changes.
//
// 2. Minimal prescriptions — we only tell it WHERE to start (help action)
//    and WHAT success looks like ({FLG:...}). Everything else it derives.
//
// 3. Explicit error-reading instruction — LLMs can be optimistic and retry
//    the same action without reading the error. We make error-reading mandatory.
//
// 4. "Rate limits handled automatically" — so the agent doesn't waste tokens
//    reasoning about timing and focuses on the actual task logic.

const SYSTEM_PROMPT = `You are an autonomous agent. Your goal: activate railway route X-01 and find the success flag.

WORKFLOW:
1. Start by calling action="help" to get the full API documentation.
   Read it carefully — it lists every available action, all parameters, and the required call sequence.

2. Follow the documentation EXACTLY:
   - Use exact action names (case-sensitive)
   - Use exact parameter names
   - Respect the sequence order — the API enforces it and will reject out-of-order calls

3. If a call returns an error: READ the error message carefully.
   It will tell you what is wrong (wrong parameter, wrong order, missing field, etc.).
   Fix the specific issue and retry — do not guess.

4. The target route name is: X-01

5. When any response contains a flag in the format {FLG:...} — that is the success signal. Task complete.

IMPORTANT:
- Rate limits and 503 errors are handled automatically — do not try to manage timing yourself.
- Do NOT invent action names or parameters. Only use what the help response specifies.
- Do NOT skip documented steps — the API enforces sequence.`;

// ============================================================
// AGENT LOOP (ReAct pattern)
// ============================================================
//
// ReAct = Reason + Act, the foundational pattern for tool-using agents.
//
// Each iteration:
//   1. LLM receives: system prompt + full conversation history (its "memory")
//   2. LLM reasons (internally, before responding) about its current state
//   3. LLM either:
//      a) Calls a tool → we execute it, append result → loop back
//      b) Gives a final text response → task done or agent is stuck
//
// The CONVERSATION HISTORY is the agent's working memory.
// Every tool call and result accumulates there, so the LLM always has
// the full picture: what it tried, what the API responded, what errors occurred.
//
// This is why the context window size matters for long agent tasks.

async function runAgent(): Promise<void> {
  log.info("AGENT", "=== Railway Activation Agent Started ===");
  log.info("AGENT", `Model: ${MODEL} | Max iterations: ${MAX_ITERATIONS}`);
  console.log(`\n  Log file: ${log.logPath}\n`);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: "Begin. Activate railway route X-01 and find the flag." },
  ];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const separator = "─".repeat(55);
    log.info("AGENT", `${separator}\nIteration ${iteration}/${MAX_ITERATIONS}\n${separator}`);

    // ── Call the LLM ───────────────────────────────────────────────────
    // We pass the FULL message history every time.
    // LLMs are stateless — they don't remember previous calls.
    // The conversation array IS the state.
    const response = await client.chat.completions.create({
      model:       MODEL,
      messages,
      tools:       TOOLS,
      tool_choice: "auto", // Let the model decide: call a tool OR respond in text
    });

    const choice    = response.choices[0];
    const assistant = choice.message;

    // Add the assistant message to history (tool calls or text — either way)
    messages.push(assistant);

    // Log the LLM's text reasoning (if present alongside tool calls)
    if (assistant.content) {
      log.info("LLM", `Reasoning: ${assistant.content}`);
    }

    // ── CASE A: LLM wants to call a tool ──────────────────────────────
    if (choice.finish_reason === "tool_calls" && assistant.tool_calls?.length) {

      for (const toolCall of assistant.tool_calls) {
        const { name, arguments: argsJson } = toolCall.function;
        const args = JSON.parse(argsJson) as { action?: string; params?: Record<string, unknown> };

        log.info("TOOL", `Dispatching: ${name}`, args);

        // Execute the tool
        let result: string;
        if (name === "call_railway_api" && args.action) {
          result = await callRailwayAPI(args.action, args.params ?? {});
        } else {
          result = JSON.stringify({ error: `Unknown tool or missing action: ${name}` });
          log.error("TOOL", `Unexpected tool call: ${name}`);
        }

        // ── Check for success flag BEFORE adding result to history ─────
        // We search the raw result string so we catch the flag regardless
        // of where it appears in the JSON structure.
        const flagMatch = result.match(/\{FLG:[^}]+\}/);
        if (flagMatch) {
          log.success("AGENT", `FLAG FOUND: ${flagMatch[0]}`);
          console.log(`\n${"★".repeat(55)}`);
          console.log(`  SUCCESS!  Flag: ${flagMatch[0]}`);
          console.log(`${"★".repeat(55)}\n`);
          log.close();
          return;
        }

        // Add the tool result to history — LLM sees it in the next iteration
        messages.push({
          role:        "tool",
          tool_call_id: toolCall.id,
          content:     result,
        });
      }

      // Loop back — LLM will process the tool results next
      continue;
    }

    // ── CASE B: LLM gave a text-only response (no tool calls) ─────────
    if (assistant.content) {
      // The flag might be in the final text response too
      const flagMatch = assistant.content.match(/\{FLG:[^}]+\}/);
      if (flagMatch) {
        log.success("AGENT", `FLAG in final response: ${flagMatch[0]}`);
        console.log(`\nFLAG: ${flagMatch[0]}`);
      } else {
        log.warn("AGENT", "Agent gave a final response without calling a tool and without a flag.");
        console.log("\nAgent final response:", assistant.content);
      }
    }

    // Text response ends the loop (agent decided it's done)
    break;
  }

  log.error("AGENT", `Agent did not find the flag within ${MAX_ITERATIONS} iterations.`);
  log.close();
}

// ============================================================
// ENTRY POINT
// ============================================================

runAgent().catch(err => {
  log.error("AGENT", "Fatal unhandled error", (err as Error).message);
  log.close();
  process.exit(1);
});
