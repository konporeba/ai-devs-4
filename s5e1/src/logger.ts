import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'session.log');

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function log(level: LogLevel, message: string, data?: unknown): void {
  ensureLogDir();
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(data !== undefined ? { data } : {}),
  });
  fs.appendFileSync(LOG_FILE, entry + '\n');

  if (level === 'ERROR') {
    console.error(`[${level}] ${message}`, data !== undefined ? data : '');
  } else if (level !== 'DEBUG') {
    console.log(`[${level}] ${message}`, data !== undefined ? data : '');
  }
}

export const logger = {
  info:  (msg: string, data?: unknown) => log('INFO',  msg, data),
  warn:  (msg: string, data?: unknown) => log('WARN',  msg, data),
  error: (msg: string, data?: unknown) => log('ERROR', msg, data),
  debug: (msg: string, data?: unknown) => log('DEBUG', msg, data),
};
