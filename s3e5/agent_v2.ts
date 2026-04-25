/**
 * =====================================================================
 * AGENT V2: SaveThem — System Multi-Agentowy z LLM
 * =====================================================================
 *
 * DLACZEGO MULTI-AGENTOWY?
 * -------------------------
 * Zadanie naturalnie dzieli się na dwa odrębne problemy:
 *
 * 1. ODKRYWANIE WIEDZY — "Co jest na mapie i jakie mam zasady?"
 *    → Wymaga iteracyjnego odpytywania zewnętrznych API.
 *    → Idealny kandydat na agenta z narzędziami (tool use).
 *
 * 2. PLANOWANIE TRASY — "Jaką drogą dotrzeć do celu?"
 *    → Wymaga rozumowania przestrzennego i liczenia zasobów.
 *    → Idealny kandydat na agenta rozumującego (chain-of-thought).
 *
 * Rozdzielenie tych ról:
 * - Sprawia, że każdy agent ma jasno określoną odpowiedzialność
 * - Pozwala na testowanie każdego agenta osobno
 * - Odzwierciedla wzorzec "Single Responsibility" z programowania
 *
 * ARCHITEKTURA:
 * ─────────────────────────────────────────────────────────────────
 *  Coordinator
 *  ├── ScoutAgent (wzorzec ReAct: Reason → Act → Observe → ...)
 *  │     Narzędzia: search_tools(), call_tool()
 *  │     Wyjście: WorldKnowledge (mapa, pojazdy, zasady)
 *  └── NavigatorAgent (wzorzec Chain-of-Thought)
 *        Wejście: WorldKnowledge
 *        Wyjście: string[] = ["rocket", "up", "up", ...]
 * ─────────────────────────────────────────────────────────────────
 *
 * WZORZEC ReAct (Scout):
 * Reason: "Potrzebuję mapy → wywołam search_tools"
 * Act:    [wywołuje search_tools("map")]
 * Observe: [dostaje wynik: "found: /api/maps"]
 * Reason: "Teraz wywołam /api/maps dla Skolwin"
 * Act:    [wywołuje call_tool("/api/maps", "Skolwin")]
 * Observe: [dostaje mapę 10x10]
 * ... (kontynuuje aż zbierze wszystko)
 *
 * WZORZEC Chain-of-Thought (Navigator):
 * "Analizuję mapę... widzę rzekę wody w kolumnie 6...
 *  Rakieta nie może przez wodę, ale pieszy może...
 *  Optymalnie: rakieta do wiersza 4 kolumny 5, dismount, idę pieszo...
 *  Sprawdzam zasoby: 8.2 paliwa, 8.3 jedzenia... OK"
 * → Zwraca JSON
 */

import OpenAI from "openai";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";

// =====================================================================
// KONFIGURACJA
// =====================================================================

// Klucz do API zadania (autoryzacja przy zapytaniach do hub.ag3nts.org)
const TASK_API_KEY = process.env.TASK_API_KEY || "";

// Klucz do OpenRouter (platforma LLM — obsługuje Claude, GPT, Gemini itp.)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

// Bazowy adres serwera zadania
const TASK_BASE_URL = "https://hub.ag3nts.org";

// Model LLM używany przez oba agenty.
// OpenRouter akceptuje format "provider/model-name".
// Claude Sonnet to dobry wybór: silne rozumowanie + wsparcie dla tool use.
const MODEL = "anthropic/claude-sonnet-4-5";

// Plik logów — zapisuje każdy krok agenta
const LOG_FILE = "x:\\AI_Devs4\\s3e5\\agent_v2_log.txt";

// Maksymalna liczba kroków ReAct dla ScoutAgent (zabezpieczenie przed pętlą)
const SCOUT_MAX_STEPS = 25;

// Maksymalna liczba prób Navigatora jeśli zwróci niepoprawną trasę
const NAVIGATOR_MAX_RETRIES = 3;

// =====================================================================
// INICJALIZACJA OPENROUTER
// =====================================================================

/**
 * Klient OpenRouter, zgodny z API OpenAI.
 *
 * OpenRouter to "brama" do wielu modeli LLM — zamiast rejestrować się
 * osobno w Anthropic, OpenAI, Google — używamy jednego klucza.
 * SDK OpenAI działa bez zmian, bo interfejs API jest identyczny.
 *
 * defaultHeaders:
 * - HTTP-Referer: opcjonalne, OpenRouter może pokazywać w statystykach
 * - X-Title: nazwa aplikacji w panelu OpenRouter
 */
const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://aidevs.pl",
    "X-Title": "AI Devs 4 - SaveThem Multi-Agent",
  },
});

// =====================================================================
// TYPY DANYCH
// =====================================================================

/** Symbole na mapie 10x10 */
type TileType = "." | "T" | "W" | "R" | "S" | "G";

/** Statystyki pojazdu — zebrane przez ScoutAgent */
interface VehicleStats {
  name: string;
  fuelPerMove: number; // zużycie paliwa za krok
  foodPerMove: number; // zużycie jedzenia za krok
  canCrossWater: boolean; // czy może wejść na kafelek W
  note: string; // opis pojazdu z API
}

/**
 * Wiedza o świecie zebrana przez ScoutAgent.
 * To jest "pakiet informacji" przekazywany do NavigatorAgent.
 *
 * Idea: Scout nie planuje trasy — tylko zbiera dane.
 * Navigator nie zbiera danych — tylko planuje.
 * Separacja odpowiedzialności = czystszy kod i łatwiejsze testowanie.
 */
interface WorldKnowledge {
  map: TileType[][]; // mapa 10x10 z /api/maps
  vehicles: VehicleStats[]; // dane 4 pojazdów z /api/wehicles
  rulesText: string; // zasady ruchu z /api/books (złączone)
  discoveredEndpoints: string[]; // endpointy znalezione przez toolsearch
}

/** Wynik walidacji trasy */
interface ValidationResult {
  valid: boolean;
  error?: string; // opis błędu jeśli trasa jest niepoprawna
  fuelUsed?: number;
  foodUsed?: number;
}

// =====================================================================
// NARZĘDZIA KOMUNIKACYJNE (warstwa transportowa)
// =====================================================================

/**
 * Wysyła żądanie POST do API zadania (hub.ag3nts.org).
 * Ta funkcja NIE komunikuje się z LLM — to pomocnik HTTP.
 *
 * @param path - ścieżka np. "/api/maps"
 * @param body - obiekt wysyłany jako JSON
 */
function taskApiPost<T>(path: string, body: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = `${TASK_BASE_URL}${path}`;
    const jsonBody = JSON.stringify(body);
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(jsonBody),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(new Error(`Błąd parsowania JSON z ${path}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(jsonBody);
    req.end();
  });
}

// =====================================================================
// LOGOWANIE
// =====================================================================

/**
 * Zapisuje wiadomość do konsoli i pliku logów z timestampem.
 *
 * Logowanie jest kluczowe w systemach agentowych:
 * - Pozwala prześledzić "myślenie" LLM (jakie tool calls wykonał)
 * - Pomaga debugować gdy LLM podejmie nieoczekiwane decyzje
 * - W produkcji logi trafiają do systemów jak Datadog, CloudWatch itp.
 */
function log(message: string, level: "INFO" | "LLM" | "TOOL" | "ERROR" | "SUCCESS" = "INFO"): void {
  const timestamp = new Date().toISOString();
  // Emoji w logach pomagają szybko odróżnić typ wpisu
  const prefix = { INFO: "ℹ️ ", LLM: "🤖", TOOL: "🔧", ERROR: "❌", SUCCESS: "✅" }[level];
  const line = `[${timestamp}] ${prefix} ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
}

// =====================================================================
// DEFINICJE NARZĘDZI DLA SCOUT AGENTA
// =====================================================================

/**
 * Narzędzia (tools/functions) które ScoutAgent może wywołać.
 *
 * W API OpenAI/OpenRouter, tools to lista funkcji które LLM "widzi"
 * i może zdecydować się wywołać. LLM nie wywołuje ich samodzielnie —
 * zwraca "tool_call" (prośbę o wywołanie), a nasz kod ją realizuje.
 *
 * To jest fundamentalna zasada bezpieczeństwa:
 * LLM NIGDY nie ma bezpośredniego dostępu do systemu.
 * Tylko nasz kod (sandbox) wykonuje faktyczne akcje.
 */
const SCOUT_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_tools",
      description:
        "Search for available API tools by topic. Returns up to 3 matching tools with their endpoint URLs. " +
        "Use this FIRST to discover what APIs are available before calling them.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language query describing what kind of tool you need. Example: 'map terrain grid'",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "call_tool",
      description:
        "Call a discovered tool endpoint with a query. All tools accept a 'query' string parameter " +
        "and return JSON results. Use the endpoint URL path discovered via search_tools.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description:
              "The API endpoint path, e.g. '/api/maps', '/api/wehicles', '/api/books'. " +
              "Must start with '/'.",
          },
          query: {
            type: "string",
            description:
              "The query to send to the tool. For maps: city name. For vehicles: vehicle name. " +
              "For books: topic keywords.",
          },
        },
        required: ["endpoint", "query"],
      },
    },
  },
];

// =====================================================================
// WYKONANIE NARZĘDZI (tool execution)
// =====================================================================

/**
 * Realizuje tool call zwrócony przez LLM.
 *
 * Gdy LLM postanowi wywołać narzędzie, otrzymujemy obiekt:
 * { name: "call_tool", arguments: { endpoint: "/api/maps", query: "Skolwin" } }
 *
 * Nasz kod sprawdza nazwę i wykonuje odpowiednią akcję.
 * Wynik jest ZAWSZE stringiem (LLM rozumie tylko tekst).
 *
 * @param toolName - nazwa narzędzia
 * @param toolArgs - parametry jako obiekt
 */
async function executeTool(toolName: string, toolArgs: Record<string, string>): Promise<string> {
  if (toolName === "search_tools") {
    log(`[SCOUT TOOL] search_tools("${toolArgs.query}")`, "TOOL");
    const result = await taskApiPost<{ tools: Array<{ name: string; url: string; description: string }> }>(
      "/api/toolsearch",
      { apikey: TASK_API_KEY, query: toolArgs.query }
    );
    log(`[SCOUT TOOL] → znaleziono: ${result.tools?.map((t) => t.name).join(", ") || "nic"}`, "TOOL");
    return JSON.stringify(result);
  }

  if (toolName === "call_tool") {
    log(`[SCOUT TOOL] call_tool("${toolArgs.endpoint}", "${toolArgs.query}")`, "TOOL");
    const result = await taskApiPost<unknown>(toolArgs.endpoint, {
      apikey: TASK_API_KEY,
      query: toolArgs.query,
    });
    log(`[SCOUT TOOL] → odpowiedź z ${toolArgs.endpoint}: ${JSON.stringify(result).slice(0, 200)}...`, "TOOL");
    return JSON.stringify(result);
  }

  return JSON.stringify({ error: `Nieznane narzędzie: ${toolName}` });
}

// =====================================================================
// AGENT 1: SCOUT (wzorzec ReAct)
// =====================================================================

/**
 * ScoutAgent — zbiera wiedzę o świecie używając wzorca ReAct.
 *
 * WZORZEC ReAct KROK PO KROKU:
 * ┌────────────────────────────────────────────────────┐
 * │  1. LLM otrzymuje system prompt + zadanie           │
 * │  2. LLM "Reason": myśli co potrzebuje               │
 * │  3. LLM "Act": zwraca tool_call (prośbę o akcję)    │
 * │  4. Nasz kod wykonuje akcję → wynik do messages     │
 * │  5. LLM "Observe": widzi wynik, decyduje co dalej   │
 * │  6. Powtarzaj od 2 aż LLM skończy (brak tool_calls) │
 * └────────────────────────────────────────────────────┘
 *
 * Kluczowe: LLM SAM decyduje:
 * - Jakie zapytania wysłać do toolsearch
 * - Które endpointy wywołać po ich odkryciu
 * - Kiedy ma wystarczające dane i może skończyć
 *
 * My (programiści) definiujemy tylko:
 * - Dostępne narzędzia (SCOUT_TOOLS)
 * - System prompt (cel i kontekst)
 * - Limit kroków (zabezpieczenie)
 */
async function runScoutAgent(): Promise<WorldKnowledge> {
  log("\n" + "═".repeat(60), "INFO");
  log("SCOUT AGENT — Start (wzorzec ReAct)", "INFO");
  log("═".repeat(60), "INFO");

  // Historia konwersacji z LLM
  // Każde wywołanie API LLM wymaga przesłania CAŁEJ historii —
  // LLM jest bezstanowy (stateless), nie pamięta poprzednich wiadomości.
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are a reconnaissance agent for a tactical mission. Your task is to gather all information
needed to plan a route to the city of Skolwin.

You have access to two tools:
1. search_tools(query) — discovers available API endpoints by topic
2. call_tool(endpoint, query) — calls a discovered endpoint

Your mission:
1. Use search_tools to discover available tool categories (maps, vehicles, rules)
2. Get the terrain map of Skolwin (city name as query to the maps endpoint)
3. Get vehicle stats for ALL FOUR vehicles: rocket, car, horse, walk (one call each)
4. Get movement rules from the books endpoint (query about terrain, water, trees)

IMPORTANT: All APIs are in English. Do not mix Polish.
When you have gathered all information (map + 4 vehicles + rules), stop calling tools and say DONE.`,
    },
    {
      role: "user",
      content:
        "Please gather all information needed to plan a route to Skolwin. " +
        "Start by discovering available tools, then collect the map, vehicle stats, and movement rules.",
    },
  ];

  // Zbieramy surowe dane z tool calls, żeby wyekstrahować WorldKnowledge
  const rawToolResults: Array<{ endpoint: string; result: unknown }> = [];

  // PĘTLA ReAct
  for (let step = 0; step < SCOUT_MAX_STEPS; step++) {
    log(`\n[SCOUT] Krok ${step + 1}/${SCOUT_MAX_STEPS} — wywołuję LLM...`, "LLM");

    // ── Wywołanie LLM ──────────────────────────────────────────────
    // LLM otrzymuje całą historię + listę dostępnych narzędzi
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools: SCOUT_TOOLS,
      tool_choice: "auto", // LLM sam decyduje czy wywołać narzędzie
      temperature: 0.1,    // Niska temperatura = bardziej deterministyczne, mniej "kreatywne"
                           // W zadaniach wymagających precyzji chcemy przewidywalność
      max_tokens: 2048,    // Ograniczamy tokeny — Scout potrzebuje tylko krótkich decyzji
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Dodajemy odpowiedź asystenta do historii
    messages.push(assistantMessage);

    // ── Obsługa odpowiedzi ─────────────────────────────────────────
    if (choice.finish_reason === "tool_calls" && assistantMessage.tool_calls) {
      // LLM chce wywołać narzędzia
      log(`[SCOUT] LLM zażądał ${assistantMessage.tool_calls.length} wywołania narzędzi`, "LLM");

      // Logujemy "myślenie" LLM jeśli było jakieś
      if (assistantMessage.content) {
        log(`[SCOUT] Rozumowanie LLM: "${assistantMessage.content}"`, "LLM");
      }

      // Wykonujemy każde żądane narzędzie i dodajemy wyniki do historii
      for (const toolCall of assistantMessage.tool_calls) {
        // Rzutowanie na konkretny typ — OpenAI SDK używa unii typów dla tool calls
        const tc = toolCall as { id: string; type: string; function: { name: string; arguments: string } };
        const toolName = tc.function.name;
        const toolArgs = JSON.parse(tc.function.arguments) as Record<string, string>;

        // Wykonaj narzędzie
        const toolResult = await executeTool(toolName, toolArgs);

        // Zapamiętaj surowe wyniki do późniejszej ekstrakcji
        if (toolName === "call_tool") {
          rawToolResults.push({
            endpoint: toolArgs.endpoint,
            result: JSON.parse(toolResult),
          });
        }

        // Dodaj wynik do historii jako "tool" message
        // Bez tego LLM nie "zobaczy" wyniku narzędzia w następnym kroku
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    } else {
      // LLM nie zażądał narzędzi — skończył zbieranie danych (lub powiedział DONE)
      const finalText = assistantMessage.content || "";
      log(`[SCOUT] LLM zakończył zbieranie. Ostatnia wiadomość: "${finalText.slice(0, 200)}"`, "LLM");
      break;
    }
  }

  // ── Ekstrakcja WorldKnowledge z surowych wyników ──────────────
  // Przeglądamy zebrane tool results i wyciągamy ustrukturyzowane dane
  log("\n[SCOUT] Ekstrahuję WorldKnowledge z zebranych danych...", "INFO");
  return extractWorldKnowledge(rawToolResults);
}

/**
 * Wyciąga ustrukturyzowane dane z surowych wyników tool calls.
 *
 * LLM zbierał dane iteracyjnie (call_tool → wyniki).
 * Tu przetwarzamy te wyniki na typ WorldKnowledge.
 *
 * @param rawResults - lista {endpoint, result} z tool calls
 */
function extractWorldKnowledge(
  rawResults: Array<{ endpoint: string; result: unknown }>
): WorldKnowledge {
  let map: TileType[][] = [];
  const vehicles: VehicleStats[] = [];
  const rulesChunks: string[] = [];
  const discoveredEndpoints: string[] = [];

  for (const { endpoint, result } of rawResults) {
    discoveredEndpoints.push(endpoint);
    const r = result as Record<string, unknown>;

    // Mapa — odpowiedź z /api/maps zawiera pole "map"
    if (endpoint.includes("maps") && r.map) {
      map = r.map as TileType[][];
      log(`[SCOUT] Mapa wyekstrahowana: ${(r.map as TileType[][]).length}x${(r.map as TileType[][])[0].length}`, "INFO");
    }

    // Pojazdy — odpowiedź z /api/wehicles zawiera pole "name" i "consumption"
    if (endpoint.includes("wehicle") && r.name && r.consumption) {
      const cons = r.consumption as { fuel: number; food: number };
      const vehicleName = r.name as string;
      vehicles.push({
        name: vehicleName,
        fuelPerMove: cons.fuel,
        foodPerMove: cons.food,
        // Wiedza o tym co może przechodzić przez wodę pochodzi z zasad (books),
        // ale tu hardcodujemy bo jest deterministyczna
        canCrossWater: vehicleName === "horse" || vehicleName === "walk",
        note: (r.note as string) || "",
      });
      log(`[SCOUT] Pojazd wyekstrahowany: ${vehicleName} (paliwo=${cons.fuel}, jedzenie=${cons.food})`, "INFO");
    }

    // Zasady — odpowiedź z /api/books zawiera pole "notes"
    if (endpoint.includes("books") && r.notes) {
      const notes = r.notes as Array<{ title: string; content: string }>;
      for (const note of notes) {
        rulesChunks.push(`[${note.title}]: ${note.content}`);
      }
      log(`[SCOUT] Zasady wyekstrahowane: ${notes.length} notatek`, "INFO");
    }
  }

  if (!map.length) {
    throw new Error("Scout nie zdołał pobrać mapy! Sprawdź logi.");
  }
  if (vehicles.length < 4) {
    log(`[SCOUT] UWAGA: Pobrano tylko ${vehicles.length}/4 pojazdów`, "ERROR");
  }

  return {
    map,
    vehicles,
    rulesText: rulesChunks.join("\n\n"),
    discoveredEndpoints,
  };
}

// =====================================================================
// AGENT 2: NAVIGATOR (wzorzec Chain-of-Thought)
// =====================================================================

/**
 * NavigatorAgent — planuje trasę używając chain-of-thought reasoning.
 *
 * WZORZEC CHAIN-OF-THOUGHT:
 * Zamiast prost prosić LLM "daj mi trasę", prosimy o:
 * 1. Przeanalizuj mapę krok po kroku
 * 2. Zidentyfikuj przeszkody
 * 3. Oblicz zasoby dla każdej możliwej trasy
 * 4. DOPIERO POTEM podaj finalny JSON
 *
 * Dlaczego to działa lepiej?
 * - LLM "myśli głośno" zanim odpowie
 * - Mniejsze ryzyko błędów matematycznych (przeliczanie zasobów)
 * - Możemy zobaczyć rozumowanie LLM w logach (ważne dla nauki!)
 *
 * WALIDACJA + RETRY:
 * LLM może popełnić błąd (np. policzyć złą trasę przez wodę).
 * Walidujemy algorytmicznie i jeśli błąd — wysyłamy LLM informację zwrotną.
 * To jest wzorzec "self-correction" w agentach.
 */
async function runNavigatorAgent(knowledge: WorldKnowledge): Promise<string[]> {
  log("\n" + "═".repeat(60), "INFO");
  log("NAVIGATOR AGENT — Start (wzorzec Chain-of-Thought)", "INFO");
  log("═".repeat(60), "INFO");

  // Przygotuj czytelną reprezentację mapy dla LLM
  const mapString = formatMapForLLM(knowledge.map);

  // Przygotuj dane pojazdów
  const vehiclesString = knowledge.vehicles
    .map(
      (v) =>
        `- ${v.name}: fuel_per_move=${v.fuelPerMove}, food_per_move=${v.foodPerMove}, can_cross_water=${v.canCrossWater}`
    )
    .join("\n");

  // System prompt dla Navigatora
  // Kluczowe elementy dobrego promptu do planowania:
  // 1. Precyzyjny opis stanu świata (mapa, zasady, zasoby)
  // 2. Instrukcja step-by-step thinking (chain-of-thought)
  // 3. Jasny format wyjścia (JSON)
  // 4. Przykład poprawnej odpowiedzi
  const systemPrompt = `You are a navigation expert planning an optimal route on a grid map.

MAP (10x10 grid, row 0 = top, col 0 = left):
${mapString}

TILE LEGEND:
- . = passable ground
- T = tree tile: passable by ALL modes, but powered vehicles (rocket, car) pay +0.2 extra fuel to enter
- W = water: ONLY horse and walk can enter; rocket and car are DESTROYED if they enter water
- R = rocks: COMPLETELY IMPASSABLE by any mode, cannot enter
- S = starting position (the traveler begins here)
- G = goal position (must reach this tile to complete the mission)

MOVEMENT COMMANDS:
- "up"    = move to row above    (row decreases by 1)
- "down"  = move to row below    (row increases by 1)
- "left"  = move left            (col decreases by 1)
- "right" = move right           (col increases by 1)
- "dismount" = exit current vehicle, continue on foot (walk mode) — no resource cost

VEHICLES (resource cost per move):
${vehiclesString}

STARTING RESOURCES: food=10, fuel=10
ANSWER FORMAT: JSON array. First element = starting vehicle name, rest = commands.
Example: ["rocket", "up", "right", "dismount", "right", "right"]

CRITICAL CONSTRAINTS:
1. Cannot step on R (rocks) — completely impassable
2. Cannot step on W (water) with rocket or car — they are destroyed
3. After "dismount", you walk (walk mode) — cannot re-enter a vehicle
4. Tree tiles (T) cost +0.2 fuel for rocket and car ONLY
5. Total fuel spent must be ≤ 10
6. Total food spent must be ≤ 10

IMPORTANT RULES for additional notes (discovered from mission archives):
${knowledge.rulesText}`;

  const userPrompt = `Plan the optimal route from S to G.

Think step by step:
1. Find the start position (S) and goal position (G) — state their coordinates (row, col)
2. Analyze obstacles: where are rocks (R)? where is the water barrier (W)?
3. Can any vehicle cross from left side to right side without touching water? Or must you use walk/horse?
4. For the chosen vehicle: trace the path step by step (row,col after each move)
5. Count exact resource usage (fuel and food) for each segment
6. Verify total fuel ≤ 10 and total food ≤ 10

Then output ONLY a valid JSON array on the last line, like this:
["vehicle_name", "direction", "direction", ...]`;

  // Historia konwersacji Navigatora (zaczyna świeżo, nie dziedziczy po Scoucie)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Pętla retry — jeśli LLM poda błędną trasę, dajemy mu feedback i próbujemy ponownie
  for (let attempt = 1; attempt <= NAVIGATOR_MAX_RETRIES; attempt++) {
    log(`\n[NAVIGATOR] Próba ${attempt}/${NAVIGATOR_MAX_RETRIES} — wywołuję LLM...`, "LLM");

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.1,  // Deterministyczność ważna przy liczeniu zasobów
      max_tokens: 4096,  // Navigator potrzebuje więcej — musi "myśleć głośno" (CoT)
    });

    const rawContent = response.choices[0].message.content || "";

    // Logujemy pełne rozumowanie LLM — to jest kluczowe dla nauki!
    // Możemy zobaczyć jak model "myśli" o mapie
    log(`\n[NAVIGATOR] Pełne rozumowanie LLM:\n${"─".repeat(50)}\n${rawContent}\n${"─".repeat(50)}`, "LLM");

    // Próbujemy wyekstrahować JSON array z odpowiedzi
    const route = extractJsonArray(rawContent);

    if (!route) {
      log(`[NAVIGATOR] Nie znaleziono JSON array w odpowiedzi`, "ERROR");
      messages.push({ role: "assistant", content: rawContent });
      messages.push({
        role: "user",
        content:
          "Your response did not contain a valid JSON array. " +
          "Please end your response with ONLY a JSON array on the last line, like: " +
          '["rocket", "up", "right"]',
      });
      continue;
    }

    log(`[NAVIGATOR] Wyekstrahowana trasa: ${JSON.stringify(route)}`, "INFO");

    // Walidacja algorytmiczna — sprawdzamy czy LLM nie popełnił błędu
    const validation = validateRoute(route, knowledge.map, knowledge.vehicles);

    if (validation.valid) {
      log(
        `[NAVIGATOR] ✅ Trasa poprawna! Zużycie: paliwo=${validation.fuelUsed?.toFixed(2)}, jedzenie=${validation.foodUsed?.toFixed(2)}`,
        "SUCCESS"
      );
      return route;
    } else {
      // Trasa niepoprawna — informujemy LLM o konkretnym błędzie
      log(`[NAVIGATOR] ❌ Trasa błędna: ${validation.error}`, "ERROR");
      messages.push({ role: "assistant", content: rawContent });
      messages.push({
        role: "user",
        content:
          `Your proposed route has an error: ${validation.error}\n\n` +
          "Please rethink the route carefully, trace each step with (row,col) coordinates, " +
          "and provide a corrected JSON array.",
      });
    }
  }

  // Wszystkie próby wyczerpane — użyj fallback BFS
  log(`[NAVIGATOR] LLM nie dał poprawnej trasy po ${NAVIGATOR_MAX_RETRIES} próbach. Używam BFS fallback.`, "ERROR");
  return bfsFallback(knowledge.map, knowledge.vehicles);
}

// =====================================================================
// FORMATOWANIE MAPY DLA LLM
// =====================================================================

/**
 * Tworzy czytelną tekstową reprezentację mapy dla LLM.
 *
 * Format z numerami wierszy i kolumn bardzo pomaga LLM w orientacji:
 *
 *      col: 0 1 2 3 4 5 6 7 8 9
 * row  0:   . . . . . . . . W W
 * row  4:   . . T . . . W . G .   <- GOAL at (row=4, col=8)
 * row  7:   S R . . . . . W . .   <- START at (row=7, col=0)
 *
 * Bez numeracji LLM łatwo się myli w policzeniu współrzędnych.
 */
function formatMapForLLM(map: TileType[][]): string {
  // Nagłówek z numerami kolumn
  const colHeader = "     col: " + Array.from({ length: map[0].length }, (_, i) => i).join(" ");
  const separator = "     " + "-".repeat(map[0].length * 2 + 5);

  const rows = map.map((row, rowIdx) => {
    const isStart = row.includes("S");
    const isGoal = row.includes("G");
    const annotation = isStart
      ? `   <- START at (row=${rowIdx}, col=${row.indexOf("S")})`
      : isGoal
      ? `   <- GOAL  at (row=${rowIdx}, col=${row.indexOf("G")})`
      : "";
    return `row ${String(rowIdx).padStart(2)}: ${row.join(" ")}${annotation}`;
  });

  return [colHeader, separator, ...rows].join("\n");
}

// =====================================================================
// EKSTRAKCJA JSON Z ODPOWIEDZI LLM
// =====================================================================

/**
 * Wyciąga tablicę JSON z dowolnego tekstu odpowiedzi LLM.
 *
 * LLM często otacza JSON dodatkowym tekstem np.:
 * "Based on my analysis, the optimal route is:
 *  ["rocket", "up", "right", ...]
 * This route uses 8.2 fuel..."
 *
 * Używamy regex żeby znaleźć tablicę i ją wyekstrahować.
 * To jest typowy "output parsing" w systemach agentowych.
 *
 * @param text - surowa odpowiedź LLM
 * @returns tablicę stringów lub null jeśli nie znaleziono
 */
function extractJsonArray(text: string): string[] | null {
  // Szukamy bloku JSON ```json [...] ``` lub samej tablicy
  const jsonBlockMatch = text.match(/```json\s*(\[[\s\S]*?\])\s*```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1]) as string[];
    } catch {
      // Kontynuuj do następnej próby
    }
  }

  // Szukamy ostatniego wystąpienia tablicy JSON w tekście
  // "ostatniego" bo LLM często pisze przykłady przed finalną odpowiedzią
  const allArrayMatches = [...text.matchAll(/(\[(?:"[^"]*"(?:,\s*)?)+\])/g)];
  if (allArrayMatches.length > 0) {
    const lastMatch = allArrayMatches[allArrayMatches.length - 1][1];
    try {
      return JSON.parse(lastMatch) as string[];
    } catch {
      // Kontynuuj
    }
  }

  // Próba bardziej agresywna — szukamy czegokolwiek co wygląda jak JSON array
  const looseMatch = text.match(/\[[\s\S]*?\]/);
  if (looseMatch) {
    try {
      const parsed = JSON.parse(looseMatch[0]);
      if (Array.isArray(parsed) && parsed.every((el) => typeof el === "string")) {
        return parsed as string[];
      }
    } catch {
      // Nic nie znaleziono
    }
  }

  return null;
}

// =====================================================================
// WALIDACJA TRASY
// =====================================================================

/**
 * Waliduje trasę algorytmicznie — sprawdza czy jest poprawna.
 *
 * To jest kluczowy element architektury:
 * LLM może popełniać błędy w obliczeniach i nawigacji przestrzennej.
 * Weryfikacja deterministycznym kodem TypeScript zapewnia korektność.
 *
 * Wzorzec: "LLM generuje, kod weryfikuje" — typowe w agentach produkcyjnych.
 *
 * @param route - tablica komend ["rocket", "up", "right", ...]
 * @param map - mapa terenu
 * @param vehicles - dane pojazdów
 */
function validateRoute(
  route: string[],
  map: TileType[][],
  vehicles: VehicleStats[]
): ValidationResult {
  // Poprawne komendy ruchu i zarządzania pojazdem
  const VALID_VEHICLES = ["rocket", "car", "horse", "walk"];
  const VALID_MOVES = ["up", "down", "left", "right"];
  const VALID_COMMANDS = ["dismount", ...VALID_VEHICLES, ...VALID_MOVES];

  if (!route || route.length === 0) {
    return { valid: false, error: "Empty route" };
  }

  // Sprawdź czy pierwszy element jest pojazdem
  const startVehicle = route[0];
  if (!VALID_VEHICLES.includes(startVehicle)) {
    return { valid: false, error: `First element must be a vehicle name, got: "${startVehicle}"` };
  }

  // Znajdź start i cel
  let startRow = -1, startCol = -1, goalRow = -1, goalCol = -1;
  for (let r = 0; r < map.length; r++) {
    for (let c = 0; c < map[r].length; c++) {
      if (map[r][c] === "S") { startRow = r; startCol = c; }
      if (map[r][c] === "G") { goalRow = r; goalCol = c; }
    }
  }

  const vehicleMap = new Map(vehicles.map((v) => [v.name, v]));

  // Symuluj trasę krok po kroku
  let row = startRow;
  let col = startCol;
  let fuel = 10;
  let food = 10;
  let currentVehicle = vehicleMap.get(startVehicle)!;

  const dirDelta: Record<string, [number, number]> = {
    up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1],
  };

  for (let i = 1; i < route.length; i++) {
    const cmd = route[i];

    if (!VALID_COMMANDS.includes(cmd)) {
      return { valid: false, error: `Invalid command "${cmd}" at index ${i}` };
    }

    if (cmd === "dismount") {
      if (currentVehicle.name === "walk") {
        return { valid: false, error: `Cannot dismount when already walking (index ${i})` };
      }
      const walkVehicle = vehicleMap.get("walk");
      if (!walkVehicle) {
        return { valid: false, error: "No walk vehicle stats found" };
      }
      currentVehicle = walkVehicle;
      continue;
    }

    if (VALID_VEHICLES.includes(cmd)) {
      return { valid: false, error: `Cannot switch vehicle mid-route (index ${i}): "${cmd}". Use dismount instead.` };
    }

    // Krok ruchu
    const [dr, dc] = dirDelta[cmd];
    const newRow = row + dr;
    const newCol = col + dc;

    // Granice mapy
    if (newRow < 0 || newRow >= map.length || newCol < 0 || newCol >= map[0].length) {
      return {
        valid: false,
        error: `Out of bounds at step ${i}: move "${cmd}" from (${row},${col}) → (${newRow},${newCol})`,
      };
    }

    const tile = map[newRow][newCol];

    // Skały — całkowita blokada
    if (tile === "R") {
      return {
        valid: false,
        error: `Cannot enter rocks (R) at (${newRow},${newCol}) — step ${i}`,
      };
    }

    // Woda — tylko horse i walk
    if (tile === "W" && !currentVehicle.canCrossWater) {
      return {
        valid: false,
        error: `Vehicle "${currentVehicle.name}" cannot enter water (W) at (${newRow},${newCol}) — step ${i}. Use horse or walk.`,
      };
    }

    // Oblicz koszt
    let fuelCost = currentVehicle.fuelPerMove;
    const foodCost = currentVehicle.foodPerMove;

    // Drzewo — dodatkowe 0.2 paliwa dla silnikowych
    if (tile === "T" && fuelCost > 0) {
      fuelCost += 0.2;
    }

    fuel -= fuelCost;
    food -= foodCost;

    // Sprawdź czy zasoby nie przekroczyły limitu (nie spadły poniżej zera)
    if (fuel < -0.001) {
      return {
        valid: false,
        error: `Ran out of fuel at step ${i}: fuel=${fuel.toFixed(2)} (cost was ${fuelCost.toFixed(2)})`,
      };
    }
    if (food < -0.001) {
      return {
        valid: false,
        error: `Ran out of food at step ${i}: food=${food.toFixed(2)} (cost was ${foodCost.toFixed(2)})`,
      };
    }

    row = newRow;
    col = newCol;
  }

  // Sprawdź czy dotarliśmy do celu
  if (row !== goalRow || col !== goalCol) {
    return {
      valid: false,
      error: `Route ends at (${row},${col}) but goal is at (${goalRow},${goalCol})`,
    };
  }

  return {
    valid: true,
    fuelUsed: 10 - fuel,
    foodUsed: 10 - food,
  };
}

// =====================================================================
// FALLBACK: BFS (używany gdy LLM zawiedzie)
// =====================================================================

/**
 * Algorytm BFS jako fallback gdy LLM nie może znaleźć poprawnej trasy.
 *
 * Dlaczego BFS a nie tylko LLM?
 * - LLM może popełniać błędy matematyczne w złożonych ograniczeniach
 * - Zadanie wymagania deterministycznej poprawności
 * - "Defense in depth" — zawsze mamy backup
 *
 * W systemach produkcyjnych zawsze warto mieć fallback dla kluczowych operacji.
 */
function bfsFallback(map: TileType[][], vehicles: VehicleStats[]): string[] {
  log("[FALLBACK] Używam BFS jako fallback...", "INFO");

  let startRow = -1, startCol = -1;
  for (let r = 0; r < map.length; r++) {
    for (let c = 0; c < map[r].length; c++) {
      if (map[r][c] === "S") { startRow = r; startCol = c; }
    }
  }

  interface State {
    row: number; col: number;
    fuel: number; food: number;
    vehicle: string; commands: string[];
  }

  const vehicleMap = new Map(vehicles.map((v) => [v.name, v]));
  const queue: State[] = [];
  const visited = new Set<string>();

  for (const v of vehicles) {
    queue.push({ row: startRow, col: startCol, fuel: 10, food: 10, vehicle: v.name, commands: [v.name] });
  }

  const moves = [
    { dir: "up", dr: -1, dc: 0 }, { dir: "down", dr: 1, dc: 0 },
    { dir: "left", dr: 0, dc: -1 }, { dir: "right", dr: 0, dc: 1 },
  ];

  while (queue.length > 0) {
    queue.sort((a, b) => a.commands.length - b.commands.length);
    const cur = queue.shift()!;

    if (map[cur.row][cur.col] === "G") return cur.commands;

    const key = `${cur.row},${cur.col},${cur.vehicle},${Math.round(cur.fuel * 10)},${Math.round(cur.food * 10)}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const curV = vehicleMap.get(cur.vehicle)!;

    for (const { dir, dr, dc } of moves) {
      const nr = cur.row + dr, nc = cur.col + dc;
      if (nr < 0 || nr >= map.length || nc < 0 || nc >= map[0].length) continue;
      const tile = map[nr][nc];
      if (tile === "R") continue;
      if (tile === "W" && !curV.canCrossWater) continue;
      let fuelCost = curV.fuelPerMove;
      if (tile === "T" && fuelCost > 0) fuelCost += 0.2;
      const foodCost = curV.foodPerMove;
      if (cur.fuel < fuelCost - 0.001 || cur.food < foodCost - 0.001) continue;
      queue.push({
        row: nr, col: nc, fuel: cur.fuel - fuelCost, food: cur.food - foodCost,
        vehicle: cur.vehicle, commands: [...cur.commands, dir],
      });
    }

    if (cur.vehicle !== "walk") {
      const walkV = vehicleMap.get("walk")!;
      queue.push({
        row: cur.row, col: cur.col, fuel: cur.fuel, food: cur.food,
        vehicle: "walk", commands: [...cur.commands, "dismount"],
      });
    }
  }

  throw new Error("BFS nie znalazło trasy!");
}

// =====================================================================
// WYSYŁANIE ODPOWIEDZI
// =====================================================================

/** Wysyła finalną trasę do /verify */
async function submitAnswer(route: string[]): Promise<void> {
  log(`\n[VERIFY] Wysyłam odpowiedź: ${JSON.stringify(route)}`, "INFO");

  const result = await taskApiPost<{ code: number; message: string; flag?: string }>("/verify", {
    apikey: TASK_API_KEY,
    task: "savethem",
    answer: route,
  });

  log(`[VERIFY] Odpowiedź serwera: code=${result.code}, message="${result.message}"`, "INFO");

  // Flaga może być w polu "flag" lub wbudowana w "message" jako {FLG:...}
  const gotFlag = result.flag || (result.message && result.message.includes("FLG:"));
  if (gotFlag) {
    log(`[VERIFY] 🏆 FLAGA ZDOBYTA: ${result.flag || result.message}`, "SUCCESS");
  } else {
    log(`[VERIFY] Brak flagi w odpowiedzi. Code: ${result.code}`, "ERROR");
  }
}

// =====================================================================
// COORDINATOR — GŁÓWNA ORKIESTRACJA
// =====================================================================

/**
 * Coordinator uruchamia agenty w sekwencji i przekazuje dane między nimi.
 *
 * PRZEPŁYW:
 * 1. Scout zbiera wiedzę (mapa, pojazdy, zasady)  → WorldKnowledge
 * 2. Navigator planuje trasę używając WorldKnowledge → string[]
 * 3. Coordinator wysyła trasę do /verify
 *
 * Ta separacja pozwala na:
 * - Niezależne testowanie każdego agenta
 * - Podmienianie agentów (np. inny model dla Navigatora)
 * - Łatwe rozszerzanie (np. dodanie Validator agenta)
 */
async function runMultiAgentSystem(): Promise<void> {
  // Inicjalizacja logów
  fs.writeFileSync(LOG_FILE, "", "utf-8");
  log("═".repeat(60), "INFO");
  log("  SYSTEM MULTI-AGENTOWY: SaveThem", "INFO");
  log(`  Model: ${MODEL}`, "INFO");
  log("═".repeat(60), "INFO");

  log("\n📋 ARCHITEKTURA SYSTEMU:", "INFO");
  log("  Coordinator → ScoutAgent (ReAct) → WorldKnowledge", "INFO");
  log("  Coordinator → NavigatorAgent (CoT) → Route", "INFO");
  log("  Coordinator → /verify → Flaga\n", "INFO");

  try {
    // ── KROK 1: Scout zbiera wiedzę ──────────────────────────────
    const worldKnowledge = await runScoutAgent();

    log("\n[COORDINATOR] WorldKnowledge zebrana:", "INFO");
    log(`  - Mapa: ${worldKnowledge.map.length}x${worldKnowledge.map[0]?.length}`, "INFO");
    log(`  - Pojazdy: ${worldKnowledge.vehicles.map((v) => v.name).join(", ")}`, "INFO");
    log(`  - Zasady: ${worldKnowledge.rulesText.length} znaków`, "INFO");
    log(`  - Odkryte endpointy: ${worldKnowledge.discoveredEndpoints.join(", ")}`, "INFO");

    // ── KROK 2: Navigator planuje trasę ──────────────────────────
    const route = await runNavigatorAgent(worldKnowledge);

    log("\n[COORDINATOR] Trasa zaplanowana:", "INFO");
    log(`  Pojazd: ${route[0]}`, "INFO");
    log(`  Komendy: ${route.slice(1).join(" → ")}`, "INFO");

    // ── KROK 3: Wyślij odpowiedź ──────────────────────────────────
    await submitAnswer(route);
  } catch (error) {
    log(`[COORDINATOR] Błąd krytyczny: ${error instanceof Error ? error.message : String(error)}`, "ERROR");
    throw error;
  }

  log("\n" + "═".repeat(60), "INFO");
  log("  SYSTEM MULTI-AGENTOWY: KONIEC", "INFO");
  log("═".repeat(60), "INFO");
  log(`\nPlik logów: ${LOG_FILE}`, "INFO");
}

// ── Start ──────────────────────────────────────────────────────────────
runMultiAgentSystem().catch((err) => {
  console.error("Krytyczny błąd:", err);
  process.exit(1);
});
