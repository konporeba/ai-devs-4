import * as dotenv from "dotenv";
import * as https from "https";

dotenv.config();

const API_KEY = process.env.AI_DEVS_API_KEY!;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const BASE_URL = "https://hub.ag3nts.org/verify";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Block {
  col: number;
  top_row: number;
  bottom_row: number;
  direction: "up" | "down";
}

interface GameState {
  code: number;
  message: string;
  board: string[][];
  player: { col: number; row: number };
  goal: { col: number; row: number };
  blocks: Block[];
  reached_goal: boolean;
}

// ─── HTTP helper (native Node https, no extra dependencies) ──────────────────

function postJson(url: string, body: object): Promise<GameState> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Bad JSON: ${raw}`));
        }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendCommand(command: string): Promise<GameState> {
  return postJson(BASE_URL, {
    apikey: API_KEY,
    task: "reactor",
    answer: { command },
  });
}

// ─── Block simulation ─────────────────────────────────────────────────────────
// Blocks move one step per command. Direction flips when reaching bounds:
//   - top_row reaches 1  → direction becomes "down"
//   - bottom_row reaches 5 → direction becomes "up"

function simulateOneStep(block: Block): Block {
  let { col, top_row, bottom_row, direction } = block;
  if (direction === "down") {
    top_row++;
    bottom_row++;
    if (bottom_row >= 5) direction = "up";
  } else {
    top_row--;
    bottom_row--;
    if (top_row <= 1) direction = "down";
  }
  return { col, top_row, bottom_row, direction };
}

// ─── OpenRouter helper ────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a robot navigation controller. " +
  "Your only job is to pick one move per turn: right, wait, or left. " +
  "Always reply with a single lowercase word and nothing else.";

function callOpenRouter(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "anthropic/claude-haiku-4.5",
      max_tokens: 16,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (!parsed.choices) {
              reject(new Error(`OpenRouter error: ${raw}`));
              return;
            }
            resolve(parsed.choices[0].message.content ?? "wait");
          } catch {
            reject(new Error(`Bad JSON from OpenRouter: ${raw}`));
          }
        });
      }
    );

    req.setTimeout(15000, () => {
      req.destroy(new Error("OpenRouter request timed out"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── LLM navigation decision ─────────────────────────────────────────────────

async function askLLM(state: GameState): Promise<string> {
  const { player, goal, blocks } = state;

  // Pre-compute which moves are safe after blocks advance one step
  const afterBlocks = blocks.map(simulateOneStep);
  const isSafe = (col: number) =>
    col >= 1 &&
    col <= 7 &&
    !afterBlocks.some((b) => b.col === col && b.bottom_row === 5);

  const rightCol = player.col + 1;
  const leftCol = player.col - 1;

  const safeRight = isSafe(rightCol);
  const safeWait = isSafe(player.col);
  const safeLeft = leftCol >= 1 && isSafe(leftCol);

  const prompt = `Robot navigation: move from column ${player.col} to column ${goal.col} (rightward, columns 1-7).

After this move, safety of each option (blocks advance one step simultaneously):
- right  → column ${rightCol}: ${safeRight ? "SAFE" : "BLOCKED - robot destroyed"}
- wait   → column ${player.col}: ${safeWait ? "SAFE" : "BLOCKED - robot destroyed"}
- left   → column ${leftCol}: ${safeLeft ? "SAFE" : "BLOCKED or out of bounds"}

Reply with exactly one word. Prefer "right" > "wait" > "left". Never choose a BLOCKED option.`;

  const text = (await callOpenRouter(prompt)).trim().toLowerCase();

  if (text.includes("right") && safeRight) return "right";
  if (text.includes("wait") && safeWait) return "wait";
  if (text.includes("left") && safeLeft) return "left";

  // Fallback: pick first safe option in priority order
  if (safeRight) return "right";
  if (safeWait) return "wait";
  return "left";
}

// ─── Display ──────────────────────────────────────────────────────────────────

function printState(state: GameState, step: number, command?: string): void {
  if (command) {
    process.stdout.write(`\nStep ${step} → '${command}'\n`);
  } else {
    process.stdout.write(`\nInitial state\n`);
  }
  state.board.forEach((row, i) => {
    process.stdout.write(`  [${i + 1}] ${row.join(" ")}\n`);
  });
  const blockInfo = state.blocks
    .map(
      (b) =>
        `col${b.col}(rows ${b.top_row}-${b.bottom_row} ${b.direction})`
    )
    .join(", ");
  process.stdout.write(`  Blocks: ${blockInfo}\n`);
  process.stdout.write(`  Player: col ${state.player.col} | ${state.message}\n`);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!API_KEY) throw new Error("AI_DEVS_API_KEY not set in .env");

  console.log("Sending 'start'...");
  let state = await sendCommand("start");
  printState(state, 0);

  const MAX_STEPS = 150;

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (state.reached_goal) {
      console.log("\n✓ Goal reached!");
      break;
    }

    // Non-100 code means error (e.g. robot crushed)
    if (state.code !== 100) {
      console.error(`\n✗ API error ${state.code}: ${state.message}`);
      process.exit(1);
    }

    const command = await askLLM(state);
    state = await sendCommand(command);

    if (state.reached_goal || state.code === 0) {
      console.log(`\nStep ${step} → '${command}'\n  ${state.message}`);
      console.log("\n✓ Goal reached! Task completed.");
      break;
    }

    if (!state.board) {
      console.error("Unexpected response:", JSON.stringify(state));
      process.exit(1);
    }

    printState(state, step, command);
  }

  if (!state.reached_goal && state.code !== 0) {
    console.error("Max steps reached without completing.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
