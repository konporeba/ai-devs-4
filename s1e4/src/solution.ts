import "dotenv/config";
import OpenAI from "openai";

// ============================================================
// CONFIGURATION
// ============================================================

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const AI_DEVS_API_KEY = process.env.AI_DEVS_API_KEY!;
const HUB_BASE = "https://hub.ag3nts.org";
const DOC_BASE = `${HUB_BASE}/dane/doc`;

// Maximum agent iterations — a critical safety guard.
// Without this, a confused LLM can loop forever calling tools.
const MAX_ITERATIONS = 30;

// ============================================================
// MODELS
// ============================================================
// A true multimodal system uses SPECIALIZED models per modality.
// Routing tasks to the right model improves accuracy and makes
// the architecture explicit — every reader knows what processes what.
//
//   TEXT_MODEL  — orchestrates the agent loop, reads documents, reasons
//                 about rules, builds the declaration.
//                 Claude Sonnet is strong at long-document reasoning
//                 and structured output (following a form template exactly).
//
//   VISION_MODEL — dedicated to image analysis only.
//                  GPT-4o is a different model from a different provider,
//                  making the specialization concrete and visible.
//                  It receives raw image bytes + a question and returns text.
//
// This separation also means you can swap one model without touching the other.

const TEXT_MODEL  = "anthropic/claude-sonnet-4-5";
const VISION_MODEL = "openai/gpt-4o";

// Single OpenRouter client — routes to either model via the `model` parameter.
const client = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// ============================================================
// TOOL IMPLEMENTATIONS
// ============================================================

// --- Tool: fetch_document ---
// Fetches a text/markdown document from the SPK documentation server.
// Returns raw text so the LLM can read and reason about it directly.
//
// Why not pre-process? Because the LLM is better at understanding
// documentation in its natural form than us guessing what matters.

async function fetchDocument(url: string): Promise<string> {
  console.log(`[tool] fetch_document("${url}")`);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return `ERROR: HTTP ${res.status} ${res.statusText} for ${url}`;
    }
    const text = await res.text();
    console.log(`  → ${text.length} chars`);
    return text;
  } catch (err) {
    return `ERROR: ${(err as Error).message}`;
  }
}

// --- Tool: analyze_image ---
// Fetches an image from a URL and uses a vision model to extract
// all readable information from it.
//
// This is the MULTIMODAL component of the agent.
//
// Why a separate tool instead of passing images directly to the main agent?
// Two reasons:
//   1. Separation of concerns: the main agent loop uses text messages;
//      vision calls are isolated here.
//   2. The tool can ask a targeted question about the image, producing
//      a focused text response the agent can reason about.
//
// How vision works in the OpenAI API:
//   Instead of a plain string, the "content" field becomes an array:
//   [
//     { type: "image_url", image_url: { url: "..." } },
//     { type: "text",      text: "What does this show?" }
//   ]
//   The model processes both the image pixels and the text prompt together.

async function analyzeImage(imageUrl: string, question: string): Promise<string> {
  console.log(`[tool] analyze_image("${imageUrl}")`);
  console.log(`  → question: "${question}"`);

  const response = await client.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: imageUrl },
          },
          {
            type: "text",
            text: question,
          },
        ],
      },
    ],
    max_tokens: 2000,
  });

  const result = response.choices[0].message.content ?? "No response";
  console.log(`  → vision result (${result.length} chars):`);
  console.log("  " + result.slice(0, 200).replace(/\n/g, "\n  ") + (result.length > 200 ? "..." : ""));
  return result;
}

// --- Tool: submit_declaration ---
// Sends the completed declaration text to the Hub's /verify endpoint.
// Returns the Hub's full JSON response.
//
// On success: Hub returns { code: 0, message: "{FLG:...}" }
// On failure: Hub returns an error message with hints about what's wrong.
//
// This tool closes the "act → observe" loop: the agent acts (submits),
// then observes the result and decides whether to correct and retry.

async function submitDeclaration(declaration: string): Promise<string> {
  console.log(`[tool] submit_declaration (${declaration.length} chars)`);

  const body = {
    apikey: AI_DEVS_API_KEY,
    task: "sendit",
    answer: { declaration },
  };

  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log(`  → Hub:`, JSON.stringify(data));
  return JSON.stringify(data);
}

// ============================================================
// TOOL SCHEMAS (JSON Schema / OpenAI Function Calling format)
// ============================================================
// These descriptions are the LLM's "API documentation".
// The quality of descriptions directly determines how well the LLM uses tools.
// Think of writing these like writing a README for a junior developer.

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "fetch_document",
      description:
        "Fetches the raw text content of a documentation file from the SPK system. " +
        "Use this to read .md files from the documentation server. " +
        "The base documentation URL is: " + DOC_BASE + "/index.md" +
        "Other files are at the same base path, e.g. " + DOC_BASE + "/zalacznik-E.md",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full URL of the documentation file to fetch",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_image",
      description:
        "Fetches an image from a URL and uses a vision model to extract all readable information. " +
        "Use this for .png, .jpg, or other image files in the documentation. " +
        "IMPORTANT: Some documentation files are images — they contain tables and data " +
        "that cannot be read with fetch_document. Always use this tool for image files.",
      parameters: {
        type: "object",
        properties: {
          imageUrl: {
            type: "string",
            description: "Full URL of the image to analyze",
          },
          question: {
            type: "string",
            description:
              "Specific question to ask about the image, e.g. " +
              "'Extract all route codes and their city connections from this table'",
          },
        },
        required: ["imageUrl", "question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_declaration",
      description:
        "Submits the completed SPK declaration text to the Hub for verification. " +
        "The declaration must be formatted EXACTLY like the template from zalacznik-E.md — " +
        "same separator lines, same field names, same order. " +
        "Returns the Hub's JSON response: success contains a flag {FLG:...}, " +
        "failure contains an error message with hints about what to fix. " +
        "If rejected, read the error carefully and correct the declaration.",
      parameters: {
        type: "object",
        properties: {
          declaration: {
            type: "string",
            description: "The complete declaration text, formatted exactly per the template",
          },
        },
        required: ["declaration"],
      },
    },
  },
];

// ============================================================
// TOOL DISPATCHER
// ============================================================

async function dispatchTool(name: string, argsJson: string): Promise<string> {
  const args = JSON.parse(argsJson);

  switch (name) {
    case "fetch_document":
      return await fetchDocument(args.url);

    case "analyze_image":
      return await analyzeImage(args.imageUrl, args.question);

    case "submit_declaration":
      return await submitDeclaration(args.declaration);

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ============================================================
// SYSTEM PROMPT
// ============================================================
//
// The system prompt defines the agent's persona, goal, and strategy.
//
// KEY DESIGN DECISIONS:
//
// 1. We give the agent TASK PARAMETERS (sender ID, cities, weight, etc.)
//    but NOT the answers. The agent must DERIVE the answers from documentation.
//    This is the "research agent" pattern.
//
// 2. We explicitly tell it about the image file. Without this hint, the agent
//    might try to fetch_document the PNG and get garbage binary data.
//    Good system prompts prevent predictable mistakes.
//
// 3. We enforce the strategy: read docs BEFORE building the form.
//    LLMs can be eager — they might try to submit immediately using guessed values.
//    The system prompt makes the research phase mandatory.
//
// 4. We tell it to read the error and retry. This enables the
//    "act → observe → correct" loop that makes agents resilient.

const SYSTEM_PROMPT = `You are an SPK (System Przesyłek Konduktorskich) declaration agent.

YOUR TASK:
Fill out and submit a transport declaration for the following shipment:
- Sender ID: 450202122
- Origin: Gdańsk
- Destination: Żarnowiec
- Weight: 2800 kg
- Budget: 0 PP (the shipment must be free or paid by the System)
- Contents: kasety z paliwem do reaktora (reactor fuel cassettes)
- Special notes: NONE — do not add any special notes

YOUR STRATEGY:
1. Fetch the main documentation: ${DOC_BASE}/index.md
   Read it carefully to understand the system and find all referenced files.

2. Fetch ALL referenced documentation files to understand:
   - Shipment categories (A–E) and their fees/financing rules
   - Fee calculation formula (which category allows 0 PP for the sender?)
   - WDP field meaning and calculation
   - The declaration form template (look for zalacznik-E.md)

3. For IMAGE files (like .png files), use analyze_image — NOT fetch_document.
   Image files contain important tabular data (like route codes) that you MUST read.
   Always ask the image tool to extract ALL data from the table.

4. Find the correct route code for Gdańsk → Żarnowiec:
   - Check the simplified network map (zalacznik-F.md)
   - Check disabled routes image (trasy-wylaczone.png) — this is critical for the route code

5. Build the declaration using the EXACT template format from zalacznik-E.md.
   Formatting is strictly verified — separator lines, field names, and order must match exactly.

6. Submit the declaration using submit_declaration.
   If the Hub rejects it, read the error message carefully and fix the specific issue, then retry.

IMPORTANT RULES:
- Do NOT guess values — read them from the documentation
- Do NOT add special notes (UWAGI SPECJALNE must be empty)
- The date format is YYYY-MM-DD (today: ${new Date().toISOString().split("T")[0]})
- The documentation base URL is: ${DOC_BASE}/`;

// ============================================================
// AGENT LOOP
// ============================================================
//
// The classic "ReAct" pattern (Reason + Act):
//
//   Loop:
//     1. LLM receives conversation history + available tools
//     2. LLM REASONS about what to do next (internally, before responding)
//     3. LLM ACTS by calling a tool (or gives final answer)
//     4. We execute the tool and append the result to conversation
//     5. Go to 1
//
// Each iteration the LLM has FULL context of everything it has done:
// which docs it read, what it learned, what it submitted, what errors it got.
// This growing context IS the agent's "memory" within a session.
//
// The agent terminates when:
//   a) It gives a text response without tool calls (task done or stuck)
//   b) We detect a flag in a tool result (success)
//   c) MAX_ITERATIONS is reached (safety guard)

async function runAgent(): Promise<void> {
  console.log("=== S01E04: SPK Multimodal Research Agent ===\n");
  console.log("The agent will autonomously:");
  console.log("  1. Read all SPK documentation files");
  console.log("  2. Analyze image files using vision");
  console.log("  3. Build the declaration from what it learns");
  console.log("  4. Submit and correct based on Hub feedback\n");

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "Start the research and submit the SPK declaration." },
  ];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`AGENT ITERATION ${iteration}/${MAX_ITERATIONS}`);
    console.log("=".repeat(60));

    const response = await client.chat.completions.create({
      model: TEXT_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Always record what the LLM said/decided
    messages.push(assistantMessage);

    // Log the LLM's reasoning text (if any)
    if (assistantMessage.content) {
      console.log("\n[LLM thinking]:", assistantMessage.content.slice(0, 400));
    }

    // --- Case 1: LLM wants to call tools ---
    if (choice.finish_reason === "tool_calls" && assistantMessage.tool_calls) {
      for (const toolCall of assistantMessage.tool_calls) {
        const { name, arguments: argsJson } = toolCall.function;

        console.log(`\n[LLM → tool] ${name}`);

        const result = await dispatchTool(name, argsJson);

        // Check for success flag in any tool result
        const flagMatch = result.match(/\{FLG:[^}]+\}/);
        if (flagMatch) {
          console.log(`\n${"★".repeat(50)}`);
          console.log(`SUCCESS! Flag: ${flagMatch[0]}`);
          console.log("★".repeat(50));
          // Still append the result so the LLM sees it, then return
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
          return;
        }

        // Append tool result to conversation — the LLM will see this on next iteration
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // Loop back — LLM will process the tool results and decide next action
      continue;
    }

    // --- Case 2: LLM gave a final text response ---
    if (assistantMessage.content) {
      console.log("\n=== Agent final response ===");
      console.log(assistantMessage.content);
      // Check if the flag is in the final text
      const flagMatch = assistantMessage.content.match(/\{FLG:[^}]+\}/);
      if (flagMatch) {
        console.log(`\nFLAG FOUND: ${flagMatch[0]}`);
      }
    }

    console.log(`\nAgent completed in ${iteration} iteration(s).`);
    return;
  }

  console.error(`\n[ERROR] Agent exceeded ${MAX_ITERATIONS} iterations.`);
}

// ============================================================
// ENTRY POINT
// ============================================================

runAgent().catch(console.error);
