import dotenv from 'dotenv';
dotenv.config();

import { runOrchestrator } from './src/orchestrator';

runOrchestrator().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
