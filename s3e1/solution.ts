/**
 * S3E1 – Sensor Anomaly Detection
 *
 * Architecture: Two-phase pipeline
 *
 * Phase 1 – Programmatic (free, handles all 10 000 files):
 *   • Type 1: active sensor value is outside its valid range
 *   • Type 4: inactive sensor field is non-zero (sensor returns data it shouldn't)
 *
 * Phase 2 – LLM via OpenRouter (for files where data looks fine):
 *   • Type 3: data is OK but operator note concludes there IS a current problem
 *   (Type 2 files already appear in Phase 1 results; no extra LLM call needed)
 *
 * Cost optimisations:
 *   - Phase 1 eliminates all numeric/structural anomalies without any LLM cost
 *   - Only clean-data files go to Phase 2
 *   - Duplicate operator notes are collapsed → each unique note classified once
 *   - Notes are batched in one LLM request per batch of 100
 *   - LLM output is minimal: only indices of problem-reporting notes
 *   - Few-shot examples in the prompt prevent false positives on "nothing suggests a fault" phrasing
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import AdmZip from 'adm-zip';
import dotenv from 'dotenv';

dotenv.config();

// ─── Configuration ───────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const AI_DEVS_API_KEY    = process.env.AI_DEVS_API_KEY!;

const SENSORS_ZIP_URL = 'https://hub.ag3nts.org/dane/sensors.zip';
const SENSORS_DIR     = path.join(__dirname, 'sensors_data');
const ZIP_PATH        = path.join(__dirname, 'sensors.zip');
const VERIFY_URL      = 'https://hub.ag3nts.org/verify';
const LOG_PATH        = path.join(__dirname, 'solution.log');

// Cheapest capable model on OpenRouter for simple classification
const LLM_MODEL      = 'openai/gpt-4o-mini';
const LLM_BATCH_SIZE = 100; // notes per request (smaller = more reliable output)

// ─── Sensor validation tables ────────────────────────────────────────────────

/**
 * Maps sensor keyword (as it appears in `sensor_type`) to its data field
 * and valid measurement range (inclusive).
 */
const SENSOR_CONFIG: Record<string, { field: string; min: number; max: number }> = {
  temperature: { field: 'temperature_K',      min: 553,   max: 873   },
  pressure:    { field: 'pressure_bar',        min: 60,    max: 160   },
  water:       { field: 'water_level_meters',  min: 5.0,   max: 15.0  },
  voltage:     { field: 'voltage_supply_v',    min: 229.0, max: 231.0 },
  humidity:    { field: 'humidity_percent',    min: 40.0,  max: 80.0  },
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface SensorData {
  sensor_type:          string;
  timestamp:            number;
  temperature_K:        number;
  pressure_bar:         number;
  water_level_meters:   number;
  voltage_supply_v:     number;
  humidity_percent:     number;
  operator_notes:       string;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ─── File download (redirect-aware) ──────────────────────────────────────────

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    function attempt(currentUrl: string, hops = 0): void {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }

      const lib = currentUrl.startsWith('https://') ? https : http;
      lib.get(currentUrl, (res) => {
        // Follow redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          attempt(res.headers.location!, hops + 1);
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => { out.close(); resolve(); });
        out.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
      }).on('error', reject);
    }
    attempt(url);
  });
}

// ─── Programmatic anomaly detection ──────────────────────────────────────────

/**
 * Parses sensor_type (e.g. "voltage/temperature") into the set of active
 * sensor keywords (e.g. {"voltage", "temperature"}).
 */
function getActiveSensors(sensorType: string): Set<string> {
  return new Set(sensorType.toLowerCase().split('/').map(s => s.trim()));
}

/**
 * Returns:
 *  outOfRange  – an active sensor's value is outside its valid range   (type 1)
 *  wrongField  – an inactive sensor's field is non-zero                (type 4)
 */
function checkNumericAnomalies(data: SensorData): {
  outOfRange: boolean;
  wrongField: boolean;
} {
  const active = getActiveSensors(data.sensor_type);
  let outOfRange = false;
  let wrongField = false;

  for (const [keyword, cfg] of Object.entries(SENSOR_CONFIG)) {
    const value = (data as unknown as Record<string, number>)[cfg.field];
    if (active.has(keyword)) {
      // Active sensor: must be within [min, max]
      if (value < cfg.min || value > cfg.max) outOfRange = true;
    } else {
      // Inactive sensor: must be exactly 0
      if (value !== 0) wrongField = true;
    }
  }

  return { outOfRange, wrongField };
}

// ─── Operator-note pre-filtering ─────────────────────────────────────────────

/**
 * Patterns that unambiguously indicate a POSITIVE note.
 * Any match → skip LLM (operator says everything is fine).
 */
const CLEAR_POSITIVE_PATTERNS: RegExp[] = [
  /nothing suggests/i,          /no sign of/i,
  /there are no deviations/i,   /smooth and stable/i,
  /baseline behavior/i,         /comfortably normal/i,
  /normal operation continues/i, /observed pattern remains trustworthy/i,
  /within (expected|limits|tolerance|normal)/i,
  /full approval/i,             /approved (as normal|as.is)/i,
  /standard pass/i,             /no escalation/i,
  /no intervention/i,           /no corrective/i,
  /case is cleared/i,           /status stays green/i,
  /operating envelope is respected/i,
  /fits reference behavior/i,   /readings align with normal/i,
  /confirms stability/i,        /everything checks out/i,
  /looks clean/i,               /remains healthy/i,
  /all values follow expected/i, /all measured channels/i,
  /closed this check/i,         /confirmed regular operation/i,
  /logged it as routine/i,      /approved the report/i,
  /signed off this inspection/i, /report matches previous healthy/i,
  /system response remains predictable/i,
  /still in a safe/i,           /no warning signs appeared/i,
  /no irregular behavior/i,     /no concerning drift/i,
  /marked the cycle as healthy/i,
  /this run finished without surprises/i,
  /signal quality remains smooth/i,
  /the readings align/i,        /monitoring continues unchanged/i,
  /shift can proceed as planned/i,
  /only routine observation continues/i,
  /consistency is maintained/i,
  /everything remains inside expected/i,
  /the platform behaves exactly as intended/i,
  /all control checks passed/i,
  /left the setup untouched/i,
  /kept the system in normal mode/i,
  /system behavior is fully stable/i,
];

/**
 * Patterns that unambiguously indicate a NEGATIVE note (operator reports a problem).
 * Any match → type-3 anomaly immediately, no LLM needed.
 */
const CLEAR_NEGATIVE_PATTERNS: RegExp[] = [
  /\bunstable\b/i,
  /\bclear irregularity\b/i,
  /\bclearly off\b/i,
  /root-cause analysis/i,
  /\bdeeper diagnostic\b/i,
  /focused technical review/i,
  /\brevalidation\b/i,
  /cannot be treated as normal/i,
  /does not match healthy history/i,
  /too erratic/i,
  /confidence in this report is low/i,
  /\bpotential fault\b/i,
];

function preFilterNote(note: string): 'positive' | 'negative' | 'ambiguous' {
  if (CLEAR_NEGATIVE_PATTERNS.some(p => p.test(note))) return 'negative';
  if (CLEAR_POSITIVE_PATTERNS.some(p => p.test(note))) return 'positive';
  return 'ambiguous';
}

// ─── LLM operator-note classification ────────────────────────────────────────

async function callLLM(system: string, user: string): Promise<string> {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model:           LLM_MODEL,
      temperature:     0,
      messages:        [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) throw new Error(`LLM error ${resp.status}: ${await resp.text()}`);
  const json = await resp.json() as { choices: { message: { content: string } }[] };
  return json.choices[0].message.content;
}

// Few-shot examples derived from real notes in the dataset.
// CRITICAL design decisions:
// 1. The positive examples include notes with explicit operator actions (signing off, marking as healthy,
//    approving) — these are POSITIVE because the operator's conclusion is "everything is fine".
// 2. The negative examples show notes where the operator's CONCLUSION is that a problem EXISTS now.
// 3. The prompt focuses on the operator's FINAL VERDICT, not individual words used.
const FEW_SHOT_SYSTEM = `You are a quality control analyst reviewing operator notes from a nuclear power plant sensor log.

TASK: Identify notes where the operator's FINAL VERDICT is that a problem currently exists with the sensor.

CRITICAL RULE — focus on what the operator CONCLUDES, not on individual words:
- If the operator mentions "fault", "error", "irregular" etc. but CONCLUDES everything is fine → POSITIVE (do NOT flag)
- If the operator CONCLUDES the reading is currently problematic, unstable, or needs investigation → NEGATIVE (flag it)
- If an operator took a routine administrative action (approved, signed off, marked as healthy) that RESOLVED in a positive verdict → POSITIVE (do NOT flag)

POSITIVE examples — operator's final verdict is "all is well" (do NOT include in output):
[0] "Performance appears nominal, nothing suggests a fault condition, so monitoring continues unchanged for this review iteration."
[1] "No irregular behavior is visible, nothing suggests a fault condition, therefore I marked the cycle as healthy for this routine audit."
[2] "Readings are calm and predictable, signal quality remains smooth and stable, therefore I marked the cycle as healthy for the active shift period."
[3] "No concerning drift is present, consistency is maintained across the board, and I approved the report as normal for this logged checkpoint."
[4] "This cycle looks reliable, the observed pattern remains trustworthy, and I recorded a standard pass for the latest service snapshot."
[5] "No irregular behavior is visible, all values follow expected distribution, so I signed off this inspection for this capture moment."
[6] "Execution quality is high, nothing suggests a fault condition, so this check ends with full approval for this review iteration."
[7] "Daily monitoring confirms stability, there is no sign of abnormal activity, and I approved the report as normal."
[8] "Health indicators remain strong, consistency is maintained across the board, and I left the setup untouched for this reporting window."
[9] "Current status remains healthy, everything remains inside expected limits, so this entry is approved as-is for the present monitoring cycle."

NEGATIVE examples — operator's final verdict is that a problem EXISTS NOW (DO include in output):
[10] "This state looks unstable, because the output suggests a potential fault, and I submitted it for root-cause analysis before this result is trusted again."
[11] "I can see a clear irregularity, since this report cannot be treated as normal, so I opened a deeper diagnostic task until diagnostics confirm stability."
[12] "This state looks unstable, since confidence in this report is low, so I opened a deeper diagnostic task until quality control clears it."
[13] "Something is clearly off, because the behavior is too erratic for approval, and I requested a focused technical review until a technician signs it off."
[14] "This is not the pattern I expected, because the current state does not match healthy history, so I marked this case for revalidation until quality control clears it."

Input: a JSON object {"notes": ["note0", "note1", ...]}
Output: ONLY valid JSON {"error_indices": [0-based indices of NEGATIVE notes]}
When in doubt, assume the note is POSITIVE and do NOT include it.`;

/**
 * Classifies an array of unique operator notes via LLM.
 * Returns a Map: note → true  (operator says everything is OK/normal)
 *                       false (operator CONCLUDES there is a current problem)
 *
 * Optimisations:
 *  - Deduplication: each unique note is classified only once
 *  - Batching: up to LLM_BATCH_SIZE notes per API call
 *  - Output minimisation: model returns only indices of negative notes
 *  - Few-shot examples in system prompt prevent false positives
 */
async function classifyNotes(uniqueNotes: string[]): Promise<Map<string, boolean>> {
  const result  = new Map<string, boolean>();
  const batches = Math.ceil(uniqueNotes.length / LLM_BATCH_SIZE);

  for (let b = 0; b < batches; b++) {
    const batch = uniqueNotes.slice(b * LLM_BATCH_SIZE, (b + 1) * LLM_BATCH_SIZE);
    log(`LLM batch ${b + 1}/${batches}: classifying ${batch.length} unique notes`);

    const user = JSON.stringify({ notes: batch });

    let errorIndices: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = await callLLM(FEW_SHOT_SYSTEM, user);
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('No JSON object found');
        const parsed = JSON.parse(match[0]) as { error_indices: number[] };
        errorIndices = parsed.error_indices ?? [];
        break;
      } catch {
        log(`  Attempt ${attempt}: JSON parse error. Raw: ${raw.slice(0, 200)}`);
        if (attempt === 3) throw new Error(`LLM failed after 3 attempts`);
      }
    }

    // Default all notes to "says OK"; flip only the ones the model flagged
    batch.forEach(note => result.set(note, true));
    for (const idx of errorIndices) {
      if (idx >= 0 && idx < batch.length) {
        result.set(batch[idx], false);
      }
    }
  }

  return result;
}

// ─── Submit answer ────────────────────────────────────────────────────────────

async function submitAnswer(ids: string[]): Promise<void> {
  log(`Submitting ${ids.length} anomaly file IDs to ${VERIFY_URL}`);

  const resp = await fetch(VERIFY_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apikey: AI_DEVS_API_KEY,
      task:   'evaluation',
      answer: { recheck: ids },
    }),
  });

  const result = await resp.json();
  log(`Server response: ${JSON.stringify(result, null, 2)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('=== S3E1 Sensor Anomaly Detection ===');

  // ── Step 1: Download & extract ───────────────────────────────────────────
  const alreadyExtracted =
    fs.existsSync(SENSORS_DIR) && fs.readdirSync(SENSORS_DIR).length > 0;

  if (!alreadyExtracted) {
    log(`Downloading ${SENSORS_ZIP_URL} …`);
    await downloadFile(SENSORS_ZIP_URL, ZIP_PATH);
    log(`Downloaded (${fs.statSync(ZIP_PATH).size.toLocaleString()} bytes). Extracting…`);
    if (!fs.existsSync(SENSORS_DIR)) fs.mkdirSync(SENSORS_DIR, { recursive: true });
    new AdmZip(ZIP_PATH).extractAllTo(SENSORS_DIR, true);
    log('Extraction complete.');
  } else {
    log('Sensor data already present – skipping download.');
  }

  // ── Step 2: Load all JSON files ──────────────────────────────────────────
  const jsonFiles = fs.readdirSync(SENSORS_DIR).filter(f => f.endsWith('.json'));
  log(`Found ${jsonFiles.length} sensor files.`);

  // ── Step 3: Programmatic anomaly check ───────────────────────────────────
  log('Phase 1: programmatic analysis…');

  const badDataFiles  = new Set<string>();
  const cleanEntries: { fileId: string; note: string }[] = [];

  for (const filename of jsonFiles) {
    const fileId = filename.replace('.json', '');
    const data   = JSON.parse(
      fs.readFileSync(path.join(SENSORS_DIR, filename), 'utf-8')
    ) as SensorData;

    const { outOfRange, wrongField } = checkNumericAnomalies(data);

    if (outOfRange || wrongField) {
      badDataFiles.add(fileId);
      log(
        `  BAD DATA ${fileId}: outOfRange=${outOfRange}, wrongField=${wrongField}` +
        ` | type="${data.sensor_type}"`
      );
    } else {
      cleanEntries.push({ fileId, note: data.operator_notes });
    }
  }

  log(`Phase 1 result: ${badDataFiles.size} bad-data files, ${cleanEntries.length} clean-data files.`);

  // ── Step 4: Hybrid note classification (clean files only) ───────────────
  // Three-tier strategy to detect TYPE 3 anomalies (data OK, note reports a problem):
  //   Tier A – Programmatic negative: clear problem language → type 3 immediately
  //   Tier B – Programmatic positive: clear "all is fine" language → skip LLM
  //   Tier C – Ambiguous: genuinely unclear → send to LLM for semantic judgment
  log('Phase 2: hybrid operator-note classification…');

  const type3Files = new Set<string>();
  const uniqueNotes = [...new Set(cleanEntries.map(e => e.note))];

  const definitelyNegative = new Set<string>();
  const ambiguousNotes: string[] = [];

  for (const note of uniqueNotes) {
    const verdict = preFilterNote(note);
    if (verdict === 'negative') {
      definitelyNegative.add(note);
    } else if (verdict === 'ambiguous') {
      ambiguousNotes.push(note);
    }
    // 'positive' → nothing to do
  }

  log(`Pre-filter: ${definitelyNegative.size} clear-negative, ${ambiguousNotes.length} ambiguous → LLM, ${uniqueNotes.length - definitelyNegative.size - ambiguousNotes.length} clear-positive.`);

  // Tier A: add clear-negative files
  for (const { fileId, note } of cleanEntries) {
    if (definitelyNegative.has(note)) {
      type3Files.add(fileId);
      log(`  TYPE 3 (pattern) ${fileId}: "${note}"`);
    }
  }

  // Tier C: ask LLM only about the ambiguous notes
  let llmNegative = new Set<string>();
  if (ambiguousNotes.length > 0) {
    log(`Sending ${ambiguousNotes.length} ambiguous notes to LLM…`);
    const classification = await classifyNotes(ambiguousNotes);
    for (const [note, isOk] of classification) {
      if (!isOk) llmNegative.add(note);
    }

    for (const { fileId, note } of cleanEntries) {
      if (llmNegative.has(note)) {
        type3Files.add(fileId);
        log(`  TYPE 3 (LLM)     ${fileId}: "${note}"`);
      }
    }
  }

  log(`Phase 2 result: ${type3Files.size} type-3 anomaly files (${definitelyNegative.size} from patterns, ${llmNegative.size} from LLM).`);

  // ── Step 5: Combine & submit ─────────────────────────────────────────────
  const allAnomalies = [...new Set([...badDataFiles, ...type3Files])].sort();

  log(`\nTotal anomalies: ${allAnomalies.length}`);
  log(`IDs: ${allAnomalies.join(', ')}`);

  await submitAnswer(allAnomalies);

  log('Done.');
  logStream.end();
}

main().catch(err => {
  log(`FATAL: ${err}`);
  logStream.end();
  process.exit(1);
});
