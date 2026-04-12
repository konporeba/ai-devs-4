import { config } from "../config";
import { logger } from "./logger";
import { MoveCommand, RockDirection, Position } from "../types";

// ─── Grid boundaries ──────────────────────────────────────────────────────────

const MIN_ROW = 1;
const MAX_ROW = config.gridRows; // 3

// ─── Row after move ───────────────────────────────────────────────────────────

/**
 * Computes the row the rocket would be in after executing a command.
 * - "go"    → same row
 * - "left"  → row - 1 (toward row 1 / top)
 * - "right" → row + 1 (toward row 3 / bottom)
 */
function rowAfterMove(currentRow: number, command: MoveCommand): number {
  switch (command) {
    case "go":    return currentRow;
    case "left":  return currentRow - 1;
    case "right": return currentRow + 1;
  }
}

// ─── Rock row in next column ──────────────────────────────────────────────────

/**
 * Converts the Scout Agent's rock direction to an absolute row number.
 *
 * The "direction" is RELATIVE to the rocket:
 * - "left"  → rock is one row above (lower row number)
 * - "right" → rock is one row below (higher row number)
 * - "front" → rock is in the same row
 */
function rockRowInNextColumn(currentRow: number, rockDirection: RockDirection): number {
  switch (rockDirection) {
    case "left":  return currentRow - 1; // rock is above rocket
    case "right": return currentRow + 1; // rock is below rocket
    case "front": return currentRow;     // rock is directly ahead
  }
}

// ─── Candidate move evaluation ────────────────────────────────────────────────

interface MoveCandidate {
  command: MoveCommand;
  resultRow: number;
  distanceToTarget: number;
  isInBounds: boolean;
  hitsNextRock: boolean;
  hitsCurRock: boolean;
}

/**
 * Evaluates all three possible move commands and returns the optimal safe move.
 *
 * Decision priority (in order):
 *   1. Must be in bounds (row 1–3)
 *   2. Must NOT move through the stone in the CURRENT column (lateral moves only)
 *   3. Must NOT land on the rock row in the NEXT column
 *   4. Among safe moves, prefer the one that minimises distance to targetRow
 *   5. Tie-break: prefer "go" (straight) to minimise row changes
 *
 * Why check currentColStoneRow?
 *   The game validates movement through the current column before advancing.
 *   A "left" or "right" command moves the rocket through row±1 of the current
 *   column first. If a stone is there, the server returns HTTP 400 (crash).
 *   "go" is exempt because the rocket stays in its current row (already safe).
 */
export function chooseMoveCommand(
  currentPosition: Position,
  rockDirection: RockDirection,
  targetRow: number,
  currentColStoneRow: number | null = null
): MoveCommand {
  const rockRow = rockRowInNextColumn(currentPosition.row, rockDirection);

  logger.info("MOVE", `Rock in next column is at row ${rockRow} (direction: ${rockDirection})`);
  logger.info("MOVE", `Current col stone at row: ${currentColStoneRow ?? "unknown"} | Current row: ${currentPosition.row} | Target row: ${targetRow}`);

  const allCommands: MoveCommand[] = ["go", "left", "right"];

  // Evaluate every candidate move
  const candidates: MoveCandidate[] = allCommands.map((command) => {
    const resultRow = rowAfterMove(currentPosition.row, command);
    // "go" keeps the same row, which is already in the current column — no lateral collision possible
    const hitsCurRock =
      command !== "go" &&
      currentColStoneRow !== null &&
      resultRow === currentColStoneRow;
    return {
      command,
      resultRow,
      distanceToTarget: Math.abs(resultRow - targetRow),
      isInBounds: resultRow >= MIN_ROW && resultRow <= MAX_ROW,
      hitsNextRock: resultRow === rockRow,
      hitsCurRock,
    };
  });

  // Log all candidates for full observability
  for (const c of candidates) {
    const status = !c.isInBounds
      ? "OUT OF BOUNDS"
      : c.hitsCurRock
      ? "HITS CURRENT COL STONE"
      : c.hitsNextRock
      ? "HITS NEXT COL ROCK"
      : `safe (dist to target: ${c.distanceToTarget})`;
    logger.info("MOVE", `  Candidate "${c.command}" → row ${c.resultRow}: ${status}`);
  }

  // Filter to safe candidates only
  const safeCandidates = candidates.filter((c) => c.isInBounds && !c.hitsNextRock && !c.hitsCurRock);

  if (safeCandidates.length === 0) {
    // This should not happen on a valid 3-row grid with at most 2 constrained rows.
    // Throw so the orchestrator can handle it (restart attempt).
    throw new Error(
      `No safe move exists! Position: row=${currentPosition.row}, col=${currentPosition.col}, ` +
        `next col rock at row=${rockRow}, current col stone at row=${currentColStoneRow}. ` +
        `This indicates a game data inconsistency.`
    );
  }

  // Sort: primary = closest to targetRow; secondary = prefer "go" over row changes
  safeCandidates.sort((a, b) => {
    if (a.distanceToTarget !== b.distanceToTarget) {
      return a.distanceToTarget - b.distanceToTarget; // Closer to target wins
    }
    // Tie-break: "go" has 0 row change cost; left/right have cost 1
    const moveCost = (cmd: MoveCommand) => (cmd === "go" ? 0 : 1);
    return moveCost(a.command) - moveCost(b.command);
  });

  const chosen = safeCandidates[0];
  const reason =
    `moves to row ${chosen.resultRow}, ` +
    `distance to target row (${targetRow}): ${chosen.distanceToTarget}`;

  logger.moveDecision(chosen.command, reason);

  return chosen.command;
}
