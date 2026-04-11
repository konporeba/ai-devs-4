/**
 * agent.ts — Phonecall Agent — main state machine
 *
 * Architecture: single agent with an explicit finite-state machine.
 * Each state corresponds to one conversational turn. After each turn we parse
 * the operator's response and decide the next state.
 *
 * Conversation script (all messages are in Polish):
 *
 *  INIT              → start session
 *  INTRODUCE         → "Dzień dobry, tu Tymon Gajewski."
 *  ASK_ROADS         → ask about RD224 / RD472 / RD820 + mention Zygfryd transport
 *  DISABLE_MONITOR   → request monitoring off on passable roads + food-transport reason
 *  PROVIDE_PASSWORD  → say "BARBAKAN" if the operator asks for a password
 *  HANDLE_UNEXPECTED → LLM-generated fallback reply (max 2 turns) when operator says
 *                       something we did not anticipate
 *  COMPLETE          → flag received or conversation confirmed done
 *
 * Retry logic: if the conversation is "burned" (error from hub or no passable roads
 * detected), the agent restarts from INIT automatically (up to MAX_RESTARTS times).
 */

import * as hub  from './services/hub';
import * as tts  from './services/tts';
import * as stt  from './services/stt';
import * as llm  from './services/llm';
import { log }   from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

// 'COMPLETE' is intentionally absent — the loop exits via explicit `return`
type State =
  | 'INIT'
  | 'INTRODUCE'
  | 'ASK_ROADS'
  | 'DISABLE_MONITOR'
  | 'PROVIDE_PASSWORD'
  | 'HANDLE_UNEXPECTED';

// ── Scripted Polish messages ───────────────────────────────────────────────────
// All outgoing messages are hardcoded — the LLM is only used to INTERPRET
// the operator's incoming responses.

const SCRIPT = {
  INTRODUCE:
    'Dzień dobry, tu Tymon Gajewski.',

  ASK_ROADS:
    'Chciałbym zapytać o status dróg RD224, RD472 i RD820. ' +
    'Pytam w związku z transportem organizowanym do jednej z baz Zygfryda.',

  DISABLE_MONITOR: (roads: string[]) =>
    `Proszę o wyłączenie monitoringu na drodze ${roads.join(' i ')}, ` +
    'identyfikator' + (roads.length > 1 ? 'y' : '') + ': ' + roads.join(', ') + '. ' +
    'Jest to w związku z tajnym transportem żywności do jednej z tajnych baz Zygfryda. ' +
    'Ta misja nie może być odnotowana w logach.',

  PASSWORD: 'BARBAKAN',
} as const;

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RESTARTS          = 3;
const MAX_UNEXPECTED_TURNS  = 3;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the operator's actual speech from a hub response.
 *
 * Priority: audio > text
 * The `message` field is a metadata/status string (e.g. "Road status delivered.").
 * The real operator content is always in the `audio` field when present.
 */
async function extractText(response: hub.HubResponse): Promise<string> {
  // Prefer audio — it carries the actual operator speech
  if (response.audio && response.audio.trim().length > 0) {
    log('INFO', 'Hub sent audio — running STT to get actual operator speech');
    return await stt.transcribe(response.audio);
  }
  // Fall back to text when no audio (e.g. session-start or error messages)
  if (response.message && response.message.trim().length > 0) {
    log('DEBUG', 'Using text field from hub response (no audio present)', { message: response.message });
    return response.message;
  }
  log('WARN', 'Hub response contains neither audio nor message');
  return '';
}

/**
 * Synthesise Polish text, encode to base64, and send to the hub.
 * Logs the script text and the hub's response.
 */
async function say(text: string): Promise<hub.HubResponse> {
  log('INFO', `Agent says: "${text}"`);
  const base64 = await tts.synthesizeToBase64(text);
  return hub.sendAudio(base64);
}

/**
 * Check all possible locations for the flag in the hub response.
 * The hub may deliver the flag in response.flag, response.message, or
 * inside the operator's transcribed text.
 */
function findFlag(response: hub.HubResponse, operatorText: string): string | null {
  // Direct flag field
  if (response.flag) return response.flag;
  // message field (e.g. "{FLG:CANYOUHEARME}")
  if (response.message) {
    const f = llm.extractFlag(response.message);
    if (f) return f;
  }
  // STT transcription of operator audio
  const fromText = llm.extractFlag(operatorText);
  if (fromText) return fromText;
  // Full JSON serialisation as final catch-all
  return llm.extractFlag(JSON.stringify(response));
}

// ── Main agent loop ───────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  log('STEP', '=== Phonecall Agent starting ===');

  // Track conversation history for the LLM fallback
  const history: string[] = [];

  for (let restart = 1; restart <= MAX_RESTARTS; restart++) {
    log('STEP', `Conversation attempt ${restart}/${MAX_RESTARTS}`);

    try {
      const flag = await runConversation(history);
      if (flag) {
        log('STEP', '🎉 TASK COMPLETE — FLAG RECEIVED', { flag });
        console.log(`\n\nFLAG: ${flag}\n`);
        return;
      }
      log('WARN', 'Conversation ended without a flag — restarting');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('ERROR', `Conversation attempt ${restart} failed`, { error: msg });
    }

    if (restart < MAX_RESTARTS) {
      log('INFO', 'Waiting 3 seconds before restart...');
      await new Promise(r => setTimeout(r, 3000));
      history.length = 0; // clear history for fresh start
    }
  }

  log('ERROR', 'All conversation attempts exhausted — agent giving up');
  throw new Error('Phonecall agent failed after maximum restarts');
}

// ── Single conversation run ───────────────────────────────────────────────────

async function runConversation(history: string[]): Promise<string | null> {
  let state: State      = 'INIT';
  let passableRoads: string[] = [];
  let unexpectedTurns = 0;

  // Loop exits only through explicit `return` statements inside each state block
  // eslint-disable-next-line no-constant-condition
  while (true) {
    log('STEP', `State: ${state}`);

    // ── INIT ────────────────────────────────────────────────────────────────
    if (state === 'INIT') {
      const response    = await hub.startSession();
      const text        = await extractText(response);
      history.push(`Operator (greeting): ${text}`);
      log('INFO', 'Operator greeting received', { text });

      const flag = findFlag(response, text);
      if (flag) return flag;

      state = 'INTRODUCE';
      continue;
    }

    // ── INTRODUCE ────────────────────────────────────────────────────────────
    if (state === 'INTRODUCE') {
      const script   = SCRIPT.INTRODUCE;
      const response = await say(script);
      history.push(`Agent: ${script}`);

      const text = await extractText(response);
      history.push(`Operator: ${text}`);
      log('INFO', 'Operator response after introduction', { text });

      const flag = findFlag(response, text);
      if (flag) return flag;

      state = 'ASK_ROADS';
      continue;
    }

    // ── ASK_ROADS ─────────────────────────────────────────────────────────────
    if (state === 'ASK_ROADS') {
      const script   = SCRIPT.ASK_ROADS;
      const response = await say(script);
      history.push(`Agent: ${script}`);

      const text = await extractText(response);
      history.push(`Operator: ${text}`);
      log('INFO', 'Operator responded with road status', { text });

      const flag = findFlag(response, text);
      if (flag) return flag;

      // Use LLM to determine which roads are passable
      passableRoads = await llm.analyzeRoadStatus(text);

      if (passableRoads.length === 0) {
        log('WARN', 'No passable roads identified — cannot continue this conversation');
        throw new Error('No passable roads detected from operator response');
      }

      log('INFO', 'Passable roads confirmed', { passableRoads });
      state = 'DISABLE_MONITOR';
      continue;
    }

    // ── DISABLE_MONITOR ──────────────────────────────────────────────────────
    if (state === 'DISABLE_MONITOR') {
      const script   = SCRIPT.DISABLE_MONITOR(passableRoads);
      const response = await say(script);
      history.push(`Agent: ${script}`);

      const text = await extractText(response);
      history.push(`Operator: ${text}`);
      log('INFO', 'Operator response after monitoring request', { text });

      const flag = findFlag(response, text);
      if (flag) return flag;

      // Did the operator ask for the password?
      const needsPassword = await llm.detectPasswordRequest(text);
      if (needsPassword) {
        state = 'PROVIDE_PASSWORD';
      } else {
        // Operator may have confirmed; check once more after a generic ack
        log('INFO', 'No password requested — treating as completion or needing ack');
        state = 'HANDLE_UNEXPECTED';
        unexpectedTurns = 0;
      }
      continue;
    }

    // ── PROVIDE_PASSWORD ─────────────────────────────────────────────────────
    if (state === 'PROVIDE_PASSWORD') {
      const script   = SCRIPT.PASSWORD;
      const response = await say(script);
      history.push(`Agent: ${script}`);

      const text = await extractText(response);
      history.push(`Operator: ${text}`);
      log('INFO', 'Operator response after password', { text });

      const flag = findFlag(response, text);
      if (flag) return flag;

      // After giving the password, the operator might confirm or ask something else
      const needsPasswordAgain = await llm.detectPasswordRequest(text);
      if (needsPasswordAgain) {
        // Repeat password once more (operator might not have heard)
        state = 'PROVIDE_PASSWORD';
      } else {
        state = 'HANDLE_UNEXPECTED';
        unexpectedTurns = 0;
      }
      continue;
    }

    // ── HANDLE_UNEXPECTED ────────────────────────────────────────────────────
    // Used when the operator says something outside the scripted flow.
    // The LLM generates a contextually appropriate short Polish reply.
    if (state === 'HANDLE_UNEXPECTED') {
      if (unexpectedTurns >= MAX_UNEXPECTED_TURNS) {
        log('WARN', 'Too many unexpected turns — ending conversation');
        return null;
      }
      unexpectedTurns++;

      // Get the last operator message from history
      const lastOperatorMsg = [...history].reverse().find(h => h.startsWith('Operator:')) ?? '';
      const operatorText    = lastOperatorMsg.replace(/^Operator:\s*/, '');

      // Check for flag one more time
      const flag = llm.extractFlag(operatorText);
      if (flag) return flag;

      // Check if password is needed
      const needsPassword = await llm.detectPasswordRequest(operatorText);
      if (needsPassword) {
        state = 'PROVIDE_PASSWORD';
        continue;
      }

      // Generate a short fallback reply
      const reply    = await llm.generatePoliteReply(history.join('\n'), operatorText);
      const response = await say(reply);
      history.push(`Agent: ${reply}`);

      const text = await extractText(response);
      history.push(`Operator: ${text}`);

      const flagInReply = findFlag(response, text);
      if (flagInReply) return flagInReply;

      // Check again if password requested
      const needsPasswordAfter = await llm.detectPasswordRequest(text);
      if (needsPasswordAfter) {
        state = 'PROVIDE_PASSWORD';
      }
      // else: loop again in HANDLE_UNEXPECTED
      continue;
    }
  }

  return null;
}
