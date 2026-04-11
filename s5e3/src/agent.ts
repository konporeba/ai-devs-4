import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { executeShellCommand } from "./shellTool";
import { logger } from "./logger";

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL = "google/gemini-2.5-pro-preview";
const MAX_ITERATIONS = 35;

// The flag format returned by the server when the correct answer is submitted
const FLAG_PATTERN = /\{\{FLG:/;

// ─── Tool definition (OpenAI function-calling format) ─────────────────────────

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "executeShellCommand",
      description:
        "Execute a Linux shell command on the remote server and get its stdout. " +
        "Use standard tools: ls, grep, cat, head, tail, wc, sed. " +
        "Max output is 4096 bytes — use head/tail to limit large results.",
      parameters: {
        type: "object",
        properties: {
          cmd: {
            type: "string",
            description: "The shell command to run, e.g. 'ls /data'",
          },
        },
        required: ["cmd"],
      },
    },
  },
];

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a shell investigation agent with access to a remote Linux server at /data.

━━━ YOUR TASK ━━━
You are looking for a person named Rafał. The /data directory contains archive logs.
Your goal:
1. Find the date when Rafał was FOUND (discovered).
2. Determine the city and GPS coordinates of that location.
3. Submit the answer for the day ONE DAY BEFORE he was found.

━━━ EXACT ANSWER FORMAT ━━━
When you have all values, submit with this exact shell command:
  echo '{"date":"YYYY-MM-DD","city":"CityName","longitude":12.345678,"latitude":12.345678}'

Rules for the JSON:
  • "date"      — string, the day BEFORE Rafał was found, format YYYY-MM-DD
  • "city"      — string, the city name
  • "longitude" — number (no quotes), decimal degrees
  • "latitude"  — number (no quotes), decimal degrees
The server returns {{FLG:...}} when the answer is correct.

━━━ DATA LANGUAGE ━━━
All files on the server are in Polish. Event descriptions, field names, and city names
are written in Polish. For example, "znaleziono" means "was found/discovered".
Use grep with Polish keywords when searching log entries.

━━━ HOW TO INVESTIGATE ━━━
Start with: ls /data
Then explore the files systematically:
  • Find which log file records events about Rafał being found
  • Identify the date, location ID, and place ID from that log entry
  • Cross-reference location ID → city name using the locations data file
  • Cross-reference place ID → GPS coordinates using the GPS data file

━━━ SHELL RULES ━━━
• Never guess or assume values — read everything directly from the files
• For large files use line-range access: head -n X /data/file | tail -n Y
  (prefer this over grep -A/-B/-C which can cause server errors on large JSON files)
• Do not repeat the same command twice in a row
• Do not submit until you have confirmed all four values from the files`;

// ─── Agent ────────────────────────────────────────────────────────────────────

export async function runAgent(
  openRouterApiKey: string,
  aiDevsApiKey: string
): Promise<void> {
  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: openRouterApiKey,
  });

  // Conversation history — grows with every iteration
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        "Start by listing the files in /data, then investigate to find where the person of interest " +
        "was the day before they were last seen. Submit your answer as a JSON echo command.",
    },
  ];

  logger.separator("AGENT START");
  logger.info(`Model: ${MODEL} | Max iterations: ${MAX_ITERATIONS}`);

  // Loop-detection: track the last command to prevent identical consecutive calls
  let lastCmd = "";
  let sameCommandCount = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    logger.separator(`ITERATION ${iteration}`);

    // ── 1. Ask the model what to do next ──────────────────────────────────────
    let response: OpenAI.Chat.Completions.ChatCompletion;

    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.1,
      });
    } catch (err) {
      logger.error("LLM API call failed", err);
      throw err;
    }

    const assistantMessage = response.choices[0].message;

    // Log reasoning tokens (Gemini 2.5 exposes thinking in the `reasoning` field)
    const reasoning = (assistantMessage as unknown as Record<string, unknown>).reasoning;
    if (typeof reasoning === "string" && reasoning.trim()) {
      logger.think(reasoning);
    }

    if (assistantMessage.content) {
      logger.agent(assistantMessage.content);
    }

    messages.push(assistantMessage);

    // ── 2. Check if model stopped calling tools ────────────────────────────────
    if (
      !assistantMessage.tool_calls ||
      assistantMessage.tool_calls.length === 0
    ) {
      logger.info("Model stopped calling tools.");
      break;
    }

    // ── 3. Execute each tool call ──────────────────────────────────────────────
    let foundFlag = false;

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.function.name !== "executeShellCommand") {
        logger.error(`Unknown tool called: ${toolCall.function.name}`);
        continue;
      }

      let cmd: string;
      try {
        const args = JSON.parse(toolCall.function.arguments) as { cmd: string };
        cmd = args.cmd;
      } catch (err) {
        logger.error("Failed to parse tool arguments", err);
        cmd = "echo '[agent error: could not parse tool arguments]'";
      }

      // ── Loop detection ────────────────────────────────────────────────────
      if (cmd === lastCmd) {
        sameCommandCount++;
        if (sameCommandCount >= 2) {
          const warning =
            `[LOOP DETECTED] You have called "${cmd}" ${sameCommandCount + 1} times in a row. ` +
            `This command's output will not change. Move to the NEXT step in your plan immediately.`;
          logger.error(warning);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: warning,
          });
          continue;
        }
      } else {
        lastCmd = cmd;
        sameCommandCount = 0;
      }

      // Execute the shell command on the remote server
      const output = await executeShellCommand(cmd, aiDevsApiKey);

      // Check if the server returned a flag (task solved!)
      if (FLAG_PATTERN.test(output) || output.startsWith("FLAG:")) {
        foundFlag = true;
        const flag = output.startsWith("FLAG:") ? output.slice("FLAG:".length).trim() : output;
        logger.final(`FLAG CAPTURED: ${flag}`);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: output,
      });
    }

    if (foundFlag) {
      logger.separator("TASK COMPLETE");
      logger.info("The flag was successfully captured. Agent is shutting down.");
      logger.separator("TASK COMPLETE");
      return;
    }
  }

  logger.separator("AGENT FINISHED");
  logger.info("Completed — iteration limit reached or model stopped early.");
}
