/**
 * index.ts — Entry point for the Phonecall Agent
 *
 * Responsibilities:
 *  1. Load environment variables from .env
 *  2. Validate that required API keys are present
 *  3. Launch the agent and report the outcome
 */

import path from 'path';
import dotenv from 'dotenv';

// Load .env before any other import that might read env vars
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { run }         from './agent';
import { log, logFilePath } from './logger';

(async () => {
  log('STEP', '=== S05E02 Phonecall Agent ===');
  log('INFO', `Log file: ${logFilePath}`);

  // ── Validate environment ───────────────────────────────────────────────────
  const required = ['OPENROUTER_API_KEY', 'AI_DEVS_API_KEY', 'CENTRAL_HUB'];
  const missing  = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    log('ERROR', 'Missing required environment variables', { missing });
    process.exit(1);
  }

  log('INFO', 'Environment validated', {
    hub:             process.env.CENTRAL_HUB,
    openrouterKeyOk: process.env.OPENROUTER_API_KEY!.startsWith('sk-or-'),
    aiDevsKeyOk:     !!process.env.AI_DEVS_API_KEY,
  });

  // ── Run agent ──────────────────────────────────────────────────────────────
  try {
    await run();
    log('STEP', '=== Agent finished successfully ===');
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', 'Agent terminated with an unhandled error', { error: msg });
    process.exit(1);
  }
})();
