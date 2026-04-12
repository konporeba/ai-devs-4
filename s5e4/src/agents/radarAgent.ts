import * as crypto from "crypto";
import { scanFrequency, disarmRadar } from "../services/apiClient";
import { extractRadarFields } from "../utils/jsonParser";
import { logger } from "../utils/logger";
import { RadarCheckResult } from "../types";

// ─── Constants ────────────────────────────────────────────────────────────────

/** The phrase appended to detectionCode before SHA1 hashing, per task spec */
const DISARM_SUFFIX = "disarm";

/**
 * Detects the "It's clear!" message even when garbled by OKO jamming.
 *
 * Examples of garbled responses seen in testing:
 *   "\"It'S  CLeAr!\""   → random caps + extra spaces
 *   "\"it's cLeear!\""   → repeated letters ("cleear" not "clear")
 *   "\"IT'S     CLEAR\""  → all-caps + extra spaces
 *   "\"iTS CLEAR\""       → missing apostrophe
 *
 * Strategy:
 *   1. If the response contains the letters c-l-e-a-r (with possible repetition) → clear.
 *      This check runs FIRST because radar JSON never contains the word "clear".
 *   2. If the response contains no '{' character → text-only → clear.
 *      (Radar data is always JSON-like, so no '{' means it's a plain text clear message.)
 */
function isClearResponse(raw: string): boolean {
  // Primary: "clear" (with optional extra repeated letters) anywhere in the response
  // → catches all garbled variants of "It's clear!" regardless of wrapping
  const clearPattern = /c+l+e+a+r/i;
  if (clearPattern.test(raw)) return true;
  // Secondary: no JSON structure → must be a plain text response → clear
  if (!raw.includes("{")) return true;
  // Has '{' and no "clear" pattern → radar JSON data detected
  return false;
}

// ─── SHA1 hash computation ────────────────────────────────────────────────────

/**
 * Computes SHA1(detectionCode + "disarm") as required by the OKO disarm protocol.
 *
 * Node's built-in `crypto` module is used — no external dependency needed.
 */
function computeDisarmHash(detectionCode: string): string {
  const input = detectionCode + DISARM_SUFFIX;
  const hash = crypto.createHash("sha1").update(input, "utf8").digest("hex");
  logger.radarHash(input, hash);
  return hash;
}

// ─── Radar Agent ──────────────────────────────────────────────────────────────

/**
 * The Radar Agent is responsible for the full OKO radar detection and
 * neutralisation cycle on every game tick.
 *
 * Responsibilities:
 *   1. Query the frequency scanner (GET /api/frequencyScanner)
 *   2. If clear → return safely
 *   3. If radar detected → parse the (potentially corrupted) response
 *   4. Compute SHA1(detectionCode + "disarm")
 *   5. POST the disarm request to neutralise the trap
 *   6. Verify disarm succeeded; retry if needed
 *
 * The Radar Agent must run BEFORE every movement command. A failed disarm
 * means the rocket will be shot down the moment it tries to move.
 */
export async function runRadarCheck(): Promise<RadarCheckResult> {
  logger.info("RADAR", "Running OKO frequency scanner check...");

  const rawResponse = await scanFrequency();

  // ── Check if the area is clear ──────────────────────────────────────────────
  if (isClearResponse(rawResponse)) {
    logger.radarClear();
    return {
      isClear: true,
      rawResponse,
    };
  }

  // ── Radar detected: parse the corrupted response ────────────────────────────
  logger.warn("RADAR", "Radar signal detected! Initiating disarm sequence...");

  let detection;
  try {
    detection = await extractRadarFields(rawResponse);
  } catch (err) {
    // If we can't parse the response at all, throw — the orchestrator must
    // handle this as a critical failure (restart the game attempt).
    throw new Error(`Radar detected but failed to parse scanner response: ${err}`);
  }

  logger.radarDetected(detection.frequency, detection.detectionCode);

  // ── Compute the disarm hash ─────────────────────────────────────────────────
  const disarmHash = computeDisarmHash(detection.detectionCode);

  // ── Send the disarm request ─────────────────────────────────────────────────
  // The disarm API can also return random errors per task spec, so apiClient
  // already wraps it in retry logic. We just need to check the response here.
  const disarmResponse = await disarmRadar(detection.frequency, disarmHash);

  // A successful disarm typically returns code 0 or a 200 with a success message.
  // We treat any non-error response as success since the task spec doesn't
  // specify an exact success shape — and the next move will fail if we missed.
  const isSuccess =
    disarmResponse?.code === 0 ||
    (typeof disarmResponse?.message === "string" &&
      (disarmResponse.message.toLowerCase().includes("ok") ||
        disarmResponse.message.toLowerCase().includes("success") ||
        disarmResponse.message.toLowerCase().includes("disarm") ||
        disarmResponse.message.toLowerCase().includes("neutrali")));

  logger.radarDisarmed(isSuccess);

  return {
    isClear: false,
    wasDisarmed: isSuccess,
    rawResponse,
  };
}
