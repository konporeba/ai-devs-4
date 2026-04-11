import * as dotenv from "dotenv";
import * as path from "path";
import { runAgent } from "./agent";
import { logger } from "./logger";

// Load .env from the project root (one directory above src/)
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

async function main(): Promise<void> {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const aiDevsApiKey = process.env.AI_DEVS_API_KEY;

  if (!openRouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY in .env");
  }
  if (!aiDevsApiKey) {
    throw new Error("Missing AI_DEVS_API_KEY in .env");
  }

  logger.info("Starting shellaccess agent...");
  logger.info(`Log file: agent.log`);

  await runAgent(openRouterApiKey, aiDevsApiKey);
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
