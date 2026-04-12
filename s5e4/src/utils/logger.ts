import * as fs from "fs";
import * as path from "path";

// ─── Log file location ────────────────────────────────────────────────────────
const LOG_FILE = path.resolve(__dirname, "../../game.log");

// ─── ANSI color codes for terminal output ─────────────────────────────────────
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  // Severity levels
  info: "\x1b[36m",    // Cyan
  success: "\x1b[32m", // Green
  warn: "\x1b[33m",    // Yellow
  error: "\x1b[31m",   // Red
  // Context colors
  section: "\x1b[35m", // Magenta — for major section headers
  api: "\x1b[34m",     // Blue — for API calls
  llm: "\x1b[33m",     // Yellow — for LLM interactions
  game: "\x1b[36m",    // Cyan — for game state events
  radar: "\x1b[31m",   // Red — for radar events
  scout: "\x1b[32m",   // Green — for scout/hint events
  move: "\x1b[35m",    // Magenta — for movement decisions
} as const;

type LogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR";
type LogCategory = "GAME" | "API" | "LLM" | "RADAR" | "SCOUT" | "MOVE" | "SYSTEM";

function timestamp(): string {
  return new Date().toISOString();
}

function formatLine(level: LogLevel, category: LogCategory, message: string): string {
  return `[${timestamp()}] [${level.padEnd(7)}] [${category.padEnd(6)}] ${message}`;
}

function colorizeLevel(level: LogLevel): string {
  switch (level) {
    case "INFO":    return `${COLORS.info}INFO   ${COLORS.reset}`;
    case "SUCCESS": return `${COLORS.success}SUCCESS${COLORS.reset}`;
    case "WARN":    return `${COLORS.warn}WARN   ${COLORS.reset}`;
    case "ERROR":   return `${COLORS.error}ERROR  ${COLORS.reset}`;
  }
}

function colorizeCategory(category: LogCategory): string {
  switch (category) {
    case "GAME":   return `${COLORS.game}GAME  ${COLORS.reset}`;
    case "API":    return `${COLORS.api}API   ${COLORS.reset}`;
    case "LLM":    return `${COLORS.llm}LLM   ${COLORS.reset}`;
    case "RADAR":  return `${COLORS.radar}RADAR ${COLORS.reset}`;
    case "SCOUT":  return `${COLORS.scout}SCOUT ${COLORS.reset}`;
    case "MOVE":   return `${COLORS.move}MOVE  ${COLORS.reset}`;
    case "SYSTEM": return `${COLORS.dim}SYSTEM${COLORS.reset}`;
  }
}

function writeToFile(line: string): void {
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    // Silently ignore file write errors — terminal output is still visible
  }
}

function log(level: LogLevel, category: LogCategory, message: string): void {
  const plainLine = formatLine(level, category, message);
  const coloredLine = `[${COLORS.dim}${timestamp()}${COLORS.reset}] [${colorizeLevel(level)}] [${colorizeCategory(category)}] ${message}`;

  // Write plain text to file (no ANSI codes)
  writeToFile(plainLine);
  // Write colored output to terminal
  console.log(coloredLine);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const logger = {
  // ── Generic levels ──────────────────────────────────────────────────────────
  info(category: LogCategory, message: string): void {
    log("INFO", category, message);
  },
  success(category: LogCategory, message: string): void {
    log("SUCCESS", category, message);
  },
  warn(category: LogCategory, message: string): void {
    log("WARN", category, message);
  },
  error(category: LogCategory, message: string): void {
    log("ERROR", category, message);
  },

  // ── Structured helpers ───────────────────────────────────────────────────────

  /** Print a bold section separator to terminal and file */
  section(title: string): void {
    const line = "─".repeat(70);
    const plainHeader = `\n${line}\n  ${title}\n${line}`;
    const coloredHeader = `\n${COLORS.section}${COLORS.bold}${line}\n  ${title}\n${line}${COLORS.reset}`;
    writeToFile(plainHeader);
    console.log(coloredHeader);
  },

  /** Log an API request */
  apiRequest(method: string, url: string, body?: unknown): void {
    log("INFO", "API", `${method} ${url}`);
    if (body !== undefined) {
      log("INFO", "API", `  Request body: ${JSON.stringify(body)}`);
    }
  },

  /** Log an API response */
  apiResponse(status: number, url: string, body: unknown, retryCount = 0): void {
    const retryNote = retryCount > 0 ? ` [retry #${retryCount}]` : "";
    log("INFO", "API", `  Response ${status} from ${url}${retryNote}`);
    log("INFO", "API", `  Response body: ${JSON.stringify(body)}`);
  },

  /** Log an API retry event */
  apiRetry(attempt: number, maxAttempts: number, error: string, delayMs: number): void {
    log("WARN", "API", `  Retry ${attempt}/${maxAttempts} after ${delayMs}ms — reason: ${error}`);
  },

  /** Log the full LLM prompt being sent */
  llmPrompt(model: string, messages: Array<{ role: string; content: string }>): void {
    log("INFO", "LLM", `Calling model: ${model}`);
    for (const msg of messages) {
      log("INFO", "LLM", `  [${msg.role.toUpperCase()}]: ${msg.content}`);
    }
  },

  /** Log the raw LLM response */
  llmResponse(model: string, response: string): void {
    log("INFO", "LLM", `  [ASSISTANT] (${model}): ${response}`);
  },

  /** Log the game position state */
  gameState(attemptNum: number, tickNum: number, col: number, row: number, targetRow: number): void {
    log("INFO", "GAME", `Attempt #${attemptNum} | Tick #${tickNum} | Position: col=${col}, row=${row} | Target row: ${targetRow}`);
  },

  /** Log radar scan result */
  radarClear(): void {
    log("INFO", "RADAR", "  Scanner: IT'S CLEAR — no radar detected");
  },

  /** Log corrupted radar data */
  radarCorrupted(rawData: string): void {
    log("WARN", "RADAR", `  Scanner returned corrupted/unexpected data: ${rawData.substring(0, 200)}...`);
  },

  /** Log radar detection */
  radarDetected(frequency: number, detectionCode: string): void {
    log("WARN", "RADAR", `  RADAR DETECTED! frequency=${frequency}, detectionCode=${detectionCode}`);
  },

  /** Log SHA1 computation */
  radarHash(input: string, hash: string): void {
    log("INFO", "RADAR", `  SHA1 input: "${input}" → hash: ${hash}`);
  },

  /** Log disarm result */
  radarDisarmed(success: boolean): void {
    if (success) {
      log("SUCCESS", "RADAR", "  Radar DISARMED successfully");
    } else {
      log("ERROR", "RADAR", "  Radar disarm FAILED");
    }
  },

  /** Log raw radio hint */
  scoutHint(raw: string): void {
    log("INFO", "SCOUT", `  Raw hint: "${raw}"`);
  },

  /** Log interpreted rock direction */
  scoutDirection(direction: string): void {
    log("SUCCESS", "SCOUT", `  Interpreted rock direction: ${direction.toUpperCase()}`);
  },

  /** Log the chosen movement command */
  moveDecision(command: string, reason: string): void {
    log("INFO", "MOVE", `  Command chosen: ${command.toUpperCase()} — ${reason}`);
  },

  /** Log game won */
  gameWon(flag: string, attempt: number, ticks: number): void {
    log("SUCCESS", "GAME", `FLAG OBTAINED after ${ticks} ticks on attempt #${attempt}: ${flag}`);
  },

  /** Log game crashed */
  gameCrashed(reason: string, attempt: number, ticks: number): void {
    log("WARN", "GAME", `CRASHED on attempt #${attempt} after ${ticks} ticks — ${reason}. Restarting...`);
  },

  /** Initialize a fresh log file session */
  initSession(): void {
    const header = `\n${"═".repeat(70)}\n  SESSION START: ${timestamp()}\n${"═".repeat(70)}`;
    writeToFile(header);
    console.log(`${COLORS.bold}${COLORS.section}${header}${COLORS.reset}`);
    log("INFO", "SYSTEM", `Log file: ${LOG_FILE}`);
  },
};
