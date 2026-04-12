import { sendGameCommand } from "../services/apiClient";
import { runRadarCheck } from "./radarAgent";
import { runScoutCheck } from "./scoutAgent";
import { chooseMoveCommand } from "../utils/decisionMaker";
import { logger } from "../utils/logger";
import { config } from "../config";
import { Position, GameOutcome } from "../types";

// ─── Response parsers ──────────────────────────────────────────────────────────

/**
 * Parses the `start` command response to extract:
 *   - The rocket's starting position (always col=1, row=2 per spec)
 *   - The target row in column 12 (Grudziądz base)
 *
 * The API response format is not strictly documented, so we inspect all fields
 * and apply heuristics. The target row is the most important value to capture.
 */
/** Converts a scout rock direction to the absolute stone row in that column. */
function stoneRowFromDirection(currentRow: number, direction: import("../types").RockDirection): number {
  switch (direction) {
    case "left":  return currentRow - 1;
    case "right": return currentRow + 1;
    case "front": return currentRow;
  }
}

function parseStartResponse(data: unknown): {
  startPosition: Position;
  targetRow: number;
  /** Stone row in column 1 (from currentColumn.stoneRow). Used by the decision maker
   *  to avoid lateral moves that pass through the current column's rock. */
  currentColStoneRow: number | null;
} {
  logger.info("GAME", `Parsing start response: ${JSON.stringify(data)}`);

  const startPosition: Position = {
    col: config.startCol, // Always column 1
    row: config.startRow, // Always row 2
  };

  // The target row is embedded somewhere in the response.
  // From live API testing, the response shape is:
  //   { player: { row, col }, base: { row, col }, ... }
  // We always prefer `base.row` as the authoritative target.
  // Explicit `number` type prevents TypeScript from inferring literal `2` from the `as const` config.
  let targetRow: number = config.startRow; // Safe default

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;

    // Priority 1: Look specifically for a "base" object with a "row" field.
    // This is the most reliable indicator of the target position.
    const baseKeys = ["base", "target", "destination", "goal", "end"];
    for (const key of baseKeys) {
      if (typeof obj[key] === "object" && obj[key] !== null) {
        const nested = obj[key] as Record<string, unknown>;
        if (typeof nested.row === "number" && nested.row >= 1 && nested.row <= config.gridRows) {
          targetRow = nested.row;
          logger.info("GAME", `Found target row from key "${key}.row": ${targetRow}`);
          break;
        }
      }
    }

    // Priority 2: Try top-level numeric fields named "target", "targetRow", etc.
    if (targetRow === config.startRow) {
      const candidates = [obj.targetRow, obj.target, obj.destination, obj.end, obj.goal];
      for (const candidate of candidates) {
        if (typeof candidate === "number" && candidate >= 1 && candidate <= config.gridRows) {
          targetRow = candidate;
          logger.info("GAME", `Found target row from top-level numeric field: ${targetRow}`);
          break;
        }
      }
    }

    // Priority 3: Scan ALL nested objects for a "row" field — but SKIP "player"
    // since player.row is the START position, not the target.
    if (targetRow === config.startRow) {
      for (const [key, value] of Object.entries(obj)) {
        if (key === "player" || key === "currentColumn") continue; // Skip start-position fields
        if (typeof value === "object" && value !== null) {
          const nested = value as Record<string, unknown>;
          if (typeof nested.row === "number" && nested.row >= 1 && nested.row <= config.gridRows) {
            targetRow = nested.row;
            logger.info("GAME", `Found target row in nested key "${key}": ${targetRow}`);
            break;
          }
        }
      }
    }
  }

  // Extract the stone row in column 1 (currentColumn) from the start response.
  // The decision maker needs this to avoid moving through the current column's stone.
  let currentColStoneRow: number | null = null;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.currentColumn === "object" && obj.currentColumn !== null) {
      const cc = obj.currentColumn as Record<string, unknown>;
      if (typeof cc.stoneRow === "number" && cc.stoneRow >= 1 && cc.stoneRow <= config.gridRows) {
        currentColStoneRow = cc.stoneRow;
        logger.info("GAME", `Current column stone at row: ${currentColStoneRow}`);
      }
    }
  }

  logger.info("GAME", `Start position: col=${startPosition.col}, row=${startPosition.row}`);
  logger.info("GAME", `Target: col=${config.gridCols}, row=${targetRow}`);

  return { startPosition, targetRow, currentColStoneRow };
}

/**
 * Inspects a move command response to determine if:
 *   - The rocket crashed (hit a rock or went out of bounds)
 *   - The rocket reached the target (flag obtained)
 *   - The move was successful (continue game loop)
 *
 * Also extracts the flag if present, and tries to derive the new position
 * from the response (though we track position ourselves as a primary source).
 */
function parseMoveResponse(
  data: unknown,
  expectedNewPosition: Position
): {
  crashed: boolean;
  won: boolean;
  flag?: string;
  newPosition: Position;
  /** Stone row in the column we just entered, from the server's currentColumn.stoneRow */
  currentColStoneRow: number | null;
} {
  logger.info("GAME", `Parsing move response: ${JSON.stringify(data)}`);

  if (!data || typeof data !== "object") {
    return { crashed: false, won: false, newPosition: expectedNewPosition, currentColStoneRow: null };
  }

  const obj = data as Record<string, unknown>;
  const responseStr = JSON.stringify(obj).toLowerCase();
  const message = (typeof obj.message === "string" ? obj.message : "").toLowerCase();

  // ── Check for crash ──────────────────────────────────────────────────────
  // We use ONLY message-based detection because the server returns non-standard
  // success codes (e.g. code=110 for a valid start). Code-based detection would
  // cause false positives on legitimate moves.
  const crashKeywords = ["crash", "destroy", "hit rock", "hit a rock", "rozbił", "uderzył", "game over", "failed", "explod"];
  const crashed = crashKeywords.some((kw) => message.includes(kw));

  // ── Check for win / flag ─────────────────────────────────────────────────
  // The server embeds the flag in the message when the rocket reaches Grudziądz.
  // Flag format from AI Devs tasks is typically {{FLAG_VALUE}} or a plain string in the message.
  const rawJson = JSON.stringify(obj);
  const winKeywords = ["flag", "{{", "congratulation", "winner", "grudziądz", "grudziadz", "reach", "arrived"];
  const won = winKeywords.some((kw) => responseStr.includes(kw));

  // Try to extract the flag (format: {{FLAG_VALUE}})
  let flag: string | undefined;
  if (won) {
    const flagMatch = rawJson.match(/\{\{([^}]+)\}\}/);
    if (flagMatch) {
      flag = `{{${flagMatch[1]}}}`;
    } else {
      // Try a "flag" field in the response JSON
      const tokenMatch = rawJson.match(/"flag"\s*:\s*"([^"]+)"/i);
      if (tokenMatch) {
        flag = tokenMatch[1];
      } else {
        // Return the full message — it contains the flag as human-readable text
        flag = typeof obj.message === "string" ? obj.message : rawJson;
      }
    }
  }

  // ── Extract stone row in the column we just entered ─────────────────────
  // The server always returns currentColumn.stoneRow — use it as the
  // authoritative current-column stone position for the next tick.
  let currentColStoneRow: number | null = null;
  if (typeof obj.currentColumn === "object" && obj.currentColumn !== null) {
    const cc = obj.currentColumn as Record<string, unknown>;
    if (typeof cc.stoneRow === "number" && cc.stoneRow >= 1 && cc.stoneRow <= config.gridRows) {
      currentColStoneRow = cc.stoneRow;
      logger.info("GAME", `Server reports current column stone at row: ${currentColStoneRow}`);
    }
  }

  return {
    crashed,
    won,
    flag,
    newPosition: expectedNewPosition,
    currentColStoneRow,
  };
}

// ─── Single game attempt ──────────────────────────────────────────────────────

/**
 * Runs one complete game attempt from start to either crash or win.
 *
 * Flow per tick:
 *   1. Check radar (Radar Agent) — disarm if needed
 *   2. Get radio hint (Scout Agent) — determine rock direction
 *   3. Choose move (Decision Maker) — optimal safe command
 *   4. Execute move (API) — send command, parse response
 *   5. Update position — continue or exit
 */
async function runSingleAttempt(attemptNumber: number): Promise<GameOutcome> {
  logger.section(`ATTEMPT #${attemptNumber} — Starting new game`);

  // ── Start the game ─────────────────────────────────────────────────────────
  const startData = await sendGameCommand("start");
  const { startPosition, targetRow, currentColStoneRow: initialStoneRow } = parseStartResponse(startData);

  let currentPosition: Position = { ...startPosition };
  // Tracks the stone row in the column the rocket is currently occupying.
  // Initialised from currentColumn.stoneRow (column 1) in the start response.
  // Updated each tick: after a move, the new current column's stone = the stone
  // from the previous scout hint (the column we just entered).
  let currentColStoneRow: number | null = initialStoneRow;
  let tickNumber = 0;

  // ── Game loop: run until column 12 or crash ────────────────────────────────
  while (currentPosition.col < config.gridCols) {
    tickNumber++;
    logger.section(`Attempt #${attemptNumber} | Tick #${tickNumber}`);
    logger.gameState(attemptNumber, tickNumber, currentPosition.col, currentPosition.row, targetRow);

    // Step 1: Radar check (must happen before every move)
    let radarResult;
    try {
      radarResult = await runRadarCheck();
    } catch (err) {
      logger.error("RADAR", `Radar check threw an error: ${err}`);
      // Treat as a critical failure for this tick — log and crash out
      return {
        status: "crashed",
        reason: `Radar check error: ${err}`,
        attemptNumber,
        totalTicks: tickNumber,
      };
    }

    // If radar was detected but disarm failed, do NOT move — crash out safely
    if (!radarResult.isClear && !radarResult.wasDisarmed) {
      logger.error("RADAR", "Radar detected but disarm failed — aborting this attempt to avoid being shot down");
      return {
        status: "crashed",
        reason: "Radar disarm failed",
        attemptNumber,
        totalTicks: tickNumber,
      };
    }

    // Step 2: Scout — get radio hint about rock in next column
    let scoutResult;
    try {
      scoutResult = await runScoutCheck();
    } catch (err) {
      logger.error("SCOUT", `Scout check threw an error: ${err}`);
      return {
        status: "crashed",
        reason: `Scout check error: ${err}`,
        attemptNumber,
        totalTicks: tickNumber,
      };
    }

    // Step 3: Decision — choose optimal safe move
    // Calculate next column's stone row before the move so we can update
    // currentColStoneRow afterwards (it becomes the current column stone for tick+1).
    const nextColStoneRow = stoneRowFromDirection(currentPosition.row, scoutResult.rockDirection);

    let command;
    try {
      command = chooseMoveCommand(currentPosition, scoutResult.rockDirection, targetRow, currentColStoneRow);
    } catch (err) {
      logger.error("MOVE", `Decision maker threw an error: ${err}`);
      return {
        status: "crashed",
        reason: `Decision maker error: ${err}`,
        attemptNumber,
        totalTicks: tickNumber,
      };
    }

    // Step 4: Execute the move
    // Compute where we expect to be after this move (for position tracking)
    const expectedNewCol = currentPosition.col + 1;
    const expectedNewRow =
      command === "go"
        ? currentPosition.row
        : command === "left"
        ? currentPosition.row - 1
        : currentPosition.row + 1;
    const expectedNewPosition: Position = { col: expectedNewCol, row: expectedNewRow };

    let moveData;
    try {
      moveData = await sendGameCommand(command);
    } catch (err) {
      logger.error("GAME", `Move command failed: ${err}`);
      return {
        status: "crashed",
        reason: `Move API error: ${err}`,
        attemptNumber,
        totalTicks: tickNumber,
      };
    }

    // Step 5: Parse response
    const { crashed, won, flag, newPosition, currentColStoneRow: serverStoneRow } = parseMoveResponse(moveData, expectedNewPosition);

    // ── Won! ────────────────────────────────────────────────────────────────
    if (won) {
      logger.gameWon(flag ?? "unknown", attemptNumber, tickNumber);
      return {
        status: "won",
        flag: flag ?? JSON.stringify(moveData),
        attemptNumber,
        totalTicks: tickNumber,
      };
    }

    // ── Crashed ─────────────────────────────────────────────────────────────
    if (crashed) {
      const reason = typeof (moveData as Record<string, unknown>).message === "string"
        ? (moveData as Record<string, unknown>).message as string
        : JSON.stringify(moveData);
      logger.gameCrashed(reason, attemptNumber, tickNumber);
      return {
        status: "crashed",
        reason,
        attemptNumber,
        totalTicks: tickNumber,
      };
    }

    // ── Also check if we've reached the final column ────────────────────────
    // Some APIs signal a win via the position rather than a crash/win flag
    currentPosition = newPosition;
    // Use the server-reported stone row for the column we just entered.
    // Fall back to the scout-inferred value only if the server omits it.
    currentColStoneRow = serverStoneRow ?? nextColStoneRow;

    if (currentPosition.col >= config.gridCols) {
      // We've arrived at column 12 — check if the response has a flag
      const fullResponse = JSON.stringify(moveData);
      const flagMatch = fullResponse.match(/\{\{([^}]+)\}\}/);
      const finalFlag = flagMatch ? `{{${flagMatch[1]}}}` : fullResponse;
      logger.gameWon(finalFlag, attemptNumber, tickNumber);
      return {
        status: "won",
        flag: finalFlag,
        attemptNumber,
        totalTicks: tickNumber,
      };
    }

    logger.info("GAME", `Position updated: col=${currentPosition.col}, row=${currentPosition.row}`);

    // Small pacing delay between ticks to avoid rate-limiting the API
    await new Promise((resolve) => setTimeout(resolve, config.interTickDelayMs));
  }

  // Reached column 12 via the loop (shouldn't normally exit this way, but just in case)
  return {
    status: "crashed",
    reason: "Reached column limit without winning signal",
    attemptNumber,
    totalTicks: tickNumber,
  };
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

/**
 * The Navigation Orchestrator is the top-level coordinator.
 *
 * It runs up to `config.maxGameAttempts` full game attempts, automatically
 * restarting on crash. Returns as soon as the flag is obtained.
 *
 * This design reflects the confirmed decision: auto-restart on crash, with a
 * ceiling of 30 total attempts to prevent infinite loops on persistent failures.
 */
export async function runNavigationSystem(): Promise<void> {
  logger.initSession();
  logger.section("NAVIGATION SYSTEM STARTING");
  logger.info("SYSTEM", `Max attempts: ${config.maxGameAttempts}`);
  logger.info("SYSTEM", `LLM model: ${config.llmModel}`);
  logger.info("SYSTEM", `API retry limit: ${config.apiMaxRetries} per call`);

  for (let attempt = 1; attempt <= config.maxGameAttempts; attempt++) {
    try {
      const outcome = await runSingleAttempt(attempt);

      if (outcome.status === "won") {
        logger.section("MISSION ACCOMPLISHED");
        logger.success("GAME", `Flag: ${outcome.flag}`);
        logger.success("GAME", `Attempts used: ${outcome.attemptNumber} / ${config.maxGameAttempts}`);
        logger.success("GAME", `Ticks on winning run: ${outcome.totalTicks}`);
        console.log(`\n\n${"=".repeat(60)}`);
        console.log(`FLAG: ${outcome.flag}`);
        console.log(`${"=".repeat(60)}\n`);
        return;
      }

      // Crashed — log and loop to next attempt
      logger.warn(
        "GAME",
        `Attempt #${attempt} ended with: ${outcome.status} — ${(outcome as { reason?: string }).reason ?? ""}`
      );

      if (attempt < config.maxGameAttempts) {
        logger.info("GAME", `Starting attempt #${attempt + 1} in ${config.interAttemptDelayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, config.interAttemptDelayMs));
      }
    } catch (err) {
      // Unexpected error in the attempt — log and continue
      logger.error(
        "SYSTEM",
        `Attempt #${attempt} threw an unexpected error: ${err instanceof Error ? err.message : err}`
      );

      if (attempt < config.maxGameAttempts) {
        logger.info("GAME", `Recovering — starting attempt #${attempt + 1} in ${config.interAttemptDelayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, config.interAttemptDelayMs));
      }
    }
  }

  // All attempts exhausted
  logger.section("MISSION FAILED");
  logger.error(
    "SYSTEM",
    `All ${config.maxGameAttempts} game attempts exhausted without obtaining the flag. ` +
      `Review game.log for a full trace of every attempt.`
  );
  process.exit(1);
}
