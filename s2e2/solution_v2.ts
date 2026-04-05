/**
 * ============================================================
 * AI Devs 4 - S2E2: Electricity Puzzle Solver (v2 — Vision Agent)
 * ============================================================
 *
 * ARCHITECTURE: Multi-Agent System with Vision Delegation
 * ========================================================
 *
 * Unlike v1 (deterministic pixel analysis), this version teaches how to
 * build a proper Vision Agent — a subagent that accepts an image and
 * returns structured data by sending it to a vision-capable LLM.
 *
 * LESSON PRINCIPLE (from task hint):
 *   "Delegate image description to an appropriate tool or subagent."
 *   Here, VisionAgent IS that subagent. It receives isolated cell crops
 *   and translates visual information into structured CellTopology data.
 *
 * WHY CROP INDIVIDUAL CELLS?
 *   Task hint: "Maybe it's worth preparing the image before sending?
 *   Does it need to be sent in full?"
 *
 *   → Full board: 9 overlapping connectors confuse vision models.
 *   → Single cell crop: focused, simple context → higher accuracy.
 *   → Preprocessing is a first-class concern in vision agent design.
 *
 * AGENT HIERARCHY:
 *   OrchestratorAgent   ← top-level coordinator (no image knowledge)
 *     └─ BoardAnalyzer  ← orchestrates per-cell analysis
 *          ├─ jimp      ← image preprocessing tool (cell cropping)
 *          └─ VisionAgent  ← subagent: crop → LLM → CellTopology JSON
 *
 * FLOW:
 *   1. Reset board to known initial state
 *   2. Load image.png (local base file with initial board state)
 *   3. BoardAnalyzer: crop 9 cells → VisionAgent → BoardTopology
 *   4. buildRotationPlan(current, TARGET_TOPOLOGY) → 0-3 CW per cell
 *   5. HubClient: apply rotations, receive flag {FLG:...}
 *   6. If no flag: download fresh board image and retry (adapts to errors)
 *
 * TARGET TOPOLOGY: Hard-coded from v1's pixel-verified analysis.
 *   This is the correct solved state. VisionAgent determines the CURRENT
 *   state; the pure-math rotation planner bridges current → target.
 *
 * MODEL: google/gemini-2.0-flash-exp (recommended in task hints)
 *   - Supports vision via OpenRouter image_url content blocks
 *   - Gemini handles small cell crops well with temperature=0
 */

import * as fs from 'fs';
import { Jimp } from 'jimp';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================
// Configuration
// ============================================================

const CONFIG = {
  aiDevsApiKey:     process.env.AI_DEVS_API_KEY ?? '',
  openrouterKey:    process.env.OPENROUTER_API_KEY ?? '',
  hubUrl:           'https://hub.ag3nts.org',
  taskName:         'electricity',
  logFile:          'solution_v2.log',

  /**
   * Vision model via OpenRouter.
   * Recommended by task: google/gemini-2.0-flash-exp (or gemini-flash-1.5)
   * Fallbacks: anthropic/claude-3.5-sonnet, google/gemini-pro-vision
   */
  visionModel:      'google/gemini-3-flash-preview',

  resetBoard:       true,
  maxAttempts:      3,
  maxVisionRetries: 3,    // per cell — retries on parse failure
  rotationDelayMs:  400,
  saveCellCrops:    true, // save cell_1x1.png etc. for debugging
} as const;

// ============================================================
// Types
// ============================================================

type CellId = `${1|2|3}x${1|2|3}`;
type RotPlan = Record<string, number>;

interface CellTopology {
  top:    boolean;
  right:  boolean;
  bottom: boolean;
  left:   boolean;
}
type BoardTopology = Record<string, CellTopology>;

interface ApiResponse {
  code:     number;
  message?: string;
  [key: string]: unknown;
}

// ============================================================
// Logger
// ============================================================

const logger = {
  init(): void {
    fs.writeFileSync(CONFIG.logFile, '');
    this.log('=== Session started (v2 — Vision Agent) ===');
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
    const bar = '─'.repeat(60);
    this.log(`\n${bar}\n${title}\n${bar}`);
  },
};

// ============================================================
// Target Board Topology
// ============================================================

/**
 * Correct target topology — verified by pixel edge analysis in v1.
 * VisionAgent determines the CURRENT state; this defines where we want to be.
 *
 * Circuit logic (why each cell looks this way):
 *   Source: external power enters at 3x1's LEFT edge (off-grid)
 *   Outputs: power exits at 1x3, 2x3, 3x3 RIGHT edges (→ power plants)
 *
 *   1x1: RB  — right+bottom
 *   1x2: RBL — right+bottom+left (T-junction)
 *   1x3: RL  — right+left        (right → PWR plant)
 *   2x1: TB  — top+bottom        (straight vertical)
 *   2x2: TRB — top+right+bottom  (T-junction)
 *   2x3: RBL — right+bottom+left (right → PWR plant)
 *   3x1: TRL — top+right+left    (left ← source, T-junction)
 *   3x2: TL  — top+left          (corner)
 *   3x3: TR  — top+right         (right → PWR plant)
 */
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

// ============================================================
// Grid Pixel Boundaries
// ============================================================

/**
 * Pixel coordinates of the 3×3 grid within board images.
 * col[c-1] = left edge of column c; col[c] = right edge of column c.
 * row[r-1] = top edge of row r; row[r] = bottom edge of row r.
 *
 * Verified for: current board 800×450px, target board 598×422px.
 */
const GRIDS = {
  current: { col: [237, 331, 427, 522], row: [98, 195, 290, 383] },
};

// ============================================================
// VisionAgent — Subagent for image interpretation
// ============================================================

/**
 * VisionAgent is a dedicated subagent responsible for ONE task:
 * receive an image of a cable connector cell and return its topology.
 *
 * DESIGN PRINCIPLES DEMONSTRATED:
 *
 * 1. Single Responsibility
 *    VisionAgent knows nothing about rotations, board layout, or hub API.
 *    It only converts image pixels into structured {top,right,bottom,left}.
 *
 * 2. Prompt Engineering for Vision
 *    - Describe what the image contains (cable puzzle cell)
 *    - Describe visual characteristics (dark lines on light background)
 *    - Forbid prose — demand strict JSON output
 *    - Provide a concrete example of expected format
 *    - Use temperature=0 for deterministic answers
 *
 * 3. Robust Response Parsing
 *    Vision models sometimes add markdown, prose, or partial JSON.
 *    Always extract JSON with regex before parsing.
 *
 * 4. Retry with Backoff
 *    LLM responses can be malformed. Retry on parse failure.
 *    Exponential backoff prevents rate limit issues.
 *
 * OPENROUTER VISION API FORMAT:
 *   messages[0].content is an array of content parts:
 *   [
 *     { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
 *     { type: "text", text: "...prompt..." }
 *   ]
 *   Images must be sent as data URIs: data:image/png;base64,{base64string}
 */
class VisionAgent {
  // Use string type (not const) to allow model switching at runtime
  private readonly model: string = CONFIG.visionModel;
  private readonly apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  private readonly apiKey: string = CONFIG.openrouterKey;

  /**
   * Analyze a single cell image and return cable topology.
   * Retries up to CONFIG.maxVisionRetries times on JSON parse failure.
   *
   * @param cropBase64  Base64-encoded PNG of the cell crop
   * @param cellId      e.g. "2x3" — used only for logging context
   */
  async analyzeCell(cropBase64: string, cellId: string): Promise<CellTopology> {
    const prompt = this.buildPrompt(cellId);

    for (let attempt = 1; attempt <= CONFIG.maxVisionRetries; attempt++) {
      logger.log(`VisionAgent [${cellId}]: attempt ${attempt}/${CONFIG.maxVisionRetries}`);

      try {
        const raw = await this.callVisionLLM(cropBase64, prompt);
        logger.log(`VisionAgent [${cellId}] raw: ${raw}`);

        const topology = this.parseTopologyResponse(raw);
        const tStr = [
          topology.top    ? 'T' : '',
          topology.right  ? 'R' : '',
          topology.bottom ? 'B' : '',
          topology.left   ? 'L' : '',
        ].filter(Boolean).join('') || 'none';
        logger.log(`VisionAgent [${cellId}] → topology: ${tStr}`);
        return topology;

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log(`VisionAgent [${cellId}] attempt ${attempt} failed: ${msg}`, 'WARN');
        if (attempt === CONFIG.maxVisionRetries) {
          throw new Error(`VisionAgent: all retries exhausted for cell ${cellId}: ${msg}`);
        }
        // Exponential backoff: 500ms, 1000ms, 1500ms...
        await this.sleep(500 * attempt);
      }
    }

    // TypeScript requires this — unreachable due to throw above
    throw new Error('VisionAgent: unexpected exit');
  }

  /**
   * Prompt for cable topology detection.
   *
   * KEY INSIGHT: Be specific about what "dark" and "exits" mean.
   * Vision models can hallucinate — concrete visual descriptions help.
   * The example JSON format prevents the model from being creative.
   */
  private buildPrompt(cellId: string): string {
    return `You are analyzing a single connector piece from an electrical cable puzzle.

The image shows ONE square cell. Inside this cell there is a cable connector:
- Cables appear as DARK (black or very dark gray) thick lines/bars
- The cell background is LIGHT (white, gray, or beige)
- The connector has cable exits at 2, 3, or 4 of the 4 edges

Your task: determine which edges have cable exits.

For each of the 4 edges (top, bottom, left, right):
  true  = a dark cable line visibly reaches/exits through this edge
  false = no cable at this edge (only background color near the edge)

IMPORTANT: Ignore any thin border/separator lines around the cell perimeter.
Only count thick dark cable lines that form part of the connector pattern.

Cell reference ID: ${cellId}

Respond with ONLY this JSON (no explanation, no markdown):
{"top": false, "right": true, "bottom": true, "left": false}`;
  }

  /**
   * OpenRouter vision API call.
   *
   * KEY LESSON: The image is sent as a data URI in image_url.url.
   * Format: "data:image/png;base64,{base64string}"
   *
   * max_tokens=100 is enough for {"top":x,"right":x,"bottom":x,"left":x}
   * temperature=0 ensures deterministic vision interpretation.
   */
  private async callVisionLLM(cropBase64: string, prompt: string): Promise<string> {
    const body = {
      model:    this.model,
      messages: [{
        role:    'user',
        content: [
          {
            type:      'image_url',
            image_url: {
              url: `data:image/png;base64,${cropBase64}`,
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      }],
      max_tokens:  100,  // {"top":false,"right":true,"bottom":true,"left":false} ≈ 35-50 tokens
      temperature: 0,    // no creative guessing — cables are either there or not
    };

    const response = await fetch(this.apiUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://ai-devs.pl',
        'X-Title':       'AI Devs 4 S2E2 - Vision Agent',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
      error?:   { message: string };
    };

    if (data.error) {
      throw new Error(`OpenRouter error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (content === null || content === undefined) {
      throw new Error('Vision LLM returned null/empty content');
    }

    return content.trim();
  }

  /**
   * Parse CellTopology from raw LLM response.
   *
   * ROBUSTNESS TECHNIQUES:
   * 1. Strip markdown code fences (```json ... ```)
   * 2. Use regex to extract the JSON object (handles prose before/after)
   * 3. Validate all 4 boolean fields before returning
   */
  private parseTopologyResponse(raw: string): CellTopology {
    // Remove markdown code blocks if model wrapped the JSON
    const cleaned = raw
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    // Extract the first {...} object (handles leading/trailing prose)
    const match = cleaned.match(/\{[^{}]+\}/);
    if (!match) {
      throw new Error(`No JSON object found in response: "${raw.slice(0, 200)}"`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      throw new Error(`JSON parse failed for: "${match[0]}"`);
    }

    // Validate all 4 boolean fields exist
    const fields = ['top', 'right', 'bottom', 'left'] as const;
    for (const field of fields) {
      if (typeof parsed[field] !== 'boolean') {
        throw new Error(
          `Field "${field}" is ${typeof parsed[field]} (expected boolean) in: ${match[0]}`
        );
      }
    }

    return {
      top:    parsed.top    as boolean,
      right:  parsed.right  as boolean,
      bottom: parsed.bottom as boolean,
      left:   parsed.left   as boolean,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ============================================================
// BoardAnalyzer — orchestrates cell cropping + vision delegation
// ============================================================

/**
 * BoardAnalyzer is the coordinator between image processing and VisionAgent.
 *
 * RESPONSIBILITIES:
 *   1. Load the board image with jimp
 *   2. Crop each of the 9 cells using grid boundary coordinates
 *   3. Encode each crop as base64 PNG
 *   4. Delegate to VisionAgent for topology detection
 *
 * LESSON: This separation means:
 *   - VisionAgent is reusable (works with any cell image, any puzzle)
 *   - BoardAnalyzer handles puzzle-specific geometry (grid coordinates)
 *   - OrchestratorAgent handles task logic (rotations, hub API)
 *
 * JIMP v1 CROP PATTERN:
 *   img.clone()           → creates independent copy (no shared state)
 *   clone.crop({x,y,w,h}) → modifies in-place (returns void)
 *   clone.getBuffer(mime) → async, returns Buffer
 */
class BoardAnalyzer {
  private readonly visionAgent = new VisionAgent();

  /**
   * Analyze all 9 cells and return the complete board topology.
   *
   * @param imageBuffer  Raw PNG bytes of the board image (any source)
   * @param grid         Pixel boundary coordinates for the 3×3 grid
   */
  async analyzeBoard(
    imageBuffer: Buffer,
    grid: typeof GRIDS.current,
  ): Promise<BoardTopology> {
    // Load image with jimp (use 'any' to avoid jimp v1 generic type conflicts)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img: any = await Jimp.fromBuffer(imageBuffer);
    logger.log(`Board image loaded: ${img.width}×${img.height}px`);

    const board: BoardTopology = {} as BoardTopology;
    const CELL_IDS: CellId[] = [
      '1x1','1x2','1x3',
      '2x1','2x2','2x3',
      '3x1','3x2','3x3',
    ];

    for (const cellId of CELL_IDS) {
      const [rStr, cStr] = cellId.split('x');
      const r = parseInt(rStr, 10);
      const c = parseInt(cStr, 10);

      // Cell pixel bounds
      const x = grid.col[c - 1];
      const y = grid.row[r - 1];
      const w = grid.col[c] - x;
      const h = grid.row[r] - y;

      logger.log(`Cropping cell ${cellId}: x=${x} y=${y} w=${w} h=${h}`);

      // Crop → base64
      const cropBase64 = await this.cropToBase64(img, x, y, w, h, cellId);

      // Send to VisionAgent (the specialized subagent)
      board[cellId] = await this.visionAgent.analyzeCell(cropBase64, cellId);
    }

    return board;
  }

  /**
   * Crop a cell from the board image and return as base64-encoded PNG.
   *
   * Saves to disk (cell_NxN.png) when CONFIG.saveCellCrops = true.
   * These files are useful for debugging vision model accuracy.
   *
   * @param img    jimp image instance (any to avoid type conflicts)
   * @param x,y   top-left corner of the cell in the board image
   * @param w,h   cell dimensions in pixels
   */
  private async cropToBase64(
    img: any,  // eslint-disable-line @typescript-eslint/no-explicit-any
    x: number,
    y: number,
    w: number,
    h: number,
    cellId: string,
  ): Promise<string> {
    // Clone to preserve the original board image for other cells
    const crop: any = img.clone(); // eslint-disable-line @typescript-eslint/no-explicit-any
    crop.crop({ x, y, w, h });

    // Export as PNG buffer (jimp v1 async API)
    const pngBuffer: Buffer = await crop.getBuffer('image/png');

    if (CONFIG.saveCellCrops) {
      const filename = `v2_cell_${cellId}.png`;
      fs.writeFileSync(filename, pngBuffer);
      logger.log(`  → Saved ${filename} (${pngBuffer.length}b, ${w}×${h}px)`);
    }

    return pngBuffer.toString('base64');
  }
}

// ============================================================
// Rotation Math — pure TypeScript, no AI needed
// ============================================================

/**
 * Apply one 90° clockwise rotation to a cell topology.
 *
 * CW rotation remapping:
 *   old top   → new right
 *   old right → new bottom
 *   old bottom → new left
 *   old left  → new top
 *
 * Equivalently: new.top = old.left, new.right = old.top, etc.
 */
function rotateCWOnce(t: CellTopology): CellTopology {
  return { top: t.left, right: t.top, bottom: t.right, left: t.bottom };
}

function topologiesMatch(a: CellTopology, b: CellTopology): boolean {
  return a.top === b.top && a.right === b.right &&
         a.bottom === b.bottom && a.left === b.left;
}

/**
 * Compute the minimum number of 90° CW rotations (0, 1, 2, or 3)
 * needed to bring current topology to match target.
 *
 * Returns 0 if they can't match (incompatible cable type — vision error).
 */
function computeCellRotations(
  current: CellTopology,
  target:  CellTopology,
  cellId:  string,
): number {
  let t = { ...current };
  for (let i = 0; i < 4; i++) {
    if (topologiesMatch(t, target)) return i;
    t = rotateCWOnce(t);
  }
  logger.log(
    `[${cellId}] Incompatible topology — vision may have misidentified cable type.\n` +
    `  Current: ${JSON.stringify(current)}\n  Target:  ${JSON.stringify(target)}`,
    'WARN',
  );
  return 0;
}

function buildRotationPlan(current: BoardTopology): RotPlan {
  const cells = ['1x1','1x2','1x3','2x1','2x2','2x3','3x1','3x2','3x3'];
  const plan: RotPlan = {};
  for (const cell of cells) {
    plan[cell] = computeCellRotations(current[cell], TARGET_TOPOLOGY[cell], cell);
  }
  return plan;
}

// ============================================================
// Network utilities
// ============================================================

async function downloadImage(url: string): Promise<Buffer> {
  logger.log(`GET ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

// ============================================================
// HubClient — interface to the puzzle hub
// ============================================================

class HubClient {
  private readonly base = CONFIG.hubUrl;
  private readonly key  = CONFIG.aiDevsApiKey;
  private readonly task = CONFIG.taskName;

  async downloadCurrentBoard(): Promise<Buffer> {
    return downloadImage(`${this.base}/data/${this.key}/electricity.png`);
  }

  async resetBoard(): Promise<void> {
    await downloadImage(`${this.base}/data/${this.key}/electricity.png?reset=1`);
    logger.log('Board reset complete');
  }

  async rotateCell(cell: string): Promise<ApiResponse> {
    const res = await fetch(`${this.base}/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        apikey: this.key,
        task:   this.task,
        answer: { rotate: cell },
      }),
    });
    const data = await res.json() as ApiResponse;
    logger.log(`→ rotate ${cell}: ${JSON.stringify(data)}`);
    return data;
  }

  extractFlag(response: ApiResponse): string | null {
    const text = JSON.stringify(response);
    const m = text.match(/\{FLG:[^}]+\}/);
    if (m) return m[0];
    // Fallback: code=0 with non-trivial message is sometimes the flag
    if (response.code === 0 && response.message && !['Done', 'OK'].includes(response.message)) {
      return response.message;
    }
    return null;
  }
}

// ============================================================
// OrchestratorAgent — top-level coordinator
// ============================================================

/**
 * OrchestratorAgent coordinates all agents and manages the solve loop.
 *
 * KEY LESSON: The orchestrator:
 *   - Knows the overall goal (solve the puzzle, get the flag)
 *   - Delegates perception to BoardAnalyzer → VisionAgent
 *   - Delegates rotation logic to pure math (buildRotationPlan)
 *   - Delegates hub interaction to HubClient
 *   - Does NOT handle images, prompts, or HTTP details itself
 *
 * BOARD IMAGE STRATEGY:
 *   Attempt 1: Use local image.png (the "base file" provided)
 *              This is the initial board state after a reset.
 *   Attempt 2+: Download fresh board from hub
 *              This accounts for any VisionAgent errors in attempt 1.
 *              After failed rotations, the board is in an unknown state,
 *              so we reset first and re-analyze.
 *
 * LESSON: Agentic loops must handle uncertainty:
 *   "Verify after each batch of rotations — image analysis errors can
 *    cause unnecessary rotations or require a reset." (task hint)
 */
class OrchestratorAgent {
  private readonly hub      = new HubClient();
  private readonly analyzer = new BoardAnalyzer();

  async solve(): Promise<void> {
    logger.section('ELECTRICITY PUZZLE SOLVER (v2 — Vision Agent)');
    logger.json('Target topology', TARGET_TOPOLOGY);
    logger.log(`Vision model: ${CONFIG.visionModel}`);

    if (CONFIG.resetBoard) {
      logger.section('Board Reset');
      await this.hub.resetBoard();
      // Wait for the server to update the board image
      await this.sleep(1500);
    }

    let flag: string | null = null;

    for (let attempt = 1; attempt <= CONFIG.maxAttempts && !flag; attempt++) {
      logger.section(`Solve Attempt ${attempt}/${CONFIG.maxAttempts}`);

      try {
        flag = await this.solveAttempt(attempt);
      } catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        logger.log(`Attempt ${attempt} failed with error: ${msg}`, 'ERROR');

        if (attempt < CONFIG.maxAttempts) {
          logger.log('Resetting board and retrying...');
          await this.hub.resetBoard();
          await this.sleep(2000);
        }
      }
    }

    logger.section('Final Result');
    if (flag) {
      logger.log(`SUCCESS! Flag: ${flag}`, 'SUCCESS');
    } else {
      logger.log('No flag received after all attempts.', 'ERROR');
      logger.log('TIP: Check v2_cell_*.png files to verify VisionAgent accuracy.');
      logger.log('     If crops look wrong, adjust GRIDS.current boundaries.');
      logger.log('     If vision is wrong, try a different model or improve the prompt.');
    }
  }

  private async solveAttempt(attempt: number): Promise<string | null> {
    // STEP 1: Select board image source
    //
    // Attempt 1: use image.png (the base file provided with the task).
    //   After a reset, the server board matches this initial state.
    //   Using the local file saves an API call and is faster.
    //
    // Attempt 2+: download fresh board from hub.
    //   After failed rotations, we don't know the board state.
    //   A reset + fresh download gives us ground truth.
    let boardBuffer: Buffer;

    if (attempt === 1 && fs.existsSync('image.png')) {
      logger.log('Using local image.png as board source (initial state after reset)');
      boardBuffer = fs.readFileSync('image.png');
    } else {
      logger.log('Downloading current board image from hub...');
      boardBuffer = await this.hub.downloadCurrentBoard();
      fs.writeFileSync(`v2_board_attempt${attempt}.png`, boardBuffer);
    }

    // STEP 2: Vision Agent analyzes the board
    logger.section('VisionAgent — Analyzing 9 Cells');
    const currentTopology = await this.analyzer.analyzeBoard(boardBuffer, GRIDS.current);
    logger.json('Detected topology (vision)', currentTopology);

    // STEP 3: Compare and build rotation plan
    this.logTopologyComparison(currentTopology);
    const plan = buildRotationPlan(currentTopology);
    logger.json('Rotation plan', plan);

    const totalRotations = Object.values(plan).reduce((sum, n) => sum + n, 0);
    logger.log(`Total rotations needed: ${totalRotations}`);

    if (totalRotations === 0) {
      logger.log('Plan has 0 rotations — board may already be in target state.', 'WARN');
      logger.log('This can happen if VisionAgent correctly identified all cells match.');
      logger.log('If incorrect, check cell crops for vision errors.');
      return null;
    }

    // STEP 4: Execute rotations — check every response for the flag
    return await this.executeRotations(plan);
  }

  private async executeRotations(plan: RotPlan): Promise<string | null> {
    logger.section('Executing Rotations');
    for (const [cell, rotations] of Object.entries(plan)) {
      if (rotations === 0) continue;
      logger.log(`Rotating ${cell} × ${rotations}...`);

      for (let i = 0; i < rotations; i++) {
        const response = await this.hub.rotateCell(cell);
        const flag = this.hub.extractFlag(response);
        if (flag) {
          logger.log(`Flag received on rotation ${i + 1}/${rotations} of ${cell}!`, 'SUCCESS');
          return flag;
        }
        if (i < rotations - 1) {
          await this.sleep(CONFIG.rotationDelayMs);
        }
      }

      await this.sleep(CONFIG.rotationDelayMs);
    }

    return null;
  }

  /**
   * Log a side-by-side comparison of current vs target topology.
   * This makes it easy to see at a glance which cells vision got right/wrong.
   */
  private logTopologyComparison(current: BoardTopology): void {
    const cells = ['1x1','1x2','1x3','2x1','2x2','2x3','3x1','3x2','3x3'];
    const header = 'Cell | Current (vision)   | Target (expected)  | Match';
    const separator = '─'.repeat(header.length);
    const lines: string[] = [separator, header, separator];

    for (const cell of cells) {
      const cur = current[cell];
      const tgt = TARGET_TOPOLOGY[cell];

      if (!cur) {
        lines.push(`${cell}  | (analysis failed)  | (see target)       | ✗`);
        continue;
      }

      const fmt = (t: CellTopology) =>
        [t.top?'T':'_', t.right?'R':'_', t.bottom?'B':'_', t.left?'L':'_'].join('');

      const curStr = fmt(cur);
      const tgtStr = fmt(tgt);
      const match  = topologiesMatch(cur, tgt) ? '✓' : '✗';
      lines.push(`${cell}  | ${curStr.padEnd(18)} | ${tgtStr.padEnd(18)} | ${match}`);
    }

    lines.push(separator);
    logger.log('Topology comparison:\n' + lines.join('\n'));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ============================================================
// Entry Point
// ============================================================

async function main(): Promise<void> {
  if (!CONFIG.aiDevsApiKey)  throw new Error('AI_DEVS_API_KEY not set in .env');
  if (!CONFIG.openrouterKey) throw new Error('OPENROUTER_API_KEY not set in .env');

  logger.init();
  await new OrchestratorAgent().solve();
}

main().catch(err => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.log(`FATAL: ${msg}`, 'ERROR');
  process.exit(1);
});
