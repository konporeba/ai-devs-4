import * as dotenv from "dotenv";
import * as path from "path";

// Load .env from the project root (one level up from src/)
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  // API credentials
  aiDevsApiKey: requireEnv("AI_DEVS_API_KEY"),
  openRouterApiKey: requireEnv("OPENROUTER_API_KEY"),

  // Game API endpoints
  centralHubUrl: "https://hub.ag3nts.org/verify",
  getMessageUrl: "https://hub.ag3nts.org/api/getmessage",
  frequencyScannerBaseUrl: "https://hub.ag3nts.org/api/frequencyScanner",

  // Task identifier
  taskName: "goingthere",

  // LLM model — Claude Opus 4.6 for best reliability on hint parsing and JSON extraction
  llmModel: "anthropic/claude-opus-4-6",
  // Fallback model if primary fails
  llmFallbackModel: "anthropic/claude-sonnet-4-6",

  // Game parameters
  gridRows: 3,
  gridCols: 12,
  startCol: 1,
  startRow: 2,

  // Retry settings for API calls (handles random API errors per task spec)
  apiMaxRetries: 5,
  apiRetryDelayMs: 1000, // base delay; doubles each retry (exponential backoff)

  // Navigation settings
  maxGameAttempts: 30, // Max full game restarts before giving up

  // Pacing delays (prevent rate-limiting from rapid API hammering)
  interTickDelayMs: 300,    // Pause between each move tick within a game
  interAttemptDelayMs: 3000, // Pause between game restarts (crash → new start)
} as const;
