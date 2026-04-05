import "dotenv/config";
import OpenAI from "openai";

// ============================================================
// CONFIGURATION
// ============================================================

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const AI_DEVS_API_KEY = process.env.AI_DEVS_API_KEY!;

const HUB_BASE = "https://hub.ag3nts.org";

// Maximum number of agent iterations — a safety net against infinite loops.
// In production agents this is critical: LLMs can sometimes get "stuck"
// calling the same tool repeatedly or hallucinating tool call chains.
const MAX_ITERATIONS = 20;

// ============================================================
// THE SUSPECTS (carried over from task S01E01)
// ============================================================
// In a real pipeline these would be read from a file or previous step output.
// We hardcode them here since they're the verified result from S01E01.

const SUSPECTS = [
  { name: "Cezary",  surname: "Żurek",     born: 1987 },
  { name: "Jacek",   surname: "Nowak",      born: 1991 },
  { name: "Oskar",   surname: "Sieradzki",  born: 1993 },
  { name: "Wojciech",surname: "Bielik",     born: 1986 },
  { name: "Wacław",  surname: "Jasiński",   born: 1986 },
] as const;

// ============================================================
// OPENROUTER CLIENT
// ============================================================
// We use OpenRouter (an OpenAI-compatible proxy) to access various LLMs
// through a single API. The openai SDK works without modification —
// we just change baseURL and apiKey.

const client = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// ============================================================
// TOOL IMPLEMENTATIONS
// ============================================================
// These are the actual functions our code executes when the LLM "calls" a tool.
// The LLM doesn't run code — it just emits a JSON object with a function name
// and arguments. Our agent loop intercepts that and calls the real function here.

// --- Haversine formula ---
// Calculates the shortest distance (in km) between two points on a sphere.
// Named after the haversine trigonometric function it uses.
// This is the standard formula for geographic distance calculations.
//
//   a = sin²(Δlat/2) + cos(lat1) · cos(lat2) · sin²(Δlon/2)
//   c = 2 · atan2(√a, √(1−a))
//   d = R · c        where R = Earth's radius ≈ 6371 km

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Tool: fetch_power_plants ---
// Fetches the list of nuclear power plants from the hub.
// IMPORTANT: The API returns city names but NOT coordinates.
// We enrich the response with known GPS coordinates for each Polish city.
// This is a common pattern: fetch structured data from an API, then
// enrich/transform it before returning to the LLM.
//
// Why include coordinates here instead of asking the LLM to guess them?
// Reliability. LLM geographic knowledge is approximate and can vary between
// models and inference runs. Hard-coding known coords for these specific cities
// gives us consistent, accurate results.

async function fetchPowerPlants(): Promise<object> {
  const url = `${HUB_BASE}/data/${AI_DEVS_API_KEY}/findhim_locations.json`;
  const res = await fetch(url);
  const data = (await res.json()) as { power_plants: Record<string, { is_active: boolean; power: string; code: string }> };

  // Known approximate coordinates for the cities in the dataset.
  // Coordinates are (latitude, longitude) in decimal degrees.
  const cityCoords: Record<string, { lat: number; lon: number }> = {
    "Zabrze":                 { lat: 50.3249, lon: 18.7857 },
    "Piotrków Trybunalski":   { lat: 51.4059, lon: 19.6979 },
    "Grudziądz":              { lat: 53.4837, lon: 18.7534 },
    "Tczew":                  { lat: 54.0930, lon: 18.7792 },
    "Radom":                  { lat: 51.4027, lon: 21.1471 },
    "Chelmno":                { lat: 53.3488, lon: 18.4255 },
    "Żarnowiec":              { lat: 54.6207, lon: 18.2340 },
  };

  // Merge API data with coordinates into a flat array for easy LLM processing.
  const plants = Object.entries(data.power_plants).map(([city, info]) => ({
    city,
    code: info.code,
    is_active: info.is_active,
    power: info.power,
    lat: cityCoords[city]?.lat ?? null,
    lon: cityCoords[city]?.lon ?? null,
  }));

  console.log(`[tool] fetch_power_plants → ${plants.length} plants`);
  return { plants };
}

// --- Tool: fetch_person_locations ---
// POSTs to the hub's /api/location endpoint and returns the GPS history.
// Note the charset handling: Polish surnames contain diacritics (ż, ń, etc.)
// and the API requires proper UTF-8 encoding. fetch() handles this automatically
// when you pass a JavaScript string — no manual encoding needed.

async function fetchPersonLocations(name: string, surname: string): Promise<object> {
  const res = await fetch(`${HUB_BASE}/api/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: AI_DEVS_API_KEY, name, surname }),
  });
  const locations = await res.json();
  console.log(`[tool] fetch_person_locations(${name} ${surname}) → ${Array.isArray(locations) ? locations.length : "?"} locations`);
  return { name, surname, locations };
}

// --- Tool: find_closest_plant ---
// Given a person's location history and the list of power plants (with coords),
// computes the minimum Haversine distance from any person location to any plant.
// Returns the closest plant + distance so the LLM can reason about it.
//
// Why implement math in a tool instead of letting the LLM calculate it?
// LLMs are not reliable calculators for floating-point arithmetic.
// Always offload computation to code. The LLM's job is orchestration and reasoning,
// not number crunching.

function findClosestPlant(
  personLocations: Array<{ latitude: number; longitude: number }>,
  plants: Array<{ city: string; code: string; lat: number; lon: number }>
): object {
  let minDist = Infinity;
  let closestPlant: (typeof plants)[0] | null = null;
  let closestPersonLocation: { latitude: number; longitude: number } | null = null;

  for (const loc of personLocations) {
    for (const plant of plants) {
      if (plant.lat === null || plant.lon === null) continue;
      const dist = haversineKm(loc.latitude, loc.longitude, plant.lat, plant.lon);
      if (dist < minDist) {
        minDist = dist;
        closestPlant = plant;
        closestPersonLocation = loc;
      }
    }
  }

  console.log(`[tool] find_closest_plant → ${closestPlant?.city} at ${minDist.toFixed(2)} km`);
  return {
    closestPlantCode: closestPlant?.code ?? null,
    closestPlantCity: closestPlant?.city ?? null,
    distanceKm: parseFloat(minDist.toFixed(2)),
    personLocationUsed: closestPersonLocation,
  };
}

// --- Tool: get_access_level ---
// Fetches the security access level for a person from the hub.

async function getAccessLevel(name: string, surname: string, birthYear: number): Promise<object> {
  const res = await fetch(`${HUB_BASE}/api/accesslevel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: AI_DEVS_API_KEY, name, surname, birthYear }),
  });
  const data = await res.json();
  console.log(`[tool] get_access_level(${name} ${surname}) →`, data);
  return data;
}

// --- Tool: submit_answer ---
// Sends the final answer to the hub's /verify endpoint.
// Returns the hub's response which includes the flag on success.

async function submitAnswer(
  name: string,
  surname: string,
  accessLevel: number,
  powerPlant: string
): Promise<object> {
  const body = {
    apikey: AI_DEVS_API_KEY,
    task: "findhim",
    answer: { name, surname, accessLevel, powerPlant },
  };

  console.log("[tool] submit_answer → sending:", JSON.stringify(body, null, 2));

  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log("[tool] submit_answer ← hub replied:", JSON.stringify(data, null, 2));
  return data;
}

// ============================================================
// TOOL SCHEMAS (JSON Schema / OpenAI Tool format)
// ============================================================
// Function Calling works by sending tool *descriptions* to the LLM.
// The LLM reads these descriptions and decides when and how to call each tool.
//
// Each tool definition has:
//   - `name`: the function name (must match what we dispatch below)
//   - `description`: human/LLM-readable explanation of what this tool does
//   - `parameters`: JSON Schema describing the expected arguments
//
// The quality of your descriptions directly impacts how well the LLM uses
// the tools. Think of it like writing API documentation — be precise.

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "fetch_power_plants",
      description:
        "Fetches the list of nuclear power plants from the hub API. " +
        "Returns each plant's city name, unique code (e.g. PWR1234PL), " +
        "active status, and GPS coordinates (lat/lon).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_person_locations",
      description:
        "Fetches the GPS location history for a suspect from the hub API. " +
        "Returns an array of {latitude, longitude} coordinates where this person was seen.",
      parameters: {
        type: "object",
        properties: {
          name:    { type: "string", description: "First name of the suspect" },
          surname: { type: "string", description: "Last name of the suspect" },
        },
        required: ["name", "surname"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_closest_plant",
      description:
        "Given a person's GPS location history and the list of power plants, " +
        "computes the closest power plant using the Haversine formula. " +
        "Returns the plant code, city, and minimum distance in km.",
      parameters: {
        type: "object",
        properties: {
          personLocations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                latitude:  { type: "number" },
                longitude: { type: "number" },
              },
              required: ["latitude", "longitude"],
            },
            description: "Array of GPS coordinates where the person was seen",
          },
          plants: {
            type: "array",
            items: {
              type: "object",
              properties: {
                city: { type: "string" },
                code: { type: "string" },
                lat:  { type: "number" },
                lon:  { type: "number" },
              },
              required: ["city", "code", "lat", "lon"],
            },
            description: "List of power plants with their GPS coordinates",
          },
        },
        required: ["personLocations", "plants"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_access_level",
      description:
        "Fetches the security access level for a suspect from the hub API.",
      parameters: {
        type: "object",
        properties: {
          name:      { type: "string", description: "First name" },
          surname:   { type: "string", description: "Last name" },
          birthYear: { type: "number", description: "Year of birth as integer (e.g. 1987)" },
        },
        required: ["name", "surname", "birthYear"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_answer",
      description:
        "Submits the final answer to the hub. Call this once you have identified " +
        "the suspect who was near a nuclear plant, their access level, and the plant code.",
      parameters: {
        type: "object",
        properties: {
          name:        { type: "string", description: "Suspect's first name" },
          surname:     { type: "string", description: "Suspect's last name" },
          accessLevel: { type: "number", description: "Security access level (integer)" },
          powerPlant:  { type: "string", description: "Power plant code, e.g. PWR1234PL" },
        },
        required: ["name", "surname", "accessLevel", "powerPlant"],
      },
    },
  },
];

// ============================================================
// TOOL DISPATCHER
// ============================================================
// When the LLM decides to call a tool, it returns a ToolCall object with:
//   - `name`: which function to call
//   - `arguments`: a JSON string of the function's arguments
//
// The dispatcher parses that JSON and routes to the correct implementation.
// This is the "glue" between the LLM's intent and our actual code.

async function dispatchTool(name: string, argsJson: string): Promise<string> {
  const args = JSON.parse(argsJson);

  switch (name) {
    case "fetch_power_plants":
      return JSON.stringify(await fetchPowerPlants());

    case "fetch_person_locations":
      return JSON.stringify(await fetchPersonLocations(args.name, args.surname));

    case "find_closest_plant":
      return JSON.stringify(findClosestPlant(args.personLocations, args.plants));

    case "get_access_level":
      return JSON.stringify(await getAccessLevel(args.name, args.surname, args.birthYear));

    case "submit_answer":
      return JSON.stringify(await submitAnswer(args.name, args.surname, args.accessLevel, args.powerPlant));

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ============================================================
// SYSTEM PROMPT
// ============================================================
// The system prompt is the agent's "instruction manual". It tells the LLM:
//   1. What its mission is
//   2. What data it starts with (the suspects list)
//   3. The exact step-by-step strategy to follow
//
// Good system prompts are specific and actionable. They reduce the chance
// of the LLM going off-track or making unnecessary tool calls.
//
// We embed the suspects data directly in the prompt instead of creating
// a "list_suspects" tool. Why? Because the data is static and small —
// tools add overhead (an extra LLM round-trip) and are best reserved
// for dynamic data that changes or requires computation.

const SYSTEM_PROMPT = `You are an intelligence analyst. Your mission is to identify which of the following suspects was near a nuclear power plant.

SUSPECTS:
${SUSPECTS.map((s) => `- ${s.name} ${s.surname} (born: ${s.born})`).join("\n")}

YOUR STRATEGY:
1. Call fetch_power_plants to get the list of nuclear plants with their GPS coordinates.
2. For EACH suspect, call fetch_person_locations to get their location history.
3. For EACH suspect, call find_closest_plant using their locations and the full plant list.
4. Compare all suspects' minimum distances — find the ONE who was closest to any plant.
5. Call get_access_level for that suspect (use their birth year from the list above).
6. Call submit_answer with the suspect's name, surname, access level, and plant code.

RULES:
- Always pass birthYear as an integer (not a date string).
- The power plant code format is PWR0000PL — take it from fetch_power_plants output.
- Do NOT ask for confirmation. Work through all steps autonomously.
- Submit exactly ONE answer when you have determined the correct suspect.`;

// ============================================================
// AGENT LOOP
// ============================================================
// This is the heart of the AI Agent pattern.
//
// How Function Calling / Tool Use works:
//
//   1. We send the LLM a conversation (messages) + a list of available tools.
//   2. The LLM responds with either:
//      a) A regular text message (it's done or asking for clarification), OR
//      b) One or more "tool calls" — JSON objects naming which function to call
//         and with what arguments.
//   3. If the LLM chose option (b), we:
//      - Execute each requested tool call
//      - Append the results to the conversation as "tool" role messages
//      - Call the LLM again with the updated conversation
//   4. Repeat until the LLM gives a text response (step 2a) or we hit MAX_ITERATIONS.
//
// The LLM never actually "runs" the tools. It just expresses intent in JSON,
// and our code does the actual work. This is the key insight of Function Calling.
//
// The conversation history grows with each iteration, giving the LLM full
// context of everything it has done and learned so far.

async function runAgent(): Promise<void> {
  console.log("=== S01E02 Agent starting ===\n");

  // Initialize the conversation with just the system prompt and a user trigger.
  // The user message is minimal — all the real instructions are in the system prompt.
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: "Start the investigation." },
  ];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`\n--- Iteration ${iteration}/${MAX_ITERATIONS} ---`);

    // Call the LLM with the current conversation + tool definitions.
    // The model will either respond with text or request tool calls.
    const response = await client.chat.completions.create({
      model: "anthropic/claude-sonnet-4-5",
      messages,
      tools: TOOLS,
      // "auto" means the LLM decides whether to call a tool or respond with text.
      // Alternatives: "required" (must call a tool), "none" (no tools allowed),
      // or a specific tool name to force a particular call.
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Always append the assistant's message to the conversation.
    // This is how the LLM "remembers" what it decided previously.
    messages.push(assistantMessage);

    // Check why the LLM stopped responding.
    // "tool_calls" → it wants to call one or more tools
    // "stop"       → it's done (regular text response)
    // "length"     → hit max_tokens limit (usually an error condition)
    if (choice.finish_reason === "tool_calls" && assistantMessage.tool_calls) {
      // Process ALL tool calls the LLM requested in this response.
      // LLMs can request multiple tool calls in parallel (e.g. fetch locations
      // for several suspects at once). We process them sequentially here for
      // simplicity, but in production you'd run them concurrently with Promise.all.

      for (const toolCall of assistantMessage.tool_calls) {
        const { name, arguments: argsJson } = toolCall.function;
        console.log(`\n[LLM → tool] ${name}(${argsJson.slice(0, 80)}${argsJson.length > 80 ? "..." : ""})`);

        const result = await dispatchTool(name, argsJson);

        // Append the tool result to the conversation.
        // The `tool_call_id` links this result to the specific tool call request.
        // Without it, the LLM can't match results to its requests.
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // After processing all tool calls, loop back and call the LLM again
      // with the updated conversation (now including tool results).
      continue;
    }

    // The LLM responded with text (not a tool call) → it's done.
    if (assistantMessage.content) {
      console.log("\n=== Agent final response ===");
      console.log(assistantMessage.content);
    }

    console.log(`\nAgent completed in ${iteration} iteration(s).`);
    return;
  }

  // If we reach here, the agent exceeded MAX_ITERATIONS.
  // This is a safeguard against runaway loops caused by LLM errors.
  console.error(`\n[ERROR] Agent exceeded ${MAX_ITERATIONS} iterations without finishing.`);
  console.error("Last messages:", JSON.stringify(messages.slice(-4), null, 2));
}

// ============================================================
// ENTRY POINT
// ============================================================

runAgent().catch(console.error);
