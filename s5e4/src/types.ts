// ─── Game State ──────────────────────────────────────────────────────────────

/** Rocket's position on the 3×12 grid (1-indexed) */
export interface Position {
  row: number; // 1 = top, 3 = bottom
  col: number; // 1 = start, 12 = Grudziądz
}

/** All possible movement commands */
export type MoveCommand = "go" | "left" | "right";

/** All possible game commands including start */
export type GameCommand = "start" | MoveCommand;

/** Direction the rock occupies in the NEXT column (relative to rocket) */
export type RockDirection = "left" | "right" | "front";

// ─── Game API Payloads ────────────────────────────────────────────────────────

/** POST body sent to /verify */
export interface GameRequest {
  apikey: string;
  task: string;
  answer: {
    command: GameCommand;
  };
}

/** Response from /verify after `start` command */
export interface StartResponse {
  code: number;
  message?: string;
  // The server returns current position info and description of the column
  // Field names may vary — we parse them flexibly
  [key: string]: unknown;
}

/** Response from /verify after a move command */
export interface MoveResponse {
  code: number;
  message?: string;
  [key: string]: unknown;
}

// ─── Hint API ─────────────────────────────────────────────────────────────────

/** POST body sent to /api/getmessage */
export interface HintRequest {
  apikey: string;
}

/** Response from /api/getmessage */
export interface HintResponse {
  hint: string;
  [key: string]: unknown;
}

// ─── Frequency Scanner ────────────────────────────────────────────────────────

/**
 * Parsed result from the frequency scanner when a radar trap is detected.
 * The raw scanner response is corrupted — these fields are extracted by the
 * Radar Agent using regex + LLM fallback.
 */
export interface RadarDetection {
  frequency: number;
  detectionCode: string;
}

/** POST body sent to /api/frequencyScanner to disarm a trap */
export interface DisarmRequest {
  apikey: string;
  frequency: number;
  disarmHash: string; // SHA1(detectionCode + "disarm")
}

/** Response from POST /api/frequencyScanner after disarm attempt */
export interface DisarmResponse {
  code: number;
  message?: string;
  [key: string]: unknown;
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

/** A single message in an LLM conversation */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ─── Agent Results ────────────────────────────────────────────────────────────

/** Result returned by the Radar Agent for a single tick */
export interface RadarCheckResult {
  /** True if no radar was detected (clear to move) */
  isClear: boolean;
  /** True if a radar was detected AND successfully disarmed */
  wasDisarmed?: boolean;
  /** The raw scanner response (for logging) */
  rawResponse: string;
}

/** Result returned by the Scout Agent for a single tick */
export interface ScoutResult {
  /** Raw hint string from the radio endpoint */
  rawHint: string;
  /** Interpreted rock direction after LLM parsing */
  rockDirection: RockDirection;
}

/** Full state snapshot for one game tick (used for logging) */
export interface TickSnapshot {
  attemptNumber: number;
  tickNumber: number;
  positionBefore: Position;
  targetRow: number;
  radarResult: RadarCheckResult;
  scoutResult: ScoutResult;
  chosenCommand: MoveCommand;
  positionAfter?: Position;
  crashed?: boolean;
  won?: boolean;
}

/** Final outcome of one full game attempt */
export type GameOutcome =
  | { status: "won"; flag: string; attemptNumber: number; totalTicks: number }
  | { status: "crashed"; reason: string; attemptNumber: number; totalTicks: number }
  | { status: "aborted"; reason: string };
