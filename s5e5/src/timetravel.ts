#!/usr/bin/env ts-node
/**
 * CHRONOS-P1 Time Machine Assistant
 * AI Devs 4 — S5E5
 *
 * A guided CLI wizard that assists the human operator in configuring the
 * CHRONOS-P1 time machine for a 3-phase mission:
 *
 *   Phase 1 → Jump FORWARD  to 05 Nov 2238  (collect new battery pack)
 *   Phase 2 → Jump BACKWARD to 12 Apr 2026  (return to today)
 *   Phase 3 → Open TUNNEL   to 12 Nov 2024  (mission target date)
 *
 * The assistant automatically handles all API calls (day, month, year,
 * syncRatio, stabilization) and instructs the human operator for manual
 * UI actions that the API cannot perform: PT-A, PT-B, PWR, device mode.
 *
 * Architecture: human-in-the-loop CLI wizard (single agent).
 * The CHRONOS-P1 API requires human interaction for UI-only parameters,
 * so a fully automated solution is intentionally not possible here.
 */

import readline from 'readline';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

// ─── Environment ──────────────────────────────────────────────────────────────

const API_URL = process.env.CENTRAL_HUB ?? 'https://hub.ag3nts.org/verify';
const API_KEY = process.env.AI_DEVS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TASK = 'timetravel';
const UI_URL = 'https://hub.ag3nts.org/timetravel_preview';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Shape of the `config` object returned by the getConfig API action. */
interface DeviceConfig {
  currentDate: string;
  day: number | null;
  month: number | null;
  year: number | null;
  syncRatio: number;
  stabilization: number;
  condition: string;
  fluxDensity: number;
  batteryStatus: string;
  PTA: boolean;
  PTB: boolean;
  PWR: number;
  mode: string;
  internalMode: number;
}

/** Generic API response envelope from /verify. */
interface APIResponse {
  code: number;
  message: string;
  config?: DeviceConfig;
  [key: string]: unknown; // allow extra fields for stabilization hints
}

/** Describes the target state and instructions for one jump phase. */
interface PhaseConfig {
  label: string;
  day: number;
  month: number;
  year: number;
  syncRatio: number; // pre-calculated: (day*8 + month*12 + year*7) % 101 / 100
  pwr: number;       // from the CHRONOS-P1 protection level table
  ptA: boolean;      // PT-A: backward travel
  ptB: boolean;      // PT-B: forward travel
  requiredInternalMode: number;
  description: string;
  postJumpNote?: string;
}

// ─── Mission Definition ───────────────────────────────────────────────────────

/**
 * The three jumps required to complete the mission.
 *
 * syncRatio formula: ((day×8) + (month×12) + (year×7)) mod 101 / 100
 * PWR values sourced from the CHRONOS-P1 protection level table in the docs.
 *
 * internalMode ranges (auto-cycles every few seconds — cannot be set manually):
 *   1 = before 2000
 *   2 = 2000–2150
 *   3 = 2151–2300
 *   4 = 2301+
 */
const PHASES: PhaseConfig[] = [
  {
    label: 'PHASE 1 — Jump FORWARD to 5 November 2238',
    day: 5,
    month: 11,
    year: 2238,
    // (5×8 + 11×12 + 2238×7) % 101 = (40 + 132 + 15666) % 101 = 15838 % 101 = 82 → 0.82
    syncRatio: 0.82,
    pwr: 91, // protection table: year 2238 → 91
    ptA: false,
    ptB: true, // forward travel = PT-B only
    requiredInternalMode: 3, // 2151–2300
    description: 'Jump FORWARD in time to 5 November 2238 to collect a new battery pack.',
    postJumpNote:
      'You are now in 2238!\n' +
      '  Find the battery replacement option in the web UI and collect the\n' +
      '  new battery pack BEFORE attempting the return jump.',
  },
  {
    label: 'PHASE 2 — Jump BACKWARD to 12 April 2026 (today)',
    day: 12,
    month: 4,
    year: 2026,
    // (12×8 + 4×12 + 2026×7) % 101 = (96 + 48 + 14182) % 101 = 14326 % 101 = 85 → 0.85
    syncRatio: 0.85,
    pwr: 28, // protection table: year 2026 → 28
    ptA: true, // backward travel = PT-A only
    ptB: false,
    requiredInternalMode: 2, // 2000–2150
    description: 'Jump BACKWARD to today: 12 April 2026.',
    postJumpNote:
      'You are back in 2026!\n' +
      '  New batteries should have restored capacity to ~100%.\n' +
      '  After this jump you will have ~66% remaining — enough for the tunnel (needs ≥60%).',
  },
  {
    label: 'PHASE 3 — Open TIME TUNNEL to 12 November 2024',
    day: 12,
    month: 11,
    year: 2024,
    // (12×8 + 11×12 + 2024×7) % 101 = (96 + 132 + 14168) % 101 = 14396 % 101 = 54 → 0.54
    syncRatio: 0.54,
    pwr: 19, // protection table: year 2024 → 19
    ptA: true,
    ptB: true, // TUNNEL = PT-A + PT-B simultaneous
    requiredInternalMode: 2, // 2000–2150
    description: 'Open a TIME TUNNEL to 12 November 2024 (the day before Rafał was found in the cave).',
    postJumpNote:
      'TUNNEL OPEN to 12 November 2024!\n' +
      '  Check the /verify API response — it should return the flag.\n' +
      '  The tunnel may close and reopen periodically (normal battery-saving behaviour).',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** syncRatio formula from the CHRONOS-P1 documentation. */
function calculateSyncRatio(day: number, month: number, year: number): number {
  const raw = (day * 8 + month * 12 + year * 7) % 101;
  return parseFloat((raw / 100).toFixed(2));
}

/** Parse "1/3", "2/3", "66%", "100" → percentage integer. */
function parseBatteryPercent(status: string): number {
  if (status.includes('/')) {
    const [num, denom] = status.split('/').map(Number);
    return Math.round((num / denom) * 100);
  }
  return parseInt(status, 10) || 0;
}

const LINE = '─'.repeat(60);
const DLINE = '═'.repeat(60);

function header(text: string): void {
  console.log(`\n${DLINE}`);
  console.log(`  ${text}`);
  console.log(DLINE);
}

function section(text: string): void {
  console.log(`\n${LINE}`);
  console.log(`  ${text}`);
  console.log(LINE);
}

function formatConfig(cfg: DeviceConfig): string {
  const d = cfg.day ?? '—';
  const m = cfg.month ?? '—';
  const y = cfg.year ?? '—';
  return [
    `  Target date   : ${d}/${m}/${y}`,
    `  syncRatio     : ${cfg.syncRatio}`,
    `  stabilization : ${cfg.stabilization}`,
    `  condition     : ${cfg.condition}`,
    `  fluxDensity   : ${cfg.fluxDensity}%`,
    `  batteryStatus : ${cfg.batteryStatus}`,
    `  PT-A          : ${cfg.PTA ? 'ON' : 'OFF'}`,
    `  PT-B          : ${cfg.PTB ? 'ON' : 'OFF'}`,
    `  PWR           : ${cfg.PWR}`,
    `  mode          : ${cfg.mode}`,
    `  internalMode  : ${cfg.internalMode}`,
  ].join('\n');
}

// ─── CLI Interaction ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function pressEnter(msg = 'Press ENTER to continue...'): Promise<void> {
  await ask(`\n  ${msg}`);
}

// ─── API Layer ────────────────────────────────────────────────────────────────

/**
 * Send a JSON request to the CHRONOS-P1 /verify endpoint.
 * All API interactions go through this single function.
 */
async function callAPI(
  action: string,
  param?: string,
  value?: number,
): Promise<APIResponse> {
  const answer: Record<string, unknown> = { action };
  if (param !== undefined) answer.param = param;
  if (value !== undefined) answer.value = value;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: API_KEY, task: TASK, answer }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<APIResponse>;
}

async function apiGetConfig(): Promise<{ raw: APIResponse; config: DeviceConfig }> {
  const raw = await callAPI('getConfig');
  if (!raw.config) throw new Error('getConfig returned no config object');
  return { raw, config: raw.config };
}

async function apiReset(): Promise<APIResponse> {
  return callAPI('reset');
}

async function apiConfigure(param: string, value: number): Promise<APIResponse> {
  const res = await callAPI('configure', param, value);
  console.log(`  [API] configure(${param}=${value}) → code=${res.code}: ${res.message}`);
  // Surface any extra fields that might contain hints (e.g. stabilization)
  const extras = Object.entries(res).filter(
    ([k]) => !['code', 'message', 'config'].includes(k),
  );
  if (extras.length > 0) {
    console.log(`  [API] Extra fields in response: ${JSON.stringify(Object.fromEntries(extras))}`);
  }
  return res;
}

// ─── Stabilization Hint Extraction ───────────────────────────────────────────

/**
 * Use an LLM (via OpenRouter) to extract the final stabilization integer from
 * the Polish-language `needConfig` hint text that the CHRONOS-P1 API returns.
 *
 * The hint typically reads something like:
 *   "The most typical level is X units. Due to Y, subtract Z units from that value."
 * → The LLM computes X − Z and returns the result as a plain integer.
 *
 * This is a natural fit for an LLM: the calculation itself is simple arithmetic,
 * but the values are spelled out in Polish word-numbers (e.g. "siedemset" = 700).
 */
async function parseStabilizationWithLLM(polishText: string): Promise<number | null> {
  if (!OPENROUTER_API_KEY) {
    console.log('  [LLM] OPENROUTER_API_KEY not set — skipping LLM parse.');
    return null;
  }

  try {
    console.log('  [LLM] Sending stabilization hint to LLM for parsing...');
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5-20251001',
        messages: [
          {
            role: 'system',
            content:
              'You extract a numeric stabilization value from Polish text. ' +
              'The text describes a calculation: it gives a base number and an arithmetic adjustment. ' +
              'Follow the instructions and compute the final value. ' +
              'Respond with ONLY the final integer, nothing else.',
          },
          {
            role: 'user',
            content:
              `Calculate the stabilization parameter (valid range 0–1000) from this Polish text:\n\n${polishText}`,
          },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.log(`  [LLM] Request failed: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    const num = parseInt(content.replace(/\D/g, ''), 10);

    if (!isNaN(num) && num >= 0 && num <= 1000) {
      console.log(`  [LLM] Parsed stabilization value: ${num}`);
      return num;
    }

    console.log(`  [LLM] Could not parse integer from LLM response: "${content}"`);
    return null;
  } catch (err) {
    console.log(`  [LLM] Error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Search an API response for a stabilization hint.
 * Handles:
 *  - Direct numeric `stabilization` field at top level
 *  - Well-known hint field names containing a plain number
 *  - Digit patterns inside the message string
 *
 * Does NOT handle the Polish word-number `needConfig` field —
 * that requires LLM parsing and is handled in configurePhaseViaAPI.
 */
function extractStabilizationHint(response: APIResponse): number | null {
  // 1. Direct numeric field at top level (not inside config)
  if (typeof response.stabilization === 'number' && response.stabilization > 0) {
    return response.stabilization as number;
  }

  // 2. Well-known hint field names (numeric or digit-only string)
  for (const key of ['hint', 'advice', 'recommendation', 'tip', 'note']) {
    const val = response[key];
    if (typeof val === 'number' && val > 0 && val <= 1000) return val;
    if (typeof val === 'string') {
      const m = val.match(/\b(\d{1,4})\b/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 0 && n <= 1000) return n;
      }
    }
  }

  // 3. Digit patterns in the message string
  if (typeof response.message === 'string') {
    const patterns = [
      /stabiliz\w*\D+(\d+)/i,
      /set\s+to\s+(\d+)/i,
      /wartość\D+(\d+)/i,
      /ustawić\D+(\d+)/i,
    ];
    for (const pat of patterns) {
      const m = response.message.match(pat);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 0 && n <= 1000) return n;
      }
    }
  }

  return null;
}

/**
 * Collect the `needConfig` text from any of the provided API responses,
 * display it for the operator, then use the LLM to parse the numeric value.
 */
async function resolveNeedConfigHint(responses: APIResponse[]): Promise<number | null> {
  // All configure/getConfig responses carry the same needConfig text — just take the first
  let needConfig: string | null = null;
  for (const r of responses) {
    if (typeof r.needConfig === 'string' && r.needConfig.length > 0) {
      needConfig = r.needConfig;
      break;
    }
  }

  if (!needConfig) return null;

  console.log('\n  ┌─────────────────────────────────────────────────────┐');
  console.log('  │  STABILIZATION HINT FROM DEVICE (needConfig):       │');
  console.log('  └─────────────────────────────────────────────────────┘');
  console.log(`\n  "${needConfig}"\n`);

  return parseStabilizationWithLLM(needConfig);
}

// ─── Device Helpers ───────────────────────────────────────────────────────────

/** Poll getConfig until device.mode === 'standby' (required for API changes). */
async function waitForStandby(maxAttempts = 10): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const { config } = await apiGetConfig();
    if (config.mode === 'standby') return;
    console.log(`  [WAIT] mode="${config.mode}" — waiting for standby (${i + 1}/${maxAttempts})...`);
    await sleep(3000);
  }
  console.log('  [WARN] Device still not in standby. Proceeding anyway.');
}

// ─── Phase Configuration ──────────────────────────────────────────────────────

/**
 * Configure all API-accessible parameters for a phase:
 * day, month, year, syncRatio, stabilization.
 *
 * After setting the date we request a getConfig to look for the
 * stabilization hint the device provides (per documentation).
 */
async function configurePhaseViaAPI(phase: PhaseConfig): Promise<void> {
  section('STEP 2: Configure parameters via API');

  // Device must be in standby for configuration
  await waitForStandby();

  // Set date components
  await apiConfigure('day', phase.day);
  await apiConfigure('month', phase.month);
  await apiConfigure('year', phase.year);

  // Calculate and verify syncRatio
  const computed = calculateSyncRatio(phase.day, phase.month, phase.year);
  console.log(`\n  [CALC] syncRatio = (${phase.day}×8 + ${phase.month}×12 + ${phase.year}×7) % 101 / 100`);
  console.log(`  [CALC] = ${computed}  (expected: ${phase.syncRatio})`);

  if (computed !== phase.syncRatio) {
    console.log(`  [WARN] Computed value differs — using pre-calculated ${phase.syncRatio}`);
  }

  const syncRes = await apiConfigure('syncRatio', phase.syncRatio);

  // Get device state after date + syncRatio are set — device now provides stabilization hint
  console.log('\n  [API] Requesting device state for stabilization hint...');
  const { raw: configRaw } = await apiGetConfig();

  // ── Stabilization resolution (three-stage cascade) ────────────────────
  // Stage 1: look for a plain numeric value in any response
  const numericHint =
    extractStabilizationHint(syncRes) ??
    extractStabilizationHint(configRaw);

  // Stage 2: look for the Polish word-number needConfig text, parse via LLM
  const llmHint = numericHint === null
    ? await resolveNeedConfigHint([syncRes, configRaw])
    : null;

  const stabilizationValue = numericHint ?? llmHint;

  if (stabilizationValue !== null) {
    console.log(`\n  [AUTO] Setting stabilization = ${stabilizationValue}`);
    await apiConfigure('stabilization', stabilizationValue);
  } else {
    // Stage 3: manual fallback — show raw response for operator inspection
    console.log('\n  [INFO] Could not auto-detect stabilization value.');
    console.log('\n  [API] Raw getConfig response (inspect for hints):');
    console.log(JSON.stringify(configRaw, null, 4));
    const input = await ask('  Enter stabilization value (0–1000), or press ENTER to skip: ');
    const trimmed = input.trim();
    if (trimmed !== '') {
      const val = parseInt(trimmed, 10);
      if (!isNaN(val) && val >= 0 && val <= 1000) {
        await apiConfigure('stabilization', val);
      } else {
        console.log('  [SKIP] Invalid value — skipping stabilization config.');
      }
    }
  }

  // Show updated state
  const { config: updated } = await apiGetConfig();
  console.log('\n  Current device state after API configuration:');
  console.log(formatConfig(updated));
}

// ─── Manual UI Instructions ───────────────────────────────────────────────────

/**
 * Display precise instructions for what the human operator must set
 * in the CHRONOS-P1 web interface (PT-A, PT-B, PWR, device mode).
 */
function showManualInstructions(phase: PhaseConfig): void {
  section('STEP 3: Manual web UI configuration');

  console.log(`\n  Open: ${UI_URL}\n`);
  console.log(`  ┌────────────────────────────────────────────────────┐`);
  console.log(`  │  Set these values in the web interface:            │`);
  console.log(`  ├────────────────────────────────────────────────────┤`);
  console.log(`  │  PWR slider : ${String(phase.pwr).padEnd(3)} (protection for year ${phase.year})       │`);
  console.log(`  │  PT-A       : ${phase.ptA ? 'ON  ← backward travel' : 'OFF                       '}  │`);
  console.log(`  │  PT-B       : ${phase.ptB ? 'ON  ← forward travel ' : 'OFF                       '}  │`);

  if (phase.ptA && phase.ptB) {
    console.log(`  │  ⚠ TUNNEL MODE: PT-A + PT-B both ON simultaneously! │`);
    console.log(`  │    Battery must be ≥ 60% before activating.         │`);
  }

  console.log(`  └────────────────────────────────────────────────────┘`);

  console.log(`\n  Wait for internalMode = ${phase.requiredInternalMode} before jumping.`);
  console.log(
    `  Mode ${phase.requiredInternalMode} covers: ${internalModeRange(phase.requiredInternalMode)}`,
  );
  console.log('  (internalMode cycles automatically every few seconds — just wait for it)');
  console.log('\n  Then: verify fluxDensity = 100% → set mode to ACTIVE → click the pulsing sphere');
}

function internalModeRange(mode: number): string {
  const ranges: Record<number, string> = {
    1: 'years before 2000',
    2: 'years 2000–2150',
    3: 'years 2151–2300',
    4: 'years 2301+',
  };
  return ranges[mode] ?? 'unknown range';
}

// ─── internalMode Polling ─────────────────────────────────────────────────────

/**
 * Continuously poll the device state and display the current internalMode.
 * Stops when the user presses ENTER (they confirm the correct mode is active).
 */
async function monitorInternalMode(targetMode: number): Promise<void> {
  section(`STEP 4: Wait for internalMode = ${targetMode}`);

  console.log('  Polling device every 2 seconds. Press ENTER when the mode matches.\n');

  let running = true;
  let lastMode = -1;

  const poll = async (): Promise<void> => {
    while (running) {
      try {
        const { config } = await apiGetConfig();
        if (config.internalMode !== lastMode) {
          lastMode = config.internalMode;
          const match = config.internalMode === targetMode;
          process.stdout.write(
            `\r  internalMode = ${config.internalMode}  ${match ? '✓ MATCH — ready to proceed!' : `✗ (need ${targetMode}) — waiting...`}   `,
          );
        }
      } catch {
        // transient error — keep polling
      }
      await sleep(2000);
    }
  };

  // Start polling in the background
  poll().catch(() => undefined);

  // Wait for human to confirm
  await pressEnter(`Press ENTER when internalMode = ${targetMode} and UI is configured...`);
  running = false;
  console.log(); // newline after the \r line
}

// ─── Pre-Jump Verification ────────────────────────────────────────────────────

/**
 * Fetch current device state and run pre-flight checks.
 * Warns the operator of any issues before they click the jump button.
 */
async function preJumpCheck(phase: PhaseConfig): Promise<void> {
  section('STEP 5: Pre-jump verification');

  const { config } = await apiGetConfig();
  console.log('\n  Current device state:');
  console.log(formatConfig(config));

  type Check = { label: string; ok: boolean; note: string };
  const checks: Check[] = [
    {
      label: 'fluxDensity = 100%',
      ok: config.fluxDensity === 100,
      note: `${config.fluxDensity}% ${config.fluxDensity === 100 ? '✓' : '← must be 100%'}`,
    },
    {
      label: `internalMode = ${phase.requiredInternalMode}`,
      ok: config.internalMode === phase.requiredInternalMode,
      note: `current: ${config.internalMode} ${config.internalMode === phase.requiredInternalMode ? '✓' : `← need ${phase.requiredInternalMode}`}`,
    },
    {
      label: 'condition = doskonały',
      ok: config.condition === 'doskonały',
      note: `${config.condition} ${config.condition === 'doskonały' ? '✓' : '← must be "doskonały"'}`,
    },
    {
      label: `syncRatio = ${phase.syncRatio}`,
      ok: config.syncRatio === phase.syncRatio,
      note: `current: ${config.syncRatio} ${config.syncRatio === phase.syncRatio ? '✓' : `← expected ${phase.syncRatio}`}`,
    },
    {
      label: 'mode = standby (before activation)',
      ok: config.mode === 'standby',
      note: `${config.mode} ${config.mode === 'standby' ? '✓' : '(switch to active in UI when ready)'}`,
    },
  ];

  // Tunnel requires ≥60% battery
  if (phase.ptA && phase.ptB) {
    const battPct = parseBatteryPercent(config.batteryStatus);
    checks.push({
      label: 'battery ≥ 60% (tunnel requirement)',
      ok: battPct >= 60,
      note: `${config.batteryStatus} ≈ ${battPct}% ${battPct >= 60 ? '✓' : '← NOT enough for tunnel!'}`,
    });
  }

  console.log('\n  Pre-jump checklist:');
  let allGood = true;
  for (const c of checks) {
    console.log(`  [${c.ok ? '✓' : '✗'}] ${c.label.padEnd(32)} ${c.note}`);
    if (!c.ok) allGood = false;
  }

  if (allGood) {
    console.log('\n  ✓ All checks passed — device is ready!');
  } else {
    console.log('\n  ⚠ Some checks failed. Fix issues in the UI before jumping.');
  }

  await pressEnter('Press ENTER when you are ready to execute the jump...');
}

// ─── Phase Runner ─────────────────────────────────────────────────────────────

async function runPhase(phase: PhaseConfig, index: number): Promise<void> {
  header(`${phase.label}`);
  console.log(`\n  ${phase.description}`);

  if (index === 0) {
    console.log('\n  ⚡ Battery note: currently at 1/3 — just enough for this jump.');
    console.log('  ⚡ After this jump the battery will be ~0%. Collect new batteries in 2238!');
  }
  if (index === 2) {
    console.log('\n  ⚠ TUNNEL MODE: requires PT-A + PT-B simultaneously!');
    console.log('  ⚠ Battery must be ≥60% before activating.');
  }

  await pressEnter('Press ENTER to start this phase...');

  // ── Step 1: Reset (Phase 1 only) ──────────────────────────────────────────
  // We reset only at the very beginning of the mission.
  // Resetting between jumps would wipe the battery back to 1/3, making the
  // tunnel jump (Phase 3, requires ≥60%) impossible. For Phases 2 and 3 we
  // simply reconfigure the parameters on top of the existing device state.
  section('STEP 1: Reset device');
  if (index === 0) {
    const resetRes = await apiReset();
    console.log(`  [API] reset → code=${resetRes.code}: ${resetRes.message}`);
    await sleep(1500);
  } else {
    console.log('  [SKIP] Reset skipped for this phase to preserve battery level.');
    console.log('  [INFO] Reconfiguring device parameters directly (device stays in standby).');
  }

  // ── Step 2: Configure via API ────────────────────────────────────────────
  await configurePhaseViaAPI(phase);

  // ── Step 3: Manual UI instructions ───────────────────────────────────────
  showManualInstructions(phase);
  await pressEnter('Press ENTER after you have configured the UI settings...');

  // ── Step 4: Monitor internalMode ──────────────────────────────────────────
  await monitorInternalMode(phase.requiredInternalMode);

  // ── Step 5: Pre-jump verification ────────────────────────────────────────
  await preJumpCheck(phase);

  // ── Step 6: Execute jump ──────────────────────────────────────────────────
  section('STEP 6: Execute the jump');
  console.log('\n  In the web UI:');
  console.log('  1. Set device mode to ACTIVE');
  console.log('  2. Click the pulsing green sphere to initiate the jump');
  console.log('  3. Wait for the jump sequence to complete');

  await pressEnter('Press ENTER after the jump has been executed...');

  // Show post-jump state
  const { config: post } = await apiGetConfig();
  console.log('\n  Post-jump device state:');
  console.log(formatConfig(post));

  // Post-jump note
  if (phase.postJumpNote) {
    console.log(`\n  ══ ${phase.postJumpNote}`);
  }

  if (index === 0) {
    await pressEnter('Press ENTER after you have collected the new batteries in 2238...');
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('\n  ERROR: AI_DEVS_API_KEY not set in .env');
    process.exit(1);
  }

  header('CHRONOS-P1 TIME MACHINE ASSISTANT — AI Devs 4 S5E5');

  console.log('\n  MISSION OVERVIEW');
  console.log('  ─────────────────────────────────────────────────────');
  PHASES.forEach((p, i) => {
    const date = `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year}`;
    const mode =
      p.ptA && p.ptB
        ? 'TUNNEL (PT-A+PT-B)'
        : p.ptB
        ? 'FORWARD (PT-B)'
        : 'BACKWARD (PT-A)';
    console.log(
      `  ${i + 1}. ${date}  syncRatio=${p.syncRatio}  PWR=${p.pwr}  ${mode}  internalMode=${p.requiredInternalMode}`,
    );
  });

  console.log('\n  WEB INTERFACE');
  console.log(`  Open this URL alongside the assistant: ${UI_URL}`);

  console.log('\n  WHAT THIS ASSISTANT DOES AUTOMATICALLY');
  console.log('  • Resets the device (Phase 1 only — to preserve battery for Phase 3)');
  console.log('  • Configures: day, month, year, syncRatio, stabilization');
  console.log('  • Reads stabilization hints from the API');
  console.log('  • Polls internalMode and shows current value');
  console.log('  • Runs pre-jump checks (fluxDensity, condition, mode, battery)');

  console.log('\n  WHAT YOU DO MANUALLY IN THE WEB UI');
  console.log('  • Set the PWR slider to the value shown');
  console.log('  • Toggle PT-A and PT-B switches as instructed');
  console.log('  • Switch device mode: standby → active');
  console.log('  • Click the pulsing sphere to execute the jump');

  // Show current device state
  console.log('\n  Fetching current device state...');
  const { config: initial } = await apiGetConfig();
  console.log(formatConfig(initial));

  await pressEnter('Press ENTER to begin the mission...');

  // ── Run all three phases ──────────────────────────────────────────────────
  for (let i = 0; i < PHASES.length; i++) {
    await runPhase(PHASES[i], i);

    if (i < PHASES.length - 1) {
      console.log('\n  ✓ Phase complete. Moving to the next phase...');
      await sleep(1500);
    }
  }

  // ── Mission complete ──────────────────────────────────────────────────────
  header('MISSION COMPLETE');
  console.log('\n  The time tunnel to 12 November 2024 is open.');
  console.log('  Rafał can be reached the day before he was found in the cave.');
  console.log('\n  Check the web UI and the /verify API response for the mission flag.');
  console.log('\n  Good luck.');

  rl.close();
}

main().catch(err => {
  console.error('\n  FATAL ERROR:', err instanceof Error ? err.message : err);
  rl.close();
  process.exit(1);
});
