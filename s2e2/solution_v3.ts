/**
 * ============================================================
 * AI Devs 4 - S2E2: Electricity Puzzle Solver (v3 — Tool-Based Agent)
 * ============================================================
 *
 * THE CORE DIFFERENCE FROM v1/v2:
 * ─────────────────────────────────────────────────────────
 *  v1/v2: TypeScript decides what to do, calls LLM as a sub-function.
 *     LLM role: "what edges does this cell image have?" (passive)
 *
 *  v3: LLM decides what to do, calls TypeScript functions as tools.
 *     LLM role: plans rotations, drives the whole sequence (active)
 *
 * HOW A TOOL-BASED AGENT WORKS:
 * ─────────────────────────────────────────────────────────
 *  1. LLM receives: a goal in the system prompt + a list of tool schemas
 *  2. LLM decides: which tool to call and with what arguments
 *  3. TypeScript: executes the tool, returns a result string
 *  4. Result: appended to message history as a "tool" role message
 *  5. LLM: reads the result, reasons about next step, calls another tool
 *  6. Repeat until LLM says it's done (no more tool_calls in response)
 *
 * This loop is the AGENT. TypeScript is just the executor.
 *
 * WHAT THE LLM DOES (that TypeScript did in v2):
 * ─────────────────────────────────────────────────────────
 *  - Compares read_board() output with the target topology
 *  - Reasons about how many CW rotations each cell needs
 *  - Decides the order of rotate_cell() calls
 *  - Adapts if something goes wrong (calls read_board again)
 *  - Decides when the task is complete
 *
 * TOOLS AVAILABLE TO THE ORCHESTRATOR:
 * ─────────────────────────────────────────────────────────
 *  reset_board()     → resets puzzle to initial state
 *  read_board()      → downloads board + VisionAgent analysis → topology JSON
 *  rotate_cell(cell) → sends one 90° CW rotation to hub, returns response
 *
 * AGENT HIERARCHY:
 * ─────────────────────────────────────────────────────────
 *  OrchestratorAgent  ← LLM in a loop (google/gemini-2.5-flash)
 *    ├── tool: reset_board  → HubClient.resetBoard()
 *    ├── tool: read_board   → HubClient.download() + VisionAgent.analyzeBoard()
 *    │                           └── jimp crop + vision LLM per cell
 *    └── tool: rotate_cell → HubClient.rotateCell() → may return {FLG:...}
 */

import * as fs from 'fs';
import { Jimp } from 'jimp';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================
// Configuration
// ============================================================

const CONFIG = {
  aiDevsApiKey:  process.env.AI_DEVS_API_KEY  ?? '',
  openrouterKey: process.env.OPENROUTER_API_KEY ?? '',
  hubUrl:        'https://hub.ag3nts.org',
  taskName:      'electricity',
  logFile:       'solution_v3.log',

  // Orchestrator: text reasoning + tool calling (no vision needed)
  orchestratorModel: 'google/gemini-2.5-flash',

  // Vision sub-agent: per-cell cable topology analysis
  visionModel: 'google/gemini-3-flash-preview',

  // Safety limit — prevents infinite agent loops
  maxIterations:   30,
  rotationDelayMs: 400,
  saveCellCrops:   true,
} as const;

// ============================================================
// Types
// ============================================================

interface CellTopology {
  top: boolean; right: boolean; bottom: boolean; left: boolean;
}
type BoardTopology = Record<string, CellTopology>;

interface ApiResponse {
  code: number; message?: string; [key: string]: unknown;
}

// ── OpenAI-compatible message types ──────────────────────────

interface ToolCall {
  id:       string;
  type:     'function';
  function: { name: string; arguments: string };
}

// A message in the agent's history.
// Each role represents a different participant in the conversation:
//   system    → initial instructions to the LLM
//   user      → the human's request
//   assistant → the LLM's response (may contain tool_calls)
//   tool      → the result of executing a tool
interface AgentMessage {
  role:          'system' | 'user' | 'assistant' | 'tool';
  content:       string | null;
  tool_calls?:   ToolCall[];    // present when LLM decides to call tools
  tool_call_id?: string;        // links a tool result back to the tool_call that triggered it
}

interface LLMResponse {
  choices: Array<{
    message:       AgentMessage;
    finish_reason: 'stop' | 'tool_calls' | 'length' | string;
  }>;
  error?: { message: string };
}

// A tool definition = JSON schema the LLM reads to understand available actions
interface ToolDefinition {
  type: 'function';
  function: {
    name:        string;
    description: string;
    parameters:  object;
  };
}

// ============================================================
// Logger
// ============================================================

const logger = {
  init(): void {
    fs.writeFileSync(CONFIG.logFile, '');
    this.log('=== Session started (v3 — Tool-Based Agent) ===');
  },
  log(msg: string, level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' = 'INFO'): void {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    fs.appendFileSync(CONFIG.logFile, line + '\n');
  },
  json(label: string, data: unknown): void {
    this.log(`${label}:\n${JSON.stringify(data, null, 2)}`);
  },
  section(title: string): void {
    this.log(`\n${'─'.repeat(60)}\n${title}\n${'─'.repeat(60)}`);
  },
};

// ============================================================
// Target Topology
// ============================================================

// The solved board state. Provided to the LLM in the system prompt
// so it can reason about what rotations are needed.
const TARGET_TOPOLOGY: BoardTopology = {
  '1x1': { top: false, right: true,  bottom: true,  left: false },
  '1x2': { top: false, right: true,  bottom: true,  left: true  },
  '1x3': { top: false, right: true,  bottom: false, left: true  },
  '2x1': { top: true,  right: false, bottom: true,  left: false },
  '2x2': { top: true,  right: true,  bottom: true,  left: false },
  '2x3': { top: false, right: true,  bottom: true,  left: true  },
  '3x1': { top: true,  right: true,  bottom: false, left: true  },
  '3x2': { top: true,  right: false, bottom: false, left: true  },
  '3x3': { top: true,  right: true,  bottom: false, left: false },
};

const GRIDS = {
  current: { col: [237, 331, 427, 522], row: [98, 195, 290, 383] },
};

// ============================================================
// Tool Definitions — the schemas the LLM reads
// ============================================================

/**
 * LESSON: Tool definitions are JSON schemas with two purposes:
 *   name + description → the LLM decides WHEN to call this tool
 *   parameters         → the LLM knows WHAT arguments to provide
 *
 * Think of these as an API contract between the LLM and TypeScript.
 * The LLM never sees the implementation — only these schemas.
 */
/**
 * TOOL DESIGN LESSON:
 * We added compute_rotations because LLMs make spatial arithmetic errors.
 * The rule: LLM for reasoning/decisions, tools for deterministic computation.
 *
 * A "math helper" tool is a valid and common pattern in agentic systems.
 * Examples: code interpreter, calculator, SQL executor, regex validator.
 * The LLM coordinates; TypeScript guarantees correctness.
 */
const ORCHESTRATOR_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name:        'reset_board',
      description: 'Reset the puzzle board to its initial state. Call this at the start of the task.',
      parameters:  { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name:        'read_board',
      description:
        'Download the current board image and analyze the cable topology of all 9 cells using computer vision. ' +
        'Returns a JSON object with {top, right, bottom, left} booleans for each cell. ' +
        'After calling this, use compute_rotations to calculate the exact rotation plan.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name:        'compute_rotations',
      description:
        'Given the current board topology (from read_board), compute exactly how many 90-degree clockwise ' +
        'rotations each cell needs to match the target topology. ' +
        'Returns a rotation plan with rotation counts per cell. ' +
        'Call this after read_board before executing any rotate_cell calls.',
      parameters: {
        type:       'object',
        properties: {
          current_topology: {
            type:        'string',
            description: 'The current board topology as a JSON string, exactly as returned by read_board.',
          },
        },
        required: ['current_topology'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'rotate_cell',
      description:
        'Rotate one cell 90 degrees clockwise. ' +
        'One call = one rotation. If the plan says a cell needs 2 rotations, call this twice for that cell. ' +
        'The response contains {FLG:...} when the puzzle is solved — that is the flag you must report.',
      parameters: {
        type:       'object',
        properties: {
          cell: {
            type:        'string',
            description: 'Cell to rotate. Format: "RowxCol" where Row and Col are 1-3. Examples: "1x1", "2x3", "3x2".',
          },
        },
        required: ['cell'],
      },
    },
  },
];

// ============================================================
// Rotation Math — deterministic TypeScript (used by compute_rotations tool)
// ============================================================

// These functions are NOT called by TypeScript logic — they are the
// implementation behind the compute_rotations TOOL. The LLM decides
// when to call the tool; TypeScript guarantees the math is correct.

function rotateCWOnce(t: CellTopology): CellTopology {
  return { top: t.left, right: t.top, bottom: t.right, left: t.bottom };
}

function topologiesMatch(a: CellTopology, b: CellTopology): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

function cellRotationsNeeded(current: CellTopology, target: CellTopology): number {
  let t = { ...current };
  for (let i = 0; i < 4; i++) {
    if (topologiesMatch(t, target)) return i;
    t = rotateCWOnce(t);
  }
  return -1; // incompatible cable types — should not happen with correct vision
}

// ============================================================
// VisionAgent — image perception sub-agent
// (used internally as the implementation of the read_board tool)
// ============================================================

/**
 * VisionAgent is NOT an LLM agent loop — it's a direct LLM call per cell.
 * It serves as a specialized sub-agent: receives board image, returns topology.
 *
 * From the OrchestratorAgent's perspective, this is invisible —
 * it just calls the 'read_board' tool and gets back topology JSON.
 * The VisionAgent is an implementation detail of that tool.
 *
 * NOTE: You could make VisionAgent a full agent loop too (with its own
 * 'crop_cell' tool), but the key learning is the orchestrator loop here.
 */
class VisionAgent {
  private readonly model: string = CONFIG.visionModel;
  private readonly apiUrl = 'https://openrouter.ai/api/v1/chat/completions';

  async analyzeBoard(imageBuffer: Buffer, grid: typeof GRIDS.current): Promise<BoardTopology> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img: any = await Jimp.fromBuffer(imageBuffer);
    logger.log(`[VisionAgent] Board loaded: ${img.width}x${img.height}px`);

    const board: BoardTopology = {};
    const cells = ['1x1','1x2','1x3','2x1','2x2','2x3','3x1','3x2','3x3'];

    for (const cellId of cells) {
      const [rStr, cStr] = cellId.split('x');
      const r = parseInt(rStr, 10);
      const c = parseInt(cStr, 10);
      const x = grid.col[c - 1];
      const y = grid.row[r - 1];
      const w = grid.col[c] - x;
      const h = grid.row[r] - y;

      const cropBase64 = await this.cropToBase64(img, x, y, w, h, cellId);
      board[cellId]    = await this.analyzeCell(cropBase64, cellId);
    }

    return board;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async cropToBase64(img: any, x: number, y: number, w: number, h: number, cellId: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const crop: any = img.clone();
    crop.crop({ x, y, w, h });
    const buf: Buffer = await crop.getBuffer('image/png');
    if (CONFIG.saveCellCrops) fs.writeFileSync(`v3_cell_${cellId}.png`, buf);
    return buf.toString('base64');
  }

  private async analyzeCell(cropBase64: string, cellId: string, attempt = 1): Promise<CellTopology> {
    const prompt =
      `Analyze this single electrical cable connector cell.\n` +
      `Cables are dark/black thick lines on a light background.\n` +
      `Cell ID: ${cellId}\n\n` +
      `Which edges (top, right, bottom, left) have cable exits?\n` +
      `Ignore thin border lines — only count thick internal cable lines.\n\n` +
      `Reply with ONLY this JSON (no extra text):\n` +
      `{"top": false, "right": true, "bottom": true, "left": false}`;

    try {
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.openrouterKey}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://ai-devs.pl',
          'X-Title':       'AI Devs 4 S2E2 - Vision Sub-Agent',
        },
        body: JSON.stringify({
          model:       this.model,
          messages: [{
            role:    'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${cropBase64}` } },
              { type: 'text', text: prompt },
            ],
          }],
          max_tokens:  100,
          temperature: 0,
        }),
      });

      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const raw  = data.choices?.[0]?.message?.content?.trim() ?? '';
      const json = raw.replace(/```json?\s*/gi, '').replace(/```\s*/g, '').match(/\{[^{}]+\}/);
      if (!json) throw new Error(`No JSON found: ${raw.slice(0, 100)}`);

      const p = JSON.parse(json[0]);
      logger.log(`[VisionAgent] ${cellId} → ${JSON.stringify(p)}`);
      return { top: Boolean(p.top), right: Boolean(p.right), bottom: Boolean(p.bottom), left: Boolean(p.left) };

    } catch (err) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 500 * attempt));
        return this.analyzeCell(cropBase64, cellId, attempt + 1);
      }
      throw err;
    }
  }
}

// ============================================================
// HubClient
// ============================================================

class HubClient {
  private readonly base = CONFIG.hubUrl;
  private readonly key  = CONFIG.aiDevsApiKey;
  private readonly task = CONFIG.taskName;

  async download(path: string): Promise<Buffer> {
    const url = `${this.base}${path}`;
    logger.log(`GET ${url}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async resetBoard(): Promise<void> {
    await this.download(`/data/${this.key}/electricity.png?reset=1`);
  }

  async downloadCurrentBoard(): Promise<Buffer> {
    return this.download(`/data/${this.key}/electricity.png`);
  }

  async rotateCell(cell: string): Promise<ApiResponse> {
    const res = await fetch(`${this.base}/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ apikey: this.key, task: this.task, answer: { rotate: cell } }),
    });
    return res.json() as Promise<ApiResponse>;
  }
}

// ============================================================
// OrchestratorAgent — the true tool-based agent
// ============================================================

/**
 * This is the core of the lesson.
 *
 * The OrchestratorAgent runs an LLM in a loop.
 * On each iteration:
 *   A) Call the LLM with full message history + tool schemas
 *   B) LLM returns either tool_calls (wants to act) or stop (done)
 *   C) For each tool_call: execute it, append result to history
 *   D) Loop back to A with the updated history
 *
 * The LLM's message history is the agent's "memory" and "reasoning trace".
 * Each tool result feeds directly into the LLM's next decision.
 *
 * TypeScript has NO rotation logic. It only:
 *   - Sends the system prompt + tools to the LLM
 *   - Executes what the LLM requests
 *   - Feeds results back
 */
class OrchestratorAgent {
  private readonly hub    = new HubClient();
  private readonly vision = new VisionAgent();
  private readonly apiUrl = 'https://openrouter.ai/api/v1/chat/completions';

  async run(): Promise<void> {
    logger.section('ELECTRICITY PUZZLE SOLVER (v3 — Tool-Based Agent)');
    logger.log(`Orchestrator model: ${CONFIG.orchestratorModel}`);
    logger.log(`Vision model: ${CONFIG.visionModel}`);

    // ── SYSTEM PROMPT ─────────────────────────────────────────
    //
    // The system prompt is the LLM's full briefing.
    // It replaces ALL the hardcoded logic from v1/v2:
    //   - The target state (what does "solved" look like?)
    //   - The rotation mechanics (how do CW rotations change topology?)
    //   - The strategy (what order should it do things in?)
    //
    // The LLM reads this ONCE at the start. Every tool call it makes
    // is guided by this context plus everything it has seen in history.
    const systemPrompt = buildSystemPrompt();

    // ── MESSAGE HISTORY ───────────────────────────────────────
    //
    // This array is the agent's working memory.
    // It grows on every iteration:
    //   [system]                   ← initial briefing (never changes)
    //   [user]                     ← the task
    //   [assistant + tool_calls]   ← LLM's first decision
    //   [tool, tool, ...]          ← results of executing those calls
    //   [assistant + tool_calls]   ← LLM's next decision, informed by results
    //   [tool, tool, ...]          ← ...
    //   [assistant (no tool_calls)] ← LLM says it's done
    //
    // This history IS the agent's reasoning trace. Inspect it in the log.
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: 'Solve the electricity puzzle and retrieve the flag.' },
    ];

    let flag: string | null = null;
    let iteration = 0;

    // ── AGENT LOOP ────────────────────────────────────────────
    while (iteration < CONFIG.maxIterations && !flag) {
      iteration++;
      logger.section(`Agent Iteration ${iteration}/${CONFIG.maxIterations}`);
      logger.log(`Message history length: ${messages.length} messages`);

      // ── STEP A: Ask the LLM what to do next ─────────────────
      //
      // We send the full message history + tool definitions.
      // The LLM responds in one of two ways:
      //   1. finish_reason='tool_calls' → it wants to call tools
      //   2. finish_reason='stop'       → it's done reasoning
      const response = await this.callLLM(messages);

      if (response.error) {
        throw new Error(`LLM error: ${response.error.message}`);
      }

      const choice    = response.choices[0];
      const assistant = choice.message;

      // Log the LLM's current reasoning (it often explains its plan in content)
      if (assistant.content) {
        logger.log(`LLM reasoning:\n${assistant.content}`);
      }
      logger.log(`LLM finish_reason: "${choice.finish_reason}"`);

      // ── STEP B: Append LLM message to history ────────────────
      //
      // CRITICAL: The assistant message must be in history BEFORE
      // the tool results. The LLM needs to see its own decisions
      // when it reads the history on the next iteration.
      messages.push(assistant);

      // ── STEP C: Check if the LLM is done ─────────────────────
      //
      // No tool_calls = the LLM decided it's finished.
      // This can happen after finding the flag, or if it gives up.
      const hasTool = assistant.tool_calls && assistant.tool_calls.length > 0;
      if (!hasTool) {
        logger.log('LLM made no tool calls — agent loop complete.', 'SUCCESS');
        break;
      }

      // ── STEP D: Execute each tool call ────────────────────────
      //
      // The LLM may request multiple tool calls in one response.
      // We execute them in order and append each result to history.
      //
      // DESIGN CHOICE: execute sequentially (not in parallel).
      // For this puzzle, each rotation must complete before the next
      // because the board state changes with each call.
      for (const toolCall of assistant.tool_calls!) {
        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;

        logger.log(`>>> Tool call: ${name}(${JSON.stringify(args)})`);

        let result: string;
        try {
          result = await this.executeTool(name, args);
        } catch (err) {
          // Feed errors back to the LLM — it can decide how to recover.
          // This is more flexible than hardcoded retry logic in TypeScript.
          result = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
          logger.log(`Tool error: ${result}`, 'WARN');
        }

        logger.log(`<<< Tool result: ${result.slice(0, 300)}`);

        // ── STEP E: Append tool result to history ─────────────
        //
        // The 'tool' role message must include:
        //   tool_call_id → links this result to the specific tool_call above
        //   content      → the result string the LLM will read
        //
        // The LLM uses this result in its next reasoning step.
        // If result contains topology JSON, it will compare with target.
        // If result contains {FLG:...}, it will report success.
        messages.push({
          role:          'tool',
          tool_call_id:  toolCall.id,
          content:       result,
        });

        // Check every tool result for the flag
        const extracted = extractFlag(result);
        if (extracted) {
          flag = extracted;
          logger.log(`FLAG FOUND in tool result: ${flag}`, 'SUCCESS');
          // The LLM will see this flag in the next iteration and stop
          // (but the while condition !flag will also exit the loop)
          break;
        }

        // Small pause between rotation calls
        if (name === 'rotate_cell') {
          await this.sleep(CONFIG.rotationDelayMs);
        }
      }
    }

    // ── RESULT ────────────────────────────────────────────────
    logger.section('Final Result');
    if (flag) {
      logger.log(`SUCCESS! Flag: ${flag}`, 'SUCCESS');
    } else {
      logger.log(`No flag after ${iteration} iterations.`, 'ERROR');
      logger.log('Inspect solution_v3.log for the full agent reasoning trace.');
    }
  }

  // ── TOOL EXECUTOR ─────────────────────────────────────────
  //
  // This is the "execution layer" — it maps tool names to TypeScript.
  // The LLM never sees this code, only the ToolDefinition schemas above.
  //
  // Each tool returns a STRING — the LLM reads strings, not objects.
  // Return informative strings, not just "done" — the LLM uses the
  // content to inform its next decision.

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {

      case 'reset_board': {
        await this.hub.resetBoard();
        await this.sleep(1500); // wait for server to process reset
        return 'Board reset to initial state. Ready for analysis.';
      }

      case 'read_board': {
        const buffer   = await this.hub.downloadCurrentBoard();
        fs.writeFileSync('v3_board_latest.png', buffer);
        const topology = await this.vision.analyzeBoard(buffer, GRIDS.current);
        logger.json('[read_board] Detected topology', topology);
        return JSON.stringify(topology, null, 2);
      }

      case 'compute_rotations': {
        // Parse the current topology the LLM passed in
        let current: BoardTopology;
        try {
          current = JSON.parse(String(args.current_topology)) as BoardTopology;
        } catch {
          return 'ERROR: current_topology is not valid JSON. Pass the exact string returned by read_board.';
        }

        const CELL_IDS = ['1x1','1x2','1x3','2x1','2x2','2x3','3x1','3x2','3x3'];
        const plan: Record<string, number> = {};
        const issues: string[] = [];

        for (const cell of CELL_IDS) {
          if (!current[cell]) { issues.push(`${cell}: missing`); plan[cell] = 0; continue; }
          const rotations = cellRotationsNeeded(current[cell], TARGET_TOPOLOGY[cell]);
          if (rotations === -1) {
            issues.push(`${cell}: incompatible topology (vision may have misread this cell)`);
            plan[cell] = 0;
          } else {
            plan[cell] = rotations;
          }
        }

        const totalRotations = Object.values(plan).reduce((s, n) => s + n, 0);
        const needed = Object.entries(plan)
          .filter(([, n]) => n > 0)
          .map(([c, n]) => `${c}×${n}`)
          .join(', ');

        logger.json('[compute_rotations] Plan', plan);
        return JSON.stringify({
          rotation_plan: plan,
          total_rotations: totalRotations,
          cells_needing_rotation: needed || 'none — board already matches target',
          issues: issues.length ? issues : undefined,
        }, null, 2);
      }

      case 'rotate_cell': {
        const cell = String(args.cell ?? '');
        // Validate before sending to hub — catch LLM formatting errors early
        if (!/^[1-3]x[1-3]$/.test(cell)) {
          return `ERROR: Invalid cell "${cell}". Must be "RowxCol" with Row/Col each 1-3 (e.g. "2x3").`;
        }
        const response = await this.hub.rotateCell(cell);
        logger.log(`rotate_cell(${cell}) → ${JSON.stringify(response)}`);
        // Return the raw API response — it contains the flag when solved
        return JSON.stringify(response);
      }

      default:
        return `ERROR: Unknown tool "${name}". Available: reset_board, read_board, rotate_cell.`;
    }
  }

  // ── LLM CALL ─────────────────────────────────────────────
  //
  // Sends message history + tool schemas to the orchestrator LLM.
  // Key parameters:
  //   tools       → the schemas the LLM can call
  //   tool_choice → 'auto' means LLM decides when to use tools vs. respond
  //   temperature → 0 for deterministic reasoning (no randomness)
  //   max_tokens  → enough for full rotation plan + reasoning
  private async callLLM(messages: AgentMessage[]): Promise<LLMResponse> {
    logger.log(`Calling ${CONFIG.orchestratorModel} (${messages.length} messages)...`);

    const res = await fetch(this.apiUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.openrouterKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://ai-devs.pl',
        'X-Title':       'AI Devs 4 S2E2 - Orchestrator Agent',
      },
      body: JSON.stringify({
        model:       CONFIG.orchestratorModel,
        messages,
        tools:       ORCHESTRATOR_TOOLS,
        tool_choice: 'auto',  // LLM decides: call a tool OR respond with text
        temperature: 0,       // deterministic reasoning
        max_tokens:  4096,    // room for full plan + rotation reasoning
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json() as Promise<LLMResponse>;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ============================================================
// System Prompt Builder
// ============================================================

/**
 * Builds the system prompt that replaces all hardcoded TypeScript logic.
 *
 * The system prompt must give the LLM everything it needs to:
 *   1. Understand the task (what is the puzzle, what is the goal?)
 *   2. Know the target state (what should the solved board look like?)
 *   3. Understand the mechanics (how do rotations change topology?)
 *   4. Know the strategy (what is the right order of operations?)
 *
 * LESSON: Good system prompt design is critical for agentic tasks.
 * Vague prompts produce uncertain agents that waste API calls or loop.
 * Precise prompts produce confident agents that solve tasks efficiently.
 */
function buildSystemPrompt(): string {
  // Format target topology for human-readable comparison in LLM reasoning
  const targetLines = Object.entries(TARGET_TOPOLOGY)
    .map(([cell, t]) => {
      const connections = [t.top?'top':'', t.right?'right':'', t.bottom?'bottom':'', t.left?'left':'']
        .filter(Boolean).join('+');
      return `  ${cell}: ${connections}`;
    })
    .join('\n');

  return `You are an autonomous agent solving a 3x3 electrical cable puzzle.

GOAL: Rotate puzzle cells until the board matches the target topology, then collect the flag {FLG:...}.

BOARD LAYOUT (cells addressed as RowxCol, both 1-3):
  1x1 | 1x2 | 1x3    ← Row 1 (top)
  2x1 | 2x2 | 2x3    ← Row 2 (middle)
  3x1 | 3x2 | 3x3    ← Row 3 (bottom)
  Col1  Col2  Col3

TARGET TOPOLOGY (the solved state you must reach):
${targetLines}

Each cell topology is described by which edges have cable exits (true=cable, false=no cable):
${JSON.stringify(TARGET_TOPOLOGY, null, 2)}

ROTATION MECHANICS (each rotate_cell call = one 90-degree clockwise rotation):
  Before:          After 1 CW rotation:
  top    → right   (what was at top goes to right)
  right  → bottom  (what was at right goes to bottom)
  bottom → left    (what was at bottom goes to left)
  left   → top     (what was at left goes to top)

  So if a cell has {top:false, right:true, bottom:true, left:false}:
    After 1 rotation: {top:false, right:false, bottom:true, left:true}
    After 2 rotations: {top:true, right:false, bottom:false, left:true}
    After 3 rotations: {top:true, right:true, bottom:false, left:false}

  To find rotations needed: try applying 0, 1, 2, 3 CW rotations mentally.
  Pick the smallest number that makes the cell match its target topology.

STRATEGY:
  1. Call reset_board to start from a known initial state
  2. Call read_board to get the current topology (vision analysis of all 9 cells)
  3. Call compute_rotations passing the read_board result — it returns the exact rotation count per cell
  4. Execute the plan: call rotate_cell once per rotation for each cell that needs it
     Example: if compute_rotations says {"2x2": 3}, call rotate_cell("2x2") three times
  5. The flag {FLG:...} will appear inside a rotate_cell response when the board is solved
  6. Report the exact flag string you received from the tool

IMPORTANT RULES:
  - Each rotate_cell call = exactly one 90-degree clockwise rotation of one cell
  - NEVER guess or invent a flag — the flag ONLY comes from a rotate_cell tool response
  - The flag format is always {FLG:SOMETEXT} — do not report anything else as the flag
  - If compute_rotations reports issues (incompatible topology), call read_board again to re-analyze
  - If you execute all planned rotations but get no flag, call read_board + compute_rotations again`;
}

// ============================================================
// Utilities
// ============================================================

function extractFlag(text: string): string | null {
  const m = text.match(/\{FLG:[^}]+\}/);
  return m ? m[0] : null;
}

// ============================================================
// Entry Point
// ============================================================

async function main(): Promise<void> {
  if (!CONFIG.aiDevsApiKey)  throw new Error('AI_DEVS_API_KEY not set in .env');
  if (!CONFIG.openrouterKey) throw new Error('OPENROUTER_API_KEY not set in .env');

  logger.init();
  await new OrchestratorAgent().run();
}

main().catch(err => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.log(`FATAL: ${msg}`, 'ERROR');
  process.exit(1);
});
