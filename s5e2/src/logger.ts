import fs from 'fs';
import path from 'path';

// ── Log file setup ────────────────────────────────────────────────────────────
// Each run creates a fresh timestamped log file inside logs/
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
export const logFilePath = path.join(logsDir, `agent_${runTimestamp}.log`);

fs.writeFileSync(
  logFilePath,
  `=== Phonecall Agent Log ===\nRun started: ${new Date().toISOString()}\n${'='.repeat(60)}\n\n`
);

// ── Types ─────────────────────────────────────────────────────────────────────
export type LogLevel = 'STEP' | 'INFO' | 'DEBUG' | 'WARN' | 'ERROR';

// ── Core log function ─────────────────────────────────────────────────────────
/**
 * Writes a structured log entry to both stdout and the log file.
 *
 * @param level  - Severity/category of the message
 * @param message - Human-readable description of what happened
 * @param data    - Optional structured data (object or primitive) to attach
 */
export function log(level: LogLevel, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();

  // Format data as indented JSON when provided
  const dataStr =
    data !== undefined
      ? '\n' + JSON.stringify(data, null, 2)
          .split('\n')
          .map(line => `    ${line}`)
          .join('\n')
      : '';

  // Prefix STEP entries with a visual separator for easy scanning
  const separator = level === 'STEP' ? `\n${'─'.repeat(50)}\n` : '';
  const line = `${separator}[${timestamp}] [${level.padEnd(5)}] ${message}${dataStr}\n`;

  // Console: colour-code by level
  const colours: Record<LogLevel, string> = {
    STEP:  '\x1b[36m',  // cyan
    INFO:  '\x1b[32m',  // green
    DEBUG: '\x1b[90m',  // grey
    WARN:  '\x1b[33m',  // yellow
    ERROR: '\x1b[31m',  // red
  };
  const reset = '\x1b[0m';
  console.log(`${colours[level]}${line.trimEnd()}${reset}`);

  // File: plain text (no ANSI codes)
  fs.appendFileSync(logFilePath, line);
}
