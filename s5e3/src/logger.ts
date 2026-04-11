import * as fs from "fs";
import * as path from "path";

// Log file lives at the project root so it is easy to find after a run
const LOG_FILE = path.resolve(__dirname, "..", "agent.log");

type LogLevel = "INFO" | "TOOL" | "RESPONSE" | "AGENT" | "THINK" | "ERROR" | "FINAL";

function timestamp(): string {
  return new Date().toISOString();
}

function formatLine(level: LogLevel, message: string): string {
  return `[${timestamp()}] [${level.padEnd(8)}] ${message}`;
}

/**
 * Appends a line to agent.log and mirrors it to the console.
 * The file is opened in append mode on every write so no data is lost
 * even if the process crashes mid-run.
 */
function write(level: LogLevel, message: string): void {
  const line = formatLine(level, message);

  // Console output — use appropriate severity
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }

  // File output — append so multiple runs accumulate in one log
  fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
}

export const logger = {
  /** General informational message */
  info(message: string): void {
    write("INFO", message);
  },

  /** A shell command sent to the remote server */
  tool(cmd: string): void {
    write("TOOL", `CMD: ${cmd}`);
  },

  /** The raw response received from the server */
  response(text: string): void {
    // Truncate very long responses in the log to avoid bloat,
    // but always keep the first and last 500 chars so context is clear
    const MAX = 1000;
    const preview =
      text.length > MAX
        ? text.slice(0, MAX / 2) + "\n[...truncated...]\n" + text.slice(-MAX / 2)
        : text;
    write("RESPONSE", `\n${preview}`);
  },

  /** Internal reasoning / thinking tokens from the model (e.g. Gemini 2.5 thinking) */
  think(thought: string): void {
    write("THINK", `\n${thought}`);
  },

  /** Agent visible response text */
  agent(thought: string): void {
    write("AGENT", thought);
  },

  /** Non-fatal error — agent will try to recover */
  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? ` | ${err.message}` : "";
    write("ERROR", `${message}${detail}`);
  },

  /** Final answer extracted from the server */
  final(message: string): void {
    write("FINAL", message);
  },

  /** Write a clear section divider — useful when tailing the log */
  separator(label: string): void {
    const line = `${"─".repeat(20)} ${label} ${"─".repeat(20)}`;
    write("INFO", line);
  },
};
