import "dotenv/config";
import { parse } from "csv-parse/sync";
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

// ============================================================
// CONFIGURATION
// ============================================================
// We read secrets from environment variables (loaded from .env by dotenv).
// The code never contains hardcoded credentials — a core security practice.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const AI_DEVS_API_KEY = process.env.AI_DEVS_API_KEY!;

const HUB_DATA_URL = `https://hub.ag3nts.org/data/${AI_DEVS_API_KEY}/people.csv`;
const HUB_VERIFY_URL = "https://hub.ag3nts.org/verify";

// The year we run in, used for age calculation.
const CURRENT_YEAR = 2026;

// ============================================================
// OPENROUTER CLIENT
// ============================================================
// OpenRouter exposes an OpenAI-compatible API, so we reuse the openai SDK.
// We just swap the baseURL to point at OpenRouter instead of OpenAI.
// This is why knowing the OpenAI SDK is valuable — it works with many providers.

const client = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// ============================================================
// TYPES
// ============================================================

// Represents one row from the CSV as we parse it.
// Field names come directly from the CSV header row.
interface Person {
  name: string;
  surname: string;
  gender: string;      // "M" or "F"
  birthDate: string;   // "YYYY-MM-DD" — we extract the year from this
  birthPlace: string;  // city of birth
  birthCountry: string;
  job: string;         // job description in Polish — this goes to the LLM
}

// The tag vocabulary defined by the task.
const VALID_TAGS = [
  "IT",
  "transport",
  "edukacja",
  "medycyna",
  "praca z ludźmi",
  "praca z pojazdami",
  "praca fizyczna",
] as const;

type Tag = (typeof VALID_TAGS)[number];

// The final shape we submit to the hub (without `job`).
interface Answer {
  name: string;
  surname: string;
  gender: string;
  born: number;
  city: string;
  tags: Tag[];
}

// ============================================================
// STRUCTURED OUTPUT SCHEMA
// ============================================================
// Structured Output forces the LLM to reply with a specific JSON shape.
// We define the shape using Zod — a TypeScript schema library.
//
// Why Zod?
//   - It validates at runtime that the LLM response matches what we expect.
//   - The openai SDK's `zodResponseFormat` converts it to a JSON Schema that
//     gets sent to the model, which then guarantees its output matches.
//
// We process ALL people in a single LLM call (batch tagging) to save API calls.
// The response is an array where each element has the person's index and their tags.

const TaggingResponseSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().describe("The 0-based index of the person in the input list"),
      tags: z.array(z.enum(VALID_TAGS)).describe("Tags that apply to this person's job"),
    })
  ),
});

// ============================================================
// STEP 1: FETCH DATA
// ============================================================
// fetch() is built into Node 18+. No extra library needed.
// We download the raw CSV text and pass it to the parser.

async function fetchPeople(): Promise<Person[]> {
  console.log("Fetching people.csv from hub...");
  const response = await fetch(HUB_DATA_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch CSV: ${response.status} ${response.statusText}`);
  }

  const csvText = await response.text();

  // csv-parse/sync parses CSV synchronously and maps column headers to object keys.
  // `columns: true` means "use the first row as property names".
  // `cast: true` means "auto-convert numbers and booleans from strings".
  const rows = parse(csvText, { columns: true, cast: true, trim: true }) as Person[];

  console.log(`Fetched ${rows.length} people.`);
  return rows;
}

// ============================================================
// STEP 2: FILTER — deterministic rules, no LLM needed
// ============================================================
// We apply the three hard criteria before calling the LLM.
// This is important: never send the LLM data it doesn't need to process.
// Fewer tokens = lower cost + faster response.

function filterPeople(people: Person[]): Person[] {
  const filtered = people.filter((p) => {
    const isMale = p.gender === "M";
    const isFromGrudziadz = p.birthPlace === "Grudziądz";
    // birthDate is "YYYY-MM-DD" — we only need the year part
    const birthYear = parseInt(p.birthDate.slice(0, 4), 10);
    const age = CURRENT_YEAR - birthYear;
    const isCorrectAge = age >= 20 && age <= 40;
    return isMale && isFromGrudziadz && isCorrectAge;
  });

  console.log(`After filtering: ${filtered.length} people match gender/city/age criteria.`);
  return filtered;
}

// ============================================================
// STEP 3: LLM TAGGING WITH STRUCTURED OUTPUT
// ============================================================
// This is the core AI Agent step. We:
//   1. Build a prompt that lists all job descriptions at once (batch tagging).
//   2. Use `zodResponseFormat` to enforce the reply format — this is Structured Output.
//   3. Parse and validate the result automatically via Zod.
//
// The model we use is claude-sonnet-4-5 via OpenRouter.
// For classification tasks like this, a fast/cheap model is enough.

async function tagPeople(people: Person[]): Promise<Map<number, Tag[]>> {
  if (people.length === 0) return new Map();

  // Build the numbered list of job descriptions to send in one prompt.
  const jobList = people
    .map((p, i) => `${i}. ${p.job}`)
    .join("\n");

  const systemPrompt = `You are a job classifier. For each job description, assign all relevant tags from this list:

- IT: software, programming, computers, networks, data, systems
- transport: driving, logistics, shipping, delivery, vehicles, fleet management, transportation
- edukacja: teaching, training, tutoring, education, school, university
- medycyna: medicine, healthcare, nursing, pharmacy, therapy, clinical
- praca z ludźmi: customer service, HR, sales, counseling, reception, social work
- praca z pojazdami: driving, operating vehicles, machinery, trucks, buses, trains
- praca fizyczna: manual labor, construction, warehouse, factory, maintenance, physical work

Return results for ALL ${people.length} entries. A job can have multiple tags.`;

  const userPrompt = `Classify these jobs:\n${jobList}`;

  console.log(`Sending ${people.length} job descriptions to LLM for tagging...`);

  // zodResponseFormat converts our Zod schema into a JSON Schema that OpenRouter
  // sends to the model. The model is then constrained to produce output matching it.
  const completion = await client.beta.chat.completions.parse({
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: zodResponseFormat(TaggingResponseSchema, "tagging_response"),
  });

  // `parsed` is already validated against our Zod schema — no manual JSON.parse needed.
  const parsed = completion.choices[0].message.parsed;

  if (!parsed) {
    throw new Error("LLM returned no parsed response");
  }

  // Build a Map: person index → their tags for easy lookup.
  const tagMap = new Map<number, Tag[]>();
  for (const result of parsed.results) {
    tagMap.set(result.index, result.tags);
  }

  console.log("Tagging complete.");
  return tagMap;
}

// ============================================================
// STEP 4: SUBMIT ANSWER
// ============================================================
// We POST the final list to the hub. The hub validates our answer and
// returns a flag if we got it right.

async function submitAnswer(answers: Answer[]): Promise<void> {
  console.log(`Submitting ${answers.length} people to the hub...`);

  const body = {
    apikey: AI_DEVS_API_KEY,
    task: "people",
    answer: answers,
  };

  const response = await fetch(HUB_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await response.json();
  console.log("\n=== HUB RESPONSE ===");
  console.log(JSON.stringify(result, null, 2));
}

// ============================================================
// MAIN — orchestrates the pipeline
// ============================================================
// This is the "agent loop" — a sequence of steps where the output
// of one step feeds into the next. This is the simplest form of an agent.
//
// Fetch → Filter → Tag → Submit

async function main() {
  // Step 1: Download raw data
  const allPeople = await fetchPeople();

  // Step 2: Filter by deterministic rules (no LLM)
  const candidates = filterPeople(allPeople);

  // Step 3: Tag remaining people's jobs using the LLM
  const tagMap = await tagPeople(candidates);

  // Step 4: Keep only people with the "transport" tag and build the answer
  const answers: Answer[] = candidates
    .map((person, index) => {
      const tags = tagMap.get(index) ?? [];
      return { ...person, tags };
    })
    .filter((person) => person.tags.includes("transport"))
    // Remove the `job` field — the hub doesn't expect it.
    // Also convert birthDate → born (year integer) and birthPlace → city
    // to match the hub's expected answer format.
    .map(({ name, surname, gender, birthDate, birthPlace, tags }) => ({
      name,
      surname,
      gender,
      born: parseInt(birthDate.slice(0, 4), 10),
      city: birthPlace,
      tags,
    }));

  console.log(`\nFinal transport candidates: ${answers.length}`);
  console.log(JSON.stringify(answers, null, 2));

  // Step 5: Submit
  await submitAnswer(answers);
}

main().catch(console.error);
