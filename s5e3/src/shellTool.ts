import { logger } from "./logger";

const VERIFY_URL = "https://hub.ag3nts.org/verify";

interface ShellRequest {
  apikey: string;
  task: string;
  answer: {
    cmd: string;
  };
}

interface ShellResponse {
  // code 100 = command executed, output contains stdout
  code?: number;
  message?: string;   // always "Command executed." — not useful
  output?: string;    // actual shell stdout
  flag?: string;      // set when the server detects a correct answer JSON
  // Catch-all for other fields
  [key: string]: unknown;
}

/**
 * Sends a shell command to the remote server and returns its text output.
 *
 * The server executes the command and returns the stdout in the `message`
 * field (or a `flag` field when the correct answer JSON is printed).
 *
 * @param cmd  The Linux shell command to execute remotely
 * @param apiKey  The AI Devs API key
 * @returns  The server's text output (stdout or flag string)
 */
export async function executeShellCommand(
  cmd: string,
  apiKey: string
): Promise<string> {
  logger.tool(cmd);

  const body: ShellRequest = {
    apikey: apiKey,
    task: "shellaccess",
    answer: { cmd },
  };

  let rawText: string;

  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    rawText = await res.text();

    if (!res.ok) {
      logger.error(`HTTP ${res.status} from server`, new Error(rawText));
      return `[HTTP ERROR ${res.status}]: ${rawText}`;
    }
  } catch (err) {
    logger.error("Network error calling verify endpoint", err);
    return `[NETWORK ERROR]: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Try to parse as JSON so we can surface the most useful field
  try {
    const parsed: ShellResponse = JSON.parse(rawText);

    // Flag found — the server recognised our correct answer JSON
    if (parsed.flag) {
      const result = `FLAG: ${parsed.flag}`;
      logger.response(result);
      return result;
    }

    // Actual shell stdout lives in `output`
    if (typeof parsed.output === "string") {
      logger.response(parsed.output);
      return parsed.output;
    }

    // Unexpected JSON shape — return full raw text so the agent can see it
    logger.response(rawText);
    return rawText;
  } catch {
    // Server returned plain text (unlikely but handled gracefully)
    logger.response(rawText);
    return rawText;
  }
}
