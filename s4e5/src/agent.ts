/**
 * FoodWarehouse Autonomous Agent — S4E5
 *
 * Architecture: Single orchestrator agent with tool-use loop.
 *
 * Why single agent (not multi-agent)?
 * The task is fundamentally sequential with a shared state (order IDs, signatures,
 * city data). Splitting into multiple agents would add coordination overhead without
 * benefit. Instead, we give one capable LLM a rich set of typed tools and let it
 * discover the database schema, plan orders, and execute them autonomously.
 *
 * Agent loop pattern:
 *   1. LLM reasons about the current state (messages history)
 *   2. LLM calls one or more tools
 *   3. Tool results are appended to history
 *   4. Loop repeats until finishTask() is called or MAX_ITERATIONS is reached
 */

import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ─── Environment setup ────────────────────────────────────────────────────────

// Manual .env loading (no dotenv package needed with native Node ESM)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  process.env[key] ??= value;
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const AI_DEVS_API_KEY = process.env.AI_DEVS_API_KEY!;
const CENTRAL_HUB = process.env.CENTRAL_HUB!;         // https://hub.ag3nts.org/verify
const CITIES_NEEDS_URL = process.env.CITIES_NEEDS!;    // https://hub.ag3nts.org/dane/food4cities.json

// Agent model — choose a powerful reasoning model available on OpenRouter
const AGENT_MODEL = 'anthropic/claude-opus-4-6';

// Safety cap on agentic iterations
const MAX_ITERATIONS = 50;

// Log file for inspection
const LOG_FILE = path.join(__dirname, '..', 'agent.log');

// ─── OpenRouter client ────────────────────────────────────────────────────────

const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_API_KEY,
});

// ─── Logging ─────────────────────────────────────────────────────────────────

const logLines: string[] = [];

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  logLines.push(line);
}

function saveLog(): void {
  fs.writeFileSync(LOG_FILE, logLines.join('\n'), 'utf-8');
}

// ─── API helpers ──────────────────────────────────────────────────────────────

/**
 * Generic call to the Central Hub API.
 * Wraps all payload under { apikey, task: "foodwarehouse", answer: payload }.
 */
async function callHubApi(answerPayload: Record<string, unknown>): Promise<unknown> {
  const body = {
    apikey: AI_DEVS_API_KEY,
    task: 'foodwarehouse',
    answer: answerPayload,
  };
  log(`→ POST ${CENTRAL_HUB} | ${JSON.stringify(answerPayload)}`);
  const res = await fetch(CENTRAL_HUB, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  log(`← ${JSON.stringify(data)}`);
  return data;
}

// ─── Tool definitions (schema for the LLM) ───────────────────────────────────

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'fetchCityNeeds',
      description:
        'Fetches the food4cities.json file which lists every city and the exact quantities of items they need. Call this first to understand the scope of the task.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getApiHelp',
      description:
        'Returns the API documentation / help text from the hub. Useful to understand available tools and their exact request formats.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'queryDatabase',
      description:
        'Executes a read-only SQL query (or "show tables") against the remote SQLite database. ' +
        'Use this to explore tables, find city destination codes, and discover user/creator data needed for signatures.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'SQL SELECT statement, or the special string "show tables".',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generateSignature',
      description:
        'Calls the signatureGenerator API (action: "generate") to produce a SHA1 signature. ' +
        'You must supply the user\'s login and birthday (from the database) plus the numeric destination ID. ' +
        'The returned signature string is then passed to createOrder.',
      parameters: {
        type: 'object',
        properties: {
          login: {
            type: 'string',
            description: 'User login from the users table (e.g. "tgajewski").',
          },
          birthday: {
            type: 'string',
            description: 'User birthday in YYYY-MM-DD format from the users table.',
          },
          destination: {
            type: 'number',
            description: 'Numeric destination_id from the destinations table.',
          },
        },
        required: ['login', 'birthday', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getOrders',
      description: 'Retrieves the current list of orders from the hub. Useful to check what has already been created.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createOrder',
      description:
        'Creates a new order for a city. You MUST have a valid signature before calling this. ' +
        'Returns the new order ID which you need for appendItems.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Human-readable title, e.g. "Dostawa dla Warszawy".',
          },
          creatorID: {
            type: 'number',
            description: 'Numeric ID of the creator user from the database.',
          },
          destination: {
            type: 'number',
            description: 'Numeric destination_id from the destinations table.',
          },
          signature: {
            type: 'string',
            description: 'SHA1 signature string produced by generateSignature.',
          },
        },
        required: ['title', 'creatorID', 'destination', 'signature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'appendItems',
      description:
        'Appends items to an existing order in batch mode. ' +
        'Pass ALL items for the order at once to avoid duplicating quantities. ' +
        'If an item already exists in the order its quantity will be incremented, not replaced.',
      parameters: {
        type: 'object',
        properties: {
          orderId: {
            type: 'string',
            description: 'The order ID returned by createOrder.',
          },
          items: {
            type: 'object',
            description: 'Key-value map of item name → quantity. E.g. {"chleb": 45, "woda": 120}',
            additionalProperties: { type: 'number' },
          },
        },
        required: ['orderId', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resetTask',
      description:
        'Resets all orders back to initial state. Use this if you made a mistake and need to start over.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finishTask',
      description:
        'Submits the final "done" verification. Call this ONLY when ALL orders have been created and fully populated. ' +
        'The hub will return a flag if everything is correct.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ─── Tool executor (maps LLM tool names → actual API calls) ──────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {

      case 'fetchCityNeeds': {
        log(`[Tool] fetchCityNeeds → GET ${CITIES_NEEDS_URL}`);
        const res = await fetch(CITIES_NEEDS_URL);
        const data = await res.json();
        return JSON.stringify(data, null, 2);
      }

      case 'getApiHelp': {
        const result = await callHubApi({ tool: 'help' });
        return JSON.stringify(result, null, 2);
      }

      case 'queryDatabase': {
        const result = await callHubApi({ tool: 'database', query: args['query'] });
        return JSON.stringify(result, null, 2);
      }

      case 'generateSignature': {
        // signatureGenerator requires action:"generate", login, birthday, destination
        const result = await callHubApi({
          tool: 'signatureGenerator',
          action: 'generate',
          login: args['login'],
          birthday: args['birthday'],
          destination: args['destination'],
        });
        return JSON.stringify(result, null, 2);
      }

      case 'getOrders': {
        const result = await callHubApi({ tool: 'orders', action: 'get' });
        return JSON.stringify(result, null, 2);
      }

      case 'createOrder': {
        const result = await callHubApi({
          tool: 'orders',
          action: 'create',
          title: args['title'],
          creatorID: args['creatorID'],
          destination: args['destination'],
          signature: args['signature'],
        });
        return JSON.stringify(result, null, 2);
      }

      case 'appendItems': {
        const result = await callHubApi({
          tool: 'orders',
          action: 'append',
          id: args['orderId'],
          items: args['items'],
        });
        return JSON.stringify(result, null, 2);
      }

      case 'resetTask': {
        const result = await callHubApi({ tool: 'reset' });
        return JSON.stringify(result, null, 2);
      }

      case 'finishTask': {
        const result = await callHubApi({ tool: 'done' });
        return JSON.stringify(result, null, 2);
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`[Tool ERROR] ${name}: ${errorMsg}`);
    return JSON.stringify({ error: errorMsg });
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous warehouse management agent completing the "foodwarehouse" task.

## Your goal
Create one order per city listed in food4cities.json, each containing exactly the items and quantities that city needs. Then call finishTask.

## Step-by-step plan
1. Call fetchCityNeeds to get the list of cities and their required items.
2. Call getApiHelp to understand the API (optional but recommended on first run).
3. Call queryDatabase with "show tables" to explore the SQLite database schema.
4. Query the relevant tables to find:
   - The destination code for each city (used in createOrder).
   - The creator user ID (creatorID) you must use when creating orders.
5. For each city:
   a. Pick any active user from the users table (you already have the full list).
   b. Call generateSignature with: login (user's login), birthday (user's birthday YYYY-MM-DD), destination (the numeric destination_id for that city).
   c. The generateSignature response will contain the SHA1 signature string.
   d. Call createOrder with: title, creatorID (the user_id integer), destination (destination_id integer), signature (from step b).
   e. Call appendItems with the order ID and ALL items the city needs in one batch call.
6. After all cities have orders with correct items, call finishTask.

## Important rules
- generateSignature needs: login (string), birthday (YYYY-MM-DD string), destination (number = destination_id).
- createOrder needs: creatorID (number = user_id), destination (number = destination_id), signature (SHA1 string).
- Use batch appendItems (pass all items as a single object) to avoid accidentally adding items twice.
- Do NOT call finishTask until every city has its order fully populated.
- If you make a mistake, call resetTask and start the order creation over.
- You MUST call resetTask before starting if there are already existing orders (the initial seed orders are decoys).

## Think step by step. Explore the database thoroughly before creating any orders.`;

// ─── Main agent loop ──────────────────────────────────────────────────────────

async function runAgent(): Promise<void> {
  log('=== FoodWarehouse Agent — Starting ===');
  log(`Model: ${AGENT_MODEL}`);
  log(`Hub: ${CENTRAL_HUB}`);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'Start the foodwarehouse task now. Explore the data, build all city orders correctly, and finish when done.',
    },
  ];

  let iteration = 0;
  let noToolCallStreak = 0;
  const MAX_NO_TOOL_CALL_STREAK = 3;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    log(`\n━━━ Iteration ${iteration}/${MAX_ITERATIONS} ━━━`);

    // ── Ask the LLM what to do next ─────────────────────────────────────────
    const response = await openrouter.chat.completions.create({
      model: AGENT_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 8192,
    });

    const assistantMessage = response.choices[0].message;

    // Log the LLM's reasoning text (if any)
    if (assistantMessage.content) {
      log(`[Agent reasoning]\n${assistantMessage.content}`);
    }

    // Append assistant message to conversation history
    messages.push(assistantMessage);

    // ── No tool calls → remind the agent to continue ────────────────────────
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      noToolCallStreak++;
      log(`[Agent] No tool calls in this turn (streak: ${noToolCallStreak}/${MAX_NO_TOOL_CALL_STREAK}).`);

      if (noToolCallStreak >= MAX_NO_TOOL_CALL_STREAK) {
        log('[Agent] Too many turns without tool calls — aborting.');
        break;
      }

      messages.push({
        role: 'user',
        content:
          'You have not called finishTask yet. Review your progress, fix any remaining issues with the orders, and continue until all orders are correct and finishTask is called.',
      });
      continue;
    }

    noToolCallStreak = 0;

    // ── Execute each tool call sequentially ──────────────────────────────────
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs: Record<string, unknown>;

      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        toolArgs = {};
      }

      log(`[Tool call] ${toolName}(${JSON.stringify(toolArgs)})`);

      const toolResult = await executeTool(toolName, toolArgs);

      log(`[Tool result] ${toolResult.slice(0, 500)}${toolResult.length > 500 ? '…' : ''}`);

      // Append tool result to conversation history
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      });

      // ── Detect successful completion ────────────────────────────────────────
      if (toolName === 'finishTask') {
        const parsed: unknown = JSON.parse(toolResult);
        log('\n🏁 finishTask called. Response from hub:');
        log(JSON.stringify(parsed, null, 2));

        // Check for a flag in the response (various possible formats)
        if (typeof parsed === 'object' && parsed !== null) {
          const p = parsed as Record<string, unknown>;
          if (p['flag'] || (typeof p['code'] === 'number' && p['code'] === 0)) {
            log('\n✅ TASK COMPLETED SUCCESSFULLY!');
            log(`Flag: ${p['flag'] ?? 'See full response above'}`);
            saveLog();
            return;
          } else {
            log('\n⚠️  finishTask returned without a success flag — orders may need fixing. Continuing...');
            // Do NOT return — let the LLM read the hub response and correct the orders.
          }
        }
      }
    }
  }

  log(`\n⚠️  Reached max iterations (${MAX_ITERATIONS}) without calling finishTask.`);
  saveLog();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

runAgent().catch((err) => {
  log(`[FATAL] ${err instanceof Error ? err.stack : String(err)}`);
  saveLog();
  process.exit(1);
});
