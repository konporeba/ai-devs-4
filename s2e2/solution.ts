/**
 * ============================================================
 * AI Devs 4 - S2E2: Electricity Puzzle Solver (v8)
 * ============================================================
 *
 * KEY LESSON LEARNED (from v4-v7 failures):
 * Vision AI models are unreliable for precise binary edge detection
 * in small cable connector images. Pixel-level analysis is more
 * appropriate for this task (determining which edges have dark
 * cable pixels). As the task hint states: "delegate image
 * description to an appropriate tool or subagent."
 * Here, the "tool" is deterministic pixel sampling.
 *
 * BREAKTHROUGH DISCOVERY:
 * Pixel edge analysis revealed the target topology was WRONG in
 * the hard-coded version (Gemini's verbal description was incorrect
 * for 5 out of 9 cells). The correct topology was found by sampling
 * pixels at depths 5-20px from each cell edge.
 *
 * CORRECT TARGET TOPOLOGY (verified via pixel analysis + circuit trace):
 *   1x1: right+bottom         | Source: external source → 3x1 left
 *   1x2: right+bottom+left    | Outputs: external plants ← 1x3 right
 *   1x3: right+left           |                          ← 2x3 right
 *   2x1: top+bottom           |                          ← 3x3 right
 *   2x2: top+right+bottom     | All 9 cells form a valid connected circuit.
 *   2x3: right+bottom+left    |
 *   3x1: top+right+left (source!)
 *   3x2: top+left
 *   3x3: top+right
 *
 * ARCHITECTURE (v8):
 *   1. PixelAnalyzer: deterministic edge detection using jimp
 *      - Samples pixels at depth 5-20px from each cell edge
 *      - Cable pixels are dark (r,g,b < 100)
 *      - Connected if >20% of sampled pixels are dark
 *   2. buildRotationPlan(): pure math, no AI
 *   3. HubClient: apply rotations, check for flag
 *
 * After board reset, only 7 rotations are needed from initial state:
 *   1x2:×1, 1x3:×1, 2x1:×1, 2x2:×3, 3x1:×1
 */

import * as fs from 'fs';
import { Jimp } from 'jimp';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================
// Configuration
// ============================================================

const CONFIG = {
  aiDevsApiKey: process.env.AI_DEVS_API_KEY ?? '',
  hubUrl:       'https://hub.ag3nts.org',
  taskName:     'electricity',
  logFile:      'solution.log',
  resetBoard:   true,
  // Maximum solve attempts (in case pixel analysis has edge cases)
  maxAttempts:  3,
  rotationDelayMs: 400,
} as const;

// ============================================================
// Types
// ============================================================

type CellId = string;
type RotPlan = Record<CellId, number>;

interface CellTopology {
  top:    boolean;
  right:  boolean;
  bottom: boolean;
  left:   boolean;
}
type BoardTopology = Record<CellId, CellTopology>;

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
    this.log('=== Session started ===');
  },
  log(msg: string, level: 'INFO'|'WARN'|'ERROR'|'SUCCESS' = 'INFO'): void {
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
 * CORRECT target topology, verified by:
 * 1. Pixel edge analysis of the solved_electricity.png image
 * 2. Circuit consistency check (all 9 cell-to-cell connections match)
 * 3. Valid circuit from source (3x1 left) to three plants (1x3/2x3/3x3 right)
 *
 * Gemini's verbal analysis was WRONG for cells 1x3, 2x3, 3x1, 3x2, 3x3.
 * Pixel sampling at depth 5-20px from edges gives the correct result.
 */
const TARGET_TOPOLOGY: BoardTopology = {
  '1x1': { top: false, right: true,  bottom: true,  left: false }, // RB
  '1x2': { top: false, right: true,  bottom: true,  left: true  }, // RBL
  '1x3': { top: false, right: true,  bottom: false, left: true  }, // RL (right→plant)
  '2x1': { top: true,  right: false, bottom: true,  left: false }, // TB
  '2x2': { top: true,  right: true,  bottom: true,  left: false }, // TRB
  '2x3': { top: false, right: true,  bottom: true,  left: true  }, // RBL (right→plant)
  '3x1': { top: true,  right: true,  bottom: false, left: true  }, // TRL (left←source)
  '3x2': { top: true,  right: false, bottom: false, left: true  }, // TL
  '3x3': { top: true,  right: true,  bottom: false, left: false }, // TR (right→plant)
};

// ============================================================
// Grid Pixel Boundaries
// ============================================================

/**
 * Pixel boundaries of the 3×3 grid within each board image.
 * Verified by pixel darkness analysis (finding dark separator lines).
 *
 * CURRENT BOARD (800×450px): grid is center of image
 * TARGET BOARD (598×422px): grid is center of solved_electricity.png
 */
const GRIDS = {
  current: { col: [237, 331, 427, 522], row: [98,  195, 290, 383] },
  target:  { col: [141, 236, 330, 425], row: [88,  185, 280, 373] },
};

// ============================================================
// Pixel Analyzer — deterministic cable topology detection
// ============================================================

/**
 * Detects whether a cable exits through each edge of a cell.
 *
 * ALGORITHM:
 *   For each edge (top/right/bottom/left):
 *   1. Sample a strip of pixels running parallel to the edge
 *      at depths 5, 8, 12, 15, 18, 20 pixels in from the edge
 *   2. For each depth, sample 5 pixels centered on the cell's midpoint
 *   3. Count how many pixels are "dark" (rgb all < 100 = cable color)
 *   4. If > 20% of total samples are dark → cable exits through this edge
 *
 * WHY THIS WORKS:
 *   - Border lines between cells are at the very edge (depth 0-3px)
 *   - By starting at depth 5, we skip the border line
 *   - Cable connectors extend from center to edge with thick dark pixels
 *   - Background is light-colored, cables are dark
 *   - The 100% vs 0% dark ratios observed confirm clean signal
 */
class PixelAnalyzer {
  private readonly SAMPLE_DEPTHS = [5, 8, 12, 15, 18, 20];
  private readonly DARK_THRESHOLD = 100;   // rgb all below this = dark pixel
  private readonly CABLE_THRESHOLD = 0.20; // 20%+ dark = cable present

  async analyzeBoard(
    imageBuffer: Buffer,
    grid: typeof GRIDS.current,
  ): Promise<BoardTopology> {
    // Use any to avoid jimp's conflicting generic type exports
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img: any = await Jimp.fromBuffer(imageBuffer);
    const iw: number = img.width;
    const ih: number = img.height;
    const board: BoardTopology = {} as BoardTopology;

    for (let r = 1; r <= 3; r++) {
      for (let c = 1; c <= 3; c++) {
        const cell = `${r}x${c}`;
        const x = grid.col[c - 1];
        const y = grid.row[r - 1];
        const w = grid.col[c] - x;
        const h = grid.row[r] - y;
        board[cell] = this.analyzeCell(img, iw, ih, x, y, w, h);
      }
    }

    return board;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private analyzeCell(img: any, iw: number, ih: number, cx: number, cy: number, w: number, h: number): CellTopology {
    const midX = cx + Math.floor(w / 2);
    const midY = cy + Math.floor(h / 2);

    const sample = (edge: 'top'|'bottom'|'left'|'right'): boolean => {
      let dark = 0, total = 0;
      for (const depth of this.SAMPLE_DEPTHS) {
        for (let off = -2; off <= 2; off++) {
          let px: number, py: number;
          switch (edge) {
            case 'top':    px = midX + off; py = cy + depth;         break;
            case 'bottom': px = midX + off; py = cy + h - 1 - depth; break;
            case 'left':   px = cx + depth; py = midY + off;         break;
            case 'right':  px = cx + w - 1 - depth; py = midY + off; break;
          }
          if (px < 0 || px >= iw || py < 0 || py >= ih) continue;
          const color: number = img.getPixelColor(px, py);
          const r = (color >> 24) & 0xff;
          const g = (color >> 16) & 0xff;
          const b = (color >>  8) & 0xff;
          if (r < this.DARK_THRESHOLD && g < this.DARK_THRESHOLD && b < this.DARK_THRESHOLD) dark++;
          total++;
        }
      }
      return total > 0 && (dark / total) >= this.CABLE_THRESHOLD;
    };

    return { top: sample('top'), right: sample('right'), bottom: sample('bottom'), left: sample('left') };
  }
}

// ============================================================
// Rotation Math
// ============================================================

function rotateCWOnce(t: CellTopology): CellTopology {
  return { top: t.left, right: t.top, bottom: t.right, left: t.bottom };
}

function topologiesMatch(a: CellTopology, b: CellTopology): boolean {
  return a.top === b.top && a.right === b.right &&
         a.bottom === b.bottom && a.left === b.left;
}

/** Compute CW rotations (0-3) to bring current → target topology. */
function computeCellRotations(current: CellTopology, target: CellTopology, cellId: CellId): number {
  let t = { ...current };
  for (let i = 0; i < 4; i++) {
    if (topologiesMatch(t, target)) return i;
    t = rotateCWOnce(t);
  }
  logger.log(
    `[${cellId}] Incompatible topology — Current=${JSON.stringify(current)}, ` +
    `Target=${JSON.stringify(target)}`,
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
// HubClient
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
        apikey: this.key, task: this.task, answer: { rotate: cell },
      }),
    });
    const data = await res.json() as ApiResponse;
    logger.log(`→ rotate ${cell}: ${JSON.stringify(data)}`);
    return data;
  }

  extractFlag(response: ApiResponse): string | null {
    const text = JSON.stringify(response);
    const m1 = text.match(/\{FLG:[^}]+\}/);
    if (m1) return m1[0];
    const m2 = text.match(/FLG:[A-Za-z0-9_=+/.-]+/);
    if (m2) return m2[0];
    if (response.code === 0 && response.message && response.message !== 'Done') {
      return response.message;
    }
    return null;
  }
}

// ============================================================
// OrchestratorAgent
// ============================================================

/**
 * OrchestratorAgent — deterministic pixel-based solver
 *
 * LESSON PRINCIPLE: "Use the right tool for the right job."
 *   - AI: good for understanding context, generating plans, natural language
 *   - Pixel analysis: perfect for precise binary edge detection
 *   The task says to "delegate image description to an appropriate tool."
 *   Here the "tool" is PixelAnalyzer — fast, deterministic, correct.
 *
 * FLOW:
 *  1. Reset board → known initial state
 *  2. Download current board image
 *  3. PixelAnalyzer: detect cable topology for all 9 cells
 *  4. buildRotationPlan(current, TARGET_TOPOLOGY) → 0-3 per cell
 *  5. Execute rotations → check for flag
 *  6. If no flag, re-read and retry (in case of topology detection error)
 */
class OrchestratorAgent {
  private readonly hub      = new HubClient();
  private readonly analyzer = new PixelAnalyzer();

  async solve(): Promise<void> {
    logger.section('ELECTRICITY PUZZLE SOLVER (v8 — Pixel Analysis)');
    logger.json('Target topology', TARGET_TOPOLOGY);

    if (CONFIG.resetBoard) {
      logger.section('Reset');
      await this.hub.resetBoard();
      await this.sleep(1500);
    }

    let flag: string | null = null;

    for (let attempt = 1; attempt <= CONFIG.maxAttempts && !flag; attempt++) {
      logger.section(`Attempt ${attempt}/${CONFIG.maxAttempts}`);

      const currentBuf = await this.hub.downloadCurrentBoard();
      fs.writeFileSync(`current_board_attempt${attempt}.png`, currentBuf);

      // Pixel-based topology detection
      logger.log('Analyzing topology via pixel sampling...');
      const currentTopology = await this.analyzer.analyzeBoard(currentBuf, GRIDS.current);
      logger.json('Current topology', currentTopology);

      // Save comparison to verify
      this.logTopologyComparison(currentTopology);

      const plan = buildRotationPlan(currentTopology);
      logger.json('Rotation plan', plan);

      const total = Object.values(plan).reduce((s, n) => s + n, 0);
      logger.log(`Total rotations needed: ${total}`);

      if (total === 0) {
        logger.log('Plan is all zeros — board should match target.', 'WARN');
        // If we're here and no flag, the pixel analysis might be off.
        // Try rotating 2x2 by 4 (noop) won't work, so just retry.
        await this.sleep(2000);
        continue;
      }

      flag = await this.executeRotations(plan);

      if (!flag) {
        logger.log('No flag. Re-reading for next attempt.', 'WARN');
        await this.sleep(1000);
      }
    }

    logger.section('Result');
    if (flag) {
      logger.log(`SUCCESS! Flag: ${flag}`, 'SUCCESS');
    } else {
      logger.log('No flag received.', 'ERROR');
    }
  }

  private logTopologyComparison(current: BoardTopology): void {
    const cells = ['1x1','1x2','1x3','2x1','2x2','2x3','3x1','3x2','3x3'];
    const lines: string[] = ['Cell  | Current         | Target          | Match'];
    for (const cell of cells) {
      const cur = current[cell];
      const tgt = TARGET_TOPOLOGY[cell];
      const curStr = [cur.top?'T':'', cur.right?'R':'', cur.bottom?'B':'', cur.left?'L':''].filter(x=>x).join('')||'none';
      const tgtStr = [tgt.top?'T':'', tgt.right?'R':'', tgt.bottom?'B':'', tgt.left?'L':''].filter(x=>x).join('')||'none';
      const match  = topologiesMatch(cur, tgt) ? '✓' : '✗';
      lines.push(`${cell}   | ${curStr.padEnd(15)} | ${tgtStr.padEnd(15)} | ${match}`);
    }
    logger.log('Topology comparison:\n' + lines.join('\n'));
  }

  private async executeRotations(plan: RotPlan): Promise<string | null> {
    logger.section('Executing Rotations');
    for (const [cell, rotations] of Object.entries(plan)) {
      if (rotations === 0) continue;
      logger.log(`Rotating ${cell} × ${rotations}...`);
      for (let i = 0; i < rotations; i++) {
        const res  = await this.hub.rotateCell(cell);
        const flag = this.hub.extractFlag(res);
        if (flag) return flag;
        await this.sleep(CONFIG.rotationDelayMs);
      }
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ============================================================
// Entry Point
// ============================================================

async function main(): Promise<void> {
  if (!CONFIG.aiDevsApiKey) throw new Error('AI_DEVS_API_KEY not set in .env');

  logger.init();
  await new OrchestratorAgent().solve();
}

main().catch(err => {
  const m = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.log(`FATAL: ${m}`, 'ERROR');
  process.exit(1);
});
