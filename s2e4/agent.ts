/**
 * AI Devs 4 — S02E04: Mailbox Search Agent
 * =========================================
 * Lesson concept: Organizing context for multi-threaded/multi-agent systems.
 *
 * Architecture: Single agent with a ReAct (Reason → Act → Observe) loop.
 *
 * WHY single agent (not multi-agent)?
 * The lesson teaches that multi-agent systems shine when tasks are parallelizable
 * and independent. This task is a sequential investigation:
 *   1. Search for emails by query → get metadata (IDs)
 *   2. Fetch full email content by ID → extract facts
 *   3. Retry if the mailbox hasn't received new emails yet
 *   4. Submit when all three values are found
 * Adding a second agent here would create communication overhead with no benefit.
 * A single agent's tool-calling loop handles all of this elegantly.
 *
 * TOOLS (the "hands" of the agent):
 *   - zmail_api   → Generic wrapper for the zmail mailbox API
 *   - submit_answer → Sends collected data to the /verify endpoint
 */

import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';

// Load .env variables from the current working directory
dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_DEVS_API_KEY = process.env.AI_DEVS_API_KEY;

if (!OPENROUTER_API_KEY || !AI_DEVS_API_KEY) {
  console.error(
    'ERROR: Missing required environment variables: OPENROUTER_API_KEY, AI_DEVS_API_KEY',
  );
  process.exit(1);
}

const ZMAIL_API_URL = 'https://hub.ag3nts.org/api/zmail';
const VERIFY_API_URL = 'https://hub.ag3nts.org/verify';

// The task recommends a cheaper model for this fact-extraction task.
// google/gemini-2.0-flash-001 is reliable on OpenRouter.
// If the newer google/gemini-2.5-flash-preview is available in your region,
// you can substitute it here.
const MODEL = 'google/gemini-2.0-flash-001';

const LOG_FILE = path.join(process.cwd(), 'agent.log');

// Safety cap on the agentic loop to prevent infinite API calls.
// This task should complete well within 20 iterations.
const MAX_ITERATIONS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURED LOGGER
// ─────────────────────────────────────────────────────────────────────────────
// Every event is written as a JSON line to agent.log AND printed to stdout.
// This gives you a full audit trail of the agent's reasoning and tool usage.

type LogLevel =
  | 'INFO'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'LLM'
  | 'ERROR'
  | 'SUCCESS';

function log(level: LogLevel, message: string, data?: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data !== undefined ? { data } : {}),
  };
  // Append to log file (JSONL format — one JSON object per line)
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  // Also print to console for real-time monitoring
  const prefix = `[${entry.timestamp}] [${level.padEnd(11)}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENROUTER CLIENT
// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter is OpenAI-compatible, so we use the official openai SDK
// and just point it at the OpenRouter base URL.

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    // OpenRouter best practice: identify your app for analytics/rate-limit policies
    'HTTP-Referer': 'https://aidevs.pl',
    'X-Title': 'AI Devs 4 S02E04 Mailbox Agent',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL IMPLEMENTATIONS
// These are plain async functions — pure business logic with no LLM coupling.
// They are called by the dispatcher when the LLM requests a tool call.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Low-level wrapper around the zmail API.
 * All tool calls funnel through here so we have one place for error handling
 * and logging of raw HTTP traffic.
 */
async function callZmailApi(body: Record<string, unknown>): Promise<unknown> {
  const payload = { apikey: AI_DEVS_API_KEY, ...body };

  const response = await fetch(ZMAIL_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `zmail HTTP error: ${response.status} ${response.statusText}`,
    );
  }

  return response.json();
}

/**
 * Tool: zmail_api
 * Generic tool that exposes all zmail actions to the agent.
 *
 * Confirmed API actions (from help response):
 *   - help       → lists actions
 *   - getInbox   → paginated thread list (no body)
 *   - getThread  → rowID + messageID list for a thread (no body)
 *   - getMessages→ FULL content of one or more messages (use `ids` param)
 *   - search     → search with Gmail-like `query` string
 *   - reset      → reset rate-limit counter
 *
 * NOTE: "getMail" does NOT exist — use "getMessages" with ids parameter.
 */
async function toolZmailApi(args: {
  action: string;
  query?: string;
  ids?: string | string[] | number | number[];
  threadID?: number;
  page?: number;
  perPage?: number;
}): Promise<string> {
  const apiBody: Record<string, unknown> = { action: args.action };
  if (args.query !== undefined) apiBody.query = args.query;
  if (args.ids !== undefined) apiBody.ids = args.ids;
  if (args.threadID !== undefined) apiBody.threadID = args.threadID;
  if (args.page !== undefined) apiBody.page = args.page;
  if (args.perPage !== undefined) apiBody.perPage = args.perPage;

  const result = await callZmailApi(apiBody);
  return JSON.stringify(result);
}

/**
 * Tool: submit_answer
 * Sends all three collected values to the AI Devs /verify endpoint.
 * Returns the hub's response which may contain the flag or error details.
 */
async function toolSubmitAnswer(args: {
  password: string;
  date: string;
  confirmation_code: string;
}): Promise<string> {
  const payload = {
    apikey: AI_DEVS_API_KEY,
    task: 'mailbox',
    answer: {
      password: args.password,
      date: args.date,
      confirmation_code: args.confirmation_code,
    },
  };

  log('TOOL_CALL', 'Submitting answer to /verify', payload.answer);

  const response = await fetch(VERIFY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  return JSON.stringify(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS (OpenAI / OpenRouter function calling schema)
// ─────────────────────────────────────────────────────────────────────────────
// These descriptions are critical — the LLM reads them to decide which tool
// to call and how to fill in the parameters. Be precise and explicit.

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'zmail_api',
      description: `Call the zmail mailbox API.

AVAILABLE ACTIONS (confirmed from API help):
- action="help"         → Lists all actions with parameters
- action="getInbox"     → Paginated list of email threads. Returns items with rowID, messageID, subject, from, date. NO body.
- action="getThread"    → Get messages in a thread. Param: threadID (number). Returns rowID + messageID list. NO body.
- action="getMessages"  → Fetch FULL email body. Param: ids (rowID number or 32-char messageID hash, or array of them).
- action="search"       → Search with Gmail query. Param: query. Returns items with rowID and messageID. NO body.

⚠️ CRITICAL: "getMail" does NOT exist. To read email content you MUST use action="getMessages" with the ids parameter.
⚠️ CRITICAL: getInbox and search return METADATA ONLY (no body). Always follow up with getMessages to read the actual email.

TWO-STEP READ PATTERN (mandatory):
  Step 1: search (query="from:proton.me") OR getInbox → get list of {rowID, messageID, subject, from}
  Step 2: getMessages (ids=<rowID number>) → get FULL email body

SEARCH OPERATORS (Gmail-style):
  from:proton.me                    → all emails from proton.me domain
  subject:SEC-                      → subject contains ticket prefix
  subject:haslo OR subject:password → Polish or English password subject
  from:proton.me subject:elektrownia → implicit AND`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description:
              'One of: "help", "getInbox", "getThread", "getMessages", "search"',
          },
          query: {
            type: 'string',
            description:
              'Gmail-like search query. Only for action="search". Examples: "from:proton.me", "subject:SEC-"',
          },
          ids: {
            description:
              'For action="getMessages" ONLY. A numeric rowID (e.g. 42) or 32-char messageID hash (e.g. "6624add090a5cb06f5c192653b5a243c"), or an array of them.',
          },
          threadID: {
            type: 'number',
            description:
              'For action="getThread" only. Numeric thread ID from getInbox.',
          },
          page: {
            type: 'number',
            description: 'Page number for getInbox or search (starts at 1).',
          },
          perPage: {
            type: 'number',
            description:
              'Results per page for getInbox or search (5-20, default 5).',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_answer',
      description: `Submit the three collected values to the answer verification endpoint.
Call this ONLY when you have confirmed ALL THREE values from the email content:
  - password:          the employee system password (found in an email body)
  - date:              attack date in YYYY-MM-DD format (found in an email body)
  - confirmation_code: security ticket code starting with "SEC-" (36 chars total: "SEC-" + 32 chars)

The hub will return a flag {FLG:...} on success, or tell you which values are wrong.
If wrong, continue searching with the corrected understanding.`,
      parameters: {
        type: 'object',
        properties: {
          password: {
            type: 'string',
            description: 'The employee system password found in an email body',
          },
          date: {
            type: 'string',
            description:
              'Date of the planned attack in YYYY-MM-DD format (e.g. 2026-03-15)',
          },
          confirmation_code: {
            type: 'string',
            description:
              'Security ticket confirmation code. Format: "SEC-" followed by exactly 32 alphanumeric characters (36 chars total)',
          },
        },
        required: ['password', 'date', 'confirmation_code'],
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────
// Routes LLM tool requests to the correct implementation function.
// Keeps the agent loop clean by centralizing all tool execution here.

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'zmail_api':
      return toolZmailApi(args as Parameters<typeof toolZmailApi>[0]);

    case 'submit_answer':
      return toolSubmitAnswer(args as Parameters<typeof toolSubmitAnswer>[0]);

    default:
      return JSON.stringify({ error: `Unknown tool requested: "${name}"` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
// This is the "brain" configuration of the agent. It tells the LLM its role,
// what it's looking for, and how to approach the problem systematically.
// A well-written system prompt is as important as the code itself.

const SYSTEM_PROMPT = `You are a methodical email investigation agent. Your mission is to search an operator's mailbox and extract exactly three pieces of information:

1. **date**              – When the security department plans to attack our power plant (format: YYYY-MM-DD)
2. **password**          – The password to the employee system (shared via email)
3. **confirmation_code** – A security ticket code starting with "SEC-" (total 36 chars: "SEC-" + 32 alphanumeric characters)

## Key facts you know:
- Viktor (a resistance informant who betrayed us) sent an email FROM the proton.me domain.
- The API uses Gmail-like search operators: from:, to:, subject:, OR, AND
- The mailbox is LIVE — new emails can arrive at any time. If something is missing, retry.

## ⚠️ CRITICAL API USAGE RULES:
- "getMail" does NOT exist as an API action. NEVER call getMail.
- To read full email content: use action="getMessages" with parameter ids=<rowID number>
- getInbox and search return METADATA ONLY (subject, sender, rowID) — NOT the body.
- You MUST call getMessages after search/getInbox to get the actual email text.

## Correct two-step read pattern:
  Step 1: zmail_api(action="search", query="from:proton.me") → returns list with rowID numbers
  Step 2: zmail_api(action="getMessages", ids=<rowID number from step 1>) → returns full body

## Search strategy:
1. Search for Viktor's email: action="search", query="from:proton.me"
   → Read each result with getMessages(ids=rowID)
2. Search for security tickets: action="search", query="subject:SEC-"
   → Read each result with getMessages(ids=rowID)
3. Search for password emails: action="search", query="subject:haslo OR subject:password"
   → Read each result with getMessages(ids=rowID)
4. If values are missing, browse getInbox page by page and read suspicious emails
5. Once you have ALL THREE values from actual email bodies, call submit_answer
6. If hub rejects a value, re-examine emails and resubmit with correction

## Important rules:
- Be systematic: don't give up after one failed search.
- The password may be in a different email than Viktor's — check all relevant emails.
- Dates in emails may be in various formats — convert to YYYY-MM-DD before submitting.
- The confirmation_code MUST start with "SEC-" and be exactly 36 characters total.
- Always use numeric rowID (not the messageID hash) when calling getMessages.`;

// ─────────────────────────────────────────────────────────────────────────────
// AGENT LOOP
// ─────────────────────────────────────────────────────────────────────────────
// This is the core ReAct (Reason + Act) pattern:
//   1. LLM receives context and reasons about what to do next
//   2. LLM emits tool_calls (the "act" step)
//   3. We execute the tools and add results to the message history
//   4. LLM observes the results and reasons again
//   5. Repeat until the agent calls submit_answer with a valid flag response
//
// The message history IS the agent's working memory within this session.
// Each tool result becomes part of the context for future reasoning.

async function runAgent(): Promise<void> {
  log('INFO', '=== MAILBOX SEARCH AGENT STARTED ===', { model: MODEL });

  // Initialize conversation with system prompt and the user's task
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Search the mailbox and find all three pieces of information:
1. date — when the security department plans to attack our power plant (YYYY-MM-DD)
2. password — the employee system password
3. confirmation_code — the security ticket code (SEC- + 32 chars)

Start by calling zmail_api with action="help" to see all available API actions, then search systematically.`,
    },
  ];

  let iteration = 0;
  let missionAccomplished = false;

  // ── Main agentic loop ──────────────────────────────────────────────────────
  while (!missionAccomplished && iteration < MAX_ITERATIONS) {
    iteration++;
    log('INFO', `─── Iteration ${iteration}/${MAX_ITERATIONS} ───`);

    // ── Step 1: Call the LLM ─────────────────────────────────────────────────
    let response: OpenAI.Chat.ChatCompletion;
    try {
      log('LLM', 'Sending request to LLM', {
        model: MODEL,
        messageCount: messages.length,
      });

      response = await openai.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: 'auto', // Let the model decide when to use tools
        temperature: 0.1, // Low temp = more deterministic, better for fact extraction
        max_tokens: 4096,
      });
    } catch (err) {
      log('ERROR', 'LLM API call failed', { error: String(err) });
      throw err;
    }

    const assistantMessage = response.choices[0].message;
    const finishReason = response.choices[0].finish_reason;

    log('LLM', 'LLM responded', {
      finishReason,
      hasContent: !!assistantMessage.content,
      toolCallCount: assistantMessage.tool_calls?.length ?? 0,
      content: assistantMessage.content?.slice(0, 200), // Preview of reasoning
    });

    // Add assistant's full response (including any tool calls) to history
    messages.push(assistantMessage);

    // ── Step 2: Handle the response ──────────────────────────────────────────
    if (
      !assistantMessage.tool_calls ||
      assistantMessage.tool_calls.length === 0
    ) {
      // No tool calls = the model gave a final text response
      log('INFO', 'Agent finished with text response (no more tool calls)', {
        content: assistantMessage.content,
      });
      missionAccomplished = true;
      break;
    }

    // ── Step 3: Execute each requested tool call ──────────────────────────────
    // NOTE: In a multi-agent system, this is where we might `delegate` to
    // sub-agents. Here, we execute all tools directly and sequentially.
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs: Record<string, unknown>;

      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        log('ERROR', `Failed to parse tool arguments for ${toolName}`, {
          raw: toolCall.function.arguments,
        });
        toolArgs = {};
      }

      log('TOOL_CALL', `→ ${toolName}`, toolArgs);

      let toolResult: string;
      try {
        toolResult = await dispatchTool(toolName, toolArgs);
      } catch (err) {
        // Return the error as the tool result so the agent can adapt
        toolResult = JSON.stringify({ error: String(err) });
        log('ERROR', `Tool "${toolName}" threw an error`, {
          error: String(err),
        });
      }

      // Parse for logging (don't crash if not valid JSON)
      let parsedResult: unknown = toolResult;
      try {
        parsedResult = JSON.parse(toolResult);
      } catch {
        /* keep as string */
      }

      log('TOOL_RESULT', `← ${toolName}`, parsedResult);

      // Add the tool result to the conversation history
      // The LLM will see this as the "observation" step in the ReAct loop
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      });

      // ── Check for mission success after submit_answer ─────────────────────
      if (toolName === 'submit_answer') {
        let result: Record<string, unknown> = {};
        try {
          result = JSON.parse(toolResult) as Record<string, unknown>;
        } catch {
          /* ignore */
        }

        // The hub returns a flag in the message when all values are correct
        const resultStr = JSON.stringify(result).toLowerCase();
        const hasFlag =
          resultStr.includes('flg:') ||
          resultStr.includes('{flg') ||
          (typeof result.message === 'string' &&
            result.message.toLowerCase().includes('flg'));

        if (hasFlag) {
          log('SUCCESS', 'FLAG RECEIVED! Mission accomplished!', result);
          console.log('\n╔══════════════════════════════════╗');
          console.log('║      SUCCESS — FLAG RECEIVED!     ║');
          console.log('╚══════════════════════════════════╝');
          console.log(JSON.stringify(result, null, 2));
          missionAccomplished = true;
          // Don't break inner loop — let all tool results be added, then exit outer
        } else {
          log(
            'INFO',
            'Submit answer response received (not a success flag yet)',
            result,
          );
        }
      }
    }
  }

  // ── Post-loop reporting ───────────────────────────────────────────────────
  if (!missionAccomplished) {
    log('ERROR', `Max iterations (${MAX_ITERATIONS}) reached without a flag`, {
      finalMessageCount: messages.length,
    });
    console.log(
      `\nMax iterations reached. Check agent.log for the full trace.`,
    );
  }

  log('INFO', '=== AGENT LOOP COMPLETE ===', {
    iterations: iteration,
    success: missionAccomplished,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Start fresh log file on each run (overwrite previous)
  fs.writeFileSync(LOG_FILE, '');
  console.log(`Logging to: ${LOG_FILE}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Max iterations: ${MAX_ITERATIONS}\n`);

  try {
    await runAgent();
  } catch (err) {
    log('ERROR', 'Fatal unhandled error', { error: String(err) });
    console.error('\nFatal error:', err);
    process.exit(1);
  }
}

main();
