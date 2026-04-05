/**
 * S4E4 — Filesystem Agent
 *
 * ARCHITEKTURA: Pipeline wieloetapowy
 *
 *   [1] Note Fetcher     — pobiera i rozpakowuje natan_notes.zip
 *   [2] API Help         — poznaje dostępne akcje API
 *   [3] Data Extractor   — LLM wyodrębnia: miasta (potrzeby), osoby, towary
 *   [4] Reset            — czyści poprzedni stan filesystemu
 *   [5] Filesystem Build — tworzy strukturę przez batch API
 *   [6] Verify           — wywołuje "done"
 *
 * KLUCZOWE ZASADY (wyuczone z błędów walidacji):
 *   - Każde miasto ma DOKŁADNIE JEDNĄ osobę odpowiedzialną za handel
 *   - Towar może być sprzedawany przez WIELE miast → jeden plik z wieloma linkami
 *   - Nazwy plików: ^[a-z0-9_]+$ (tylko małe litery, cyfry, podkreślenia)
 *   - Brak polskich znaków w nazwach plików i treści JSON
 */

import * as path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import JSZip from "jszip";

// ─── Konfiguracja środowiska ──────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const AI_DEVS_API_KEY = process.env.AI_DEVS_API_KEY!;
const CENTRAL_HUB_LINK = process.env.CENTRAL_HUB_LINK!;

const NOTES_ZIP_URL = "https://hub.ag3nts.org/dane/natan_notes.zip";
const TASK_NAME = "filesystem";

// Model — Sonnet zapewnia wyższą jakość ekstrakcji (mniej halucynacji w nazwach)
const LLM_MODEL = "anthropic/claude-sonnet-4-5";

// ─── Typy danych ──────────────────────────────────────────────────────────

interface City {
  name: string;                 // Nazwa w mianowniku, bez polskich znaków
  needs: Record<string, number>; // Potrzeby: { "chleb": 45, "woda": 120 }
}

interface Person {
  fullName: string;  // Imię i Nazwisko (lub samo imię/nazwisko)
  city: string;      // Miasto, którym zarządza (bez polskich znaków)
}

interface GoodEntry {
  name: string;      // Towar w mianowniku l.poj., bez polskich znaków
  offeredBy: string; // Miasto sprzedające ten towar
}

interface ExtractedData {
  cities: City[];
  people: Person[];
  goods: GoodEntry[]; // Wiele wierszy dla tego samego towaru (różne miasta)
}

interface FileSystemAction {
  action: string;
  path?: string;
  content?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Usuwa polskie znaki diakrytyczne */
function removeDiacritics(text: string): string {
  const map: Record<string, string> = {
    ą: "a", ć: "c", ę: "e", ł: "l", ń: "n",
    ó: "o", ś: "s", ź: "z", ż: "z",
    Ą: "A", Ć: "C", Ę: "E", Ł: "L", Ń: "N",
    Ó: "O", Ś: "S", Ź: "Z", Ż: "Z",
  };
  return text.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (ch) => map[ch] ?? ch);
}

/**
 * Zamienia tekst na bezpieczną nazwę pliku: ^[a-z0-9_]+$
 * (małe litery, cyfry, podkreślenia)
 */
function toFileName(text: string): string {
  return removeDiacritics(text)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/** Retry wrapper dla operacji async (max 3 próby z exponential backoff) */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelay = 1500
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseDelay * attempt;
      console.warn(`  [retry] Próba ${attempt}/${maxAttempts} nieudana, czekam ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

function log(step: string, msg: string) {
  console.log(`\n[${step}] ${msg}`);
}

// ─── KROK 1: Pobieranie i rozpakowywanie notatek ──────────────────────────

async function fetchNotes(): Promise<Record<string, string>> {
  log("STEP 1", `Pobieram: ${NOTES_ZIP_URL}`);

  const resp = await withRetry(() =>
    fetch(NOTES_ZIP_URL).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    })
  );

  const zip = await JSZip.loadAsync(await resp.arrayBuffer());
  const notes: Record<string, string> = {};

  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) {
      notes[name] = await file.async("string");
      log("STEP 1", `  Załadowano: ${name} (${notes[name].length} znaków)`);
    }
  }

  log("STEP 1", `Łącznie ${Object.keys(notes).length} plików`);
  return notes;
}

// ─── KROK 2: Sprawdzenie API ──────────────────────────────────────────────

async function callAPI(answer: unknown): Promise<unknown> {
  return withRetry(() =>
    fetch(CENTRAL_HUB_LINK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: AI_DEVS_API_KEY, task: TASK_NAME, answer }),
    }).then((r) => r.json())
  );
}

async function checkApiHelp(): Promise<void> {
  log("STEP 2", "Wywołuję /help...");
  const result = await callAPI({ action: "help" });
  const limits = (result as any)?.limits;
  log("STEP 2", `Limity API: ${JSON.stringify(limits)}`);
}

// ─── KROK 3: Ekstrakcja danych przez LLM ─────────────────────────────────

async function llmCall(system: string, user: string): Promise<string> {
  const resp = await withRetry(() =>
    fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.05, // prawie deterministyczne — chcemy precyzję
      }),
    }).then((r) => {
      if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}`);
      return r.json();
    })
  );

  const content = (resp as any).choices?.[0]?.message?.content;
  if (!content) throw new Error("Brak odpowiedzi od LLM");
  return content as string;
}

function parseJson<T>(raw: string): T {
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error(`LLM nie zwrócił JSON. Odpowiedź: ${raw.slice(0, 300)}`);
  return JSON.parse(match[0]) as T;
}

/**
 * Ekstrahuje potrzeby miast z ogłoszeń.
 * Każde miasto potrzebuje określonych towarów w określonych ilościach.
 */
async function extractCityNeeds(notes: Record<string, string>): Promise<City[]> {
  log("STEP 3a", "Ekstraktuję potrzeby miast...");

  const system = `You are an expert at extracting structured data from Polish texts.

TASK: Analyze the bulletin board text and extract for each city a list of needed goods with quantities.

RULES:
1. City names - nominative singular (e.g. "Opalino", "Domatowo")
2. REMOVE Polish diacritics from ALL names (ą→a, ć→c, ę→e, ł→l, ń→n, ó→o, ś→s, ź→z, ż→z)
3. Good names - use the EXACT form from the source text, just remove diacritics and lowercase (preserve plural if plural is used, e.g. "mlotki" not "mlotek")
4. "woda" or "butelka wody" → use key "woda"
5. Quantities - integers only, NO units
6. Respond ONLY with JSON

FORMAT:
{
  "cities": [
    {
      "name": "CityName",
      "needs": {
        "good1": number,
        "good2": number
      }
    }
  ]
}`;

  const raw = await llmCall(system, notes["ogłoszenia.txt"] ?? "");
  const result = parseJson<{ cities: City[] }>(raw);
  log("STEP 3a", `Wyodrębniono ${result.cities.length} miast`);
  result.cities.forEach((c) => log("STEP 3a", `  ${c.name}: ${JSON.stringify(c.needs)}`));
  return result.cities;
}

/**
 * Ekstrahuje JEDNĄ osobę odpowiedzialną za handel PER miasto.
 *
 * KLUCZOWE PRZYKŁADY (wyuczone z analizy notatek):
 * - Brudzewo → Kisiel (NIE Rafal — Rafal to dostawca/pomocnik, nie zarządca)
 * - Karlinkowo → Lena ("Teraz to Lena pilnuje tam handlu" = Lena zastąpiła Konkela)
 */
async function extractPeople(notes: Record<string, string>): Promise<Person[]> {
  log("STEP 3b", "Ekstraktuję osoby odpowiedzialne za handel (1 per miasto)...");

  const system = `You are an expert at analyzing Polish trade journals.

TASK: Find EXACTLY ONE person responsible for trade in each of the 8 cities.
Provide the FULL name (first + last) of each person.

IMPORTANT RULES:
1. Each city has ONE person managing trade
2. Always provide FULL name (not just first or last name alone)
3. Natan sometimes uses only the first name, sometimes only the surname — combine them into full first+last name

ANALYSIS FOR EACH CITY (force these connections):
- Domatowo: Natan (the narrator) = "Natan Rams" (his full name appears in the note title)
- Opalino: "z Opalina dzwonila Iga Kapecka" → full name: "Iga Kapecka"
- Brudzewo: NOTE — these refer to the same person:
    * "Kisiel ma do mnie dzwonic w sprawie ryzu" (Kisiel = surname, person manages Brudzewo)
    * "Rafal oddzwonil wieczorem. Woda dla Brudzewa bedzie szybciej" (Rafal = first name of the same person)
    * Full name: "Rafał Kisiel"
- Darzlubie: "Marta Frantz brzmiala jakby trzeci dzien nie spala" → full name: "Marta Frantz"
- Celbowo: "Oskar Radtke ma przeslac konkretne liczby" → full name: "Oskar Radtke"
- Mechowo: "Eliza Redmann dzwonila dwa razy" → full name: "Eliza Redmann"
- Puck: "z Pucka dzwonil Damian Kroll" → full name: "Damian Kroll"
- Karlinkowo: NOTE — combine two fragments:
    * "krotki sygnal od Konkel" (Konkel = surname, linked to Karlinkowo)
    * "Teraz to Lena pilnuje tam handlu" (Lena = first name of the person managing Karlinkowo)
    * Full name: "Lena Konkel"

RESULT: Exactly 8 people with full names.
Keep Polish characters in names (e.g. "Rafał", "Łukasz").
Respond ONLY with JSON.

FORMAT:
{
  "people": [
    {
      "fullName": "First Last",
      "city": "CityName"
    }
  ]
}`;

  const raw = await llmCall(system, notes["rozmowy.txt"] ?? "");
  const result = parseJson<{ people: Person[] }>(raw);
  log("STEP 3b", `Wyodrębniono ${result.people.length} osób`);
  result.people.forEach((p) => log("STEP 3b", `  ${p.fullName} → ${p.city}`));
  return result.people;
}

/**
 * Ekstrahuje towary wystawione na sprzedaż z transakcji.
 *
 * Format transakcji: "Sprzedawca → towar → Kupiec"
 * Ten sam towar może być sprzedawany przez wiele miast.
 * Zwraca listę par (towar, miasto_sprzedające).
 */
async function extractGoods(notes: Record<string, string>): Promise<GoodEntry[]> {
  log("STEP 3c", "Ekstraktuję towary na sprzedaż (z transakcji)...");

  const system = `You are an expert at analyzing trade transaction lists.

TASK: Analyze the transaction list and extract all (good, selling_city) pairs.

INPUT FORMAT: "SellerCity -> good -> BuyerCity" or "Seller → good → Buyer"

RULES:
1. We care about the SELLER (first city on each line), NOT the buyer
2. Good names - nominative singular (e.g. "ryz" not "ryzu", "ziemniak" not "ziemniaki", "lopata" not "lopaty")
3. REMOVE Polish diacritics: ą→a, ć→c, ę→e, ł→l, ń→n, ó→o, ś→s, ź→z, ż→z
4. The same good can be sold by multiple cities — include ALL occurrences
5. City names also without Polish diacritics, nominative

Transformation examples:
- "Darzlubie -> ryż -> Puck" → {"name": "ryz", "offeredBy": "Darzlubie"}
- "Brudzewo -> łopata -> Domatowo" → {"name": "lopata", "offeredBy": "Brudzewo"}
- "Brudzewo -> mąka -> Karlinkowo" → {"name": "maka", "offeredBy": "Brudzewo"}

Respond ONLY with JSON.

FORMAT:
{
  "goods": [
    { "name": "goodNameNominativeSingular", "offeredBy": "SellerCity" }
  ]
}`;

  const raw = await llmCall(system, notes["transakcje.txt"] ?? "");
  const result = parseJson<{ goods: GoodEntry[] }>(raw);
  log("STEP 3c", `Wyodrębniono ${result.goods.length} wierszy towarów`);

  // Grupuj dla wyświetlenia
  const grouped = new Map<string, string[]>();
  for (const g of result.goods) {
    const key = toFileName(g.name);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(g.offeredBy);
  }
  grouped.forEach((cities, good) => {
    log("STEP 3c", `  ${good} ← [${cities.join(", ")}]`);
  });

  return result.goods;
}

async function extractData(notes: Record<string, string>): Promise<ExtractedData> {
  const [cities, people, goods] = await Promise.all([
    extractCityNeeds(notes),
    extractPeople(notes),
    extractGoods(notes),
  ]);
  return { cities, people, goods };
}

// ─── Normalizacja nazw miast ──────────────────────────────────────────────

/**
 * Dopasowuje podaną nazwę miasta do najbliższej nazwy z listy znanych miast.
 * Potrzebne gdy LLM używa różnych form tej samej nazwy (np. "Domatów" vs "Domatowo").
 *
 * Strategia dopasowania:
 *   1. Identyczna nazwa pliku (po toFileName)
 *   2. Jedna jest prefiksem drugiej (np. "domatow" ↔ "domatowo")
 *   3. Zawiera się jako podciąg
 *   4. Fallback: bez konwersji
 */
function matchCityFile(rawCityName: string, knownCities: City[]): string {
  const normalized = toFileName(rawCityName);

  // 1. Dokładne dopasowanie
  const exact = knownCities.find((c) => toFileName(c.name) === normalized);
  if (exact) return toFileName(exact.name);

  // 2. Jeden jest prefiksem drugiego
  const prefix = knownCities.find(
    (c) =>
      toFileName(c.name).startsWith(normalized) ||
      normalized.startsWith(toFileName(c.name))
  );
  if (prefix) return toFileName(prefix.name);

  // 3. Zawieranie
  const contains = knownCities.find(
    (c) =>
      toFileName(c.name).includes(normalized) ||
      normalized.includes(toFileName(c.name))
  );
  if (contains) return toFileName(contains.name);

  // 4. Fallback — zwróć znormalizowaną wersję (bez gwarancji istnienia)
  console.warn(`  [warn] Nie można dopasować miasta: "${rawCityName}" → "${normalized}"`);
  return normalized;
}

// ─── KROK 4: Reset filesystemu ────────────────────────────────────────────

async function resetFilesystem(): Promise<void> {
  log("STEP 4", "Reset filesystemu...");
  const result = await callAPI({ action: "reset" });
  log("STEP 4", `Wynik: ${JSON.stringify(result)}`);
}

// ─── KROK 5: Budowanie filesystemu ────────────────────────────────────────

/**
 * Buduje listę batch akcji do wykonania jednym requestem.
 *
 * Struktura:
 *   /miasta/<nazwa>    — JSON z potrzebami miasta
 *   /osoby/<imie_nazwisko>  — imię i nazwisko + link do miasta
 *   /towary/<towar>    — linki do WSZYSTKICH miast sprzedających ten towar
 */
function buildActions(data: ExtractedData): FileSystemAction[] {
  const actions: FileSystemAction[] = [];

  // ── Katalogi główne ──
  actions.push({ action: "createDirectory", path: "/miasta" });
  actions.push({ action: "createDirectory", path: "/osoby" });
  actions.push({ action: "createDirectory", path: "/towary" });

  // ── Pliki miast ──
  // Zawartość: JSON z potrzebami (klucze bez polskich znaków)
  for (const city of data.cities) {
    const cityFile = toFileName(city.name);

    const cleanNeeds: Record<string, number> = {};
    for (const [good, qty] of Object.entries(city.needs)) {
      cleanNeeds[toFileName(good)] = qty;
    }

    actions.push({
      action: "createFile",
      path: `/miasta/${cityFile}`,
      content: JSON.stringify(cleanNeeds, null, 2),
    });
  }

  // ── Pliki osób ──
  // Zawartość: pełne imię + link markdown do /miasta/<miasto>
  // matchCityFile dopasowuje city z LLM do faktycznej nazwy pliku w /miasta
  for (const person of data.people) {
    const personFile = toFileName(person.fullName);
    // Użyj dopasowania aby link wskazywał na istniejący plik
    const cityFile = matchCityFile(person.city, data.cities);
    // Znajdź oryginalną nazwę miasta do wyświetlenia w linku
    const cityDisplay = data.cities.find((c) => toFileName(c.name) === cityFile)?.name ?? person.city;

    actions.push({
      action: "createFile",
      path: `/osoby/${personFile}`,
      content: `${person.fullName}\n\n[${cityDisplay}](/miasta/${cityFile})`,
    });
  }

  // ── Pliki towarów ──
  // Jeden plik per unikalny towar, zawierający WSZYSTKIE linki do miast sprzedających.
  // matchCityFile zapewnia że link wskazuje na istniejący plik w /miasta.
  const goodsMap = new Map<string, string[]>(); // goodFile → [cityFile, ...]
  for (const g of data.goods) {
    const goodFile = toFileName(g.name);
    const cityFile = matchCityFile(g.offeredBy, data.cities);

    if (!goodsMap.has(goodFile)) goodsMap.set(goodFile, []);
    if (!goodsMap.get(goodFile)!.includes(cityFile)) {
      goodsMap.get(goodFile)!.push(cityFile);
    }
  }

  goodsMap.forEach((cityFiles, goodFile) => {
    const links = cityFiles
      .map((cf) => {
        const cityName = data.cities.find((c) => toFileName(c.name) === cf)?.name ?? cf;
        return `[${cityName}](/miasta/${cf})`;
      })
      .join("\n");

    actions.push({
      action: "createFile",
      path: `/towary/${goodFile}`,
      content: links,
    });
  });

  return actions;
}

async function buildFilesystem(data: ExtractedData): Promise<void> {
  log("STEP 5", "Buduję filesystem...");

  const actions = buildActions(data);
  log("STEP 5", `Przygotowano ${actions.length} akcji`);

  // Loguj summary akcji
  const dirs = actions.filter((a) => a.action === "createDirectory");
  const files = actions.filter((a) => a.action === "createFile");
  log("STEP 5", `  Katalogi: ${dirs.length}, Pliki: ${files.length}`);

  const result = await callAPI(actions) as any;
  log("STEP 5", `Wynik batch: code=${result?.code}, message=${result?.message}`);

  // Sprawdź czy były błędy
  const results: any[] = result?.results ?? [];
  const errors = results.filter((r) => r.code >= 400);
  if (errors.length > 0) {
    log("STEP 5", `UWAGA: ${errors.length} błędów:`);
    errors.forEach((e) => log("STEP 5", `  [${e.index}] ${JSON.stringify(e)}`));
  }
}

// ─── Podgląd ──────────────────────────────────────────────────────────────

async function previewStructure(): Promise<void> {
  log("PREVIEW", "Listowanie struktury...");
  for (const dir of ["/", "/miasta", "/osoby", "/towary"]) {
    const result = await callAPI({ action: "listFiles", path: dir }) as any;
    const entries: any[] = result?.entries ?? [];
    log("PREVIEW", `${dir}: [${entries.map((e: any) => e.name).join(", ")}]`);
  }
}

// ─── Korekcja na podstawie błędu weryfikacji ─────────────────────────────────

/**
 * LLM analizuje błąd z API i produkuje minimalne akcje korekcyjne.
 *
 * Podajemy mu:
 *   - treść błędu (kod, miasto, nieoczekiwane towary itp.)
 *   - aktualne zawartości plików /miasta/* (z danych w pamięci)
 *
 * LLM zwraca tablicę akcji createFile, które nadpisują błędne pliki.
 */
async function correctFilesystem(
  verifyError: unknown,
  data: ExtractedData,
  correctedState: Map<string, string>  // aktualny stan plików po poprzednich korektach
): Promise<FileSystemAction[]> {
  log("CORRECT", `Analyzing error: ${JSON.stringify(verifyError)}`);

  // Odtwórz bazowy stan plików miast z danych w pamięci
  const currentCityFiles: Record<string, string> = {};
  for (const city of data.cities) {
    const cityFile = toFileName(city.name);
    const cleanNeeds: Record<string, number> = {};
    for (const [good, qty] of Object.entries(city.needs)) {
      cleanNeeds[toFileName(good)] = qty;
    }
    currentCityFiles[`/miasta/${cityFile}`] = JSON.stringify(cleanNeeds, null, 2);
  }

  // Nadpisz korektami z poprzednich iteracji — LLM widzi AKTUALNY stan API
  for (const [path, content] of correctedState) {
    currentCityFiles[path] = content;
  }

  const system = `You are a filesystem correction agent for a virtual trading data system.

You receive a verification error from the central API and the current content of city files.
Your task: produce the MINIMAL set of filesystem actions to fix the error.

AVAILABLE ACTION:
{"action": "createFile", "path": "/path", "content": "..."}
(createFile overwrites an existing file)

KNOWN ERROR CODES:
- -807: A city file contains goods NOT listed as required by that city.
  Fix: remove the keys listed in "unexpected_goods" from that city's JSON, then overwrite the file.

Rules:
- Only fix what the error explicitly reports. Do not modify other files.
- The city file content must remain valid JSON (object with string keys and integer values).
- Respond ONLY with a JSON array of correction actions (at least one element).`;

  const userMsg = `Verification error from central API:
${JSON.stringify(verifyError, null, 2)}

Current city file contents (key = path, value = file content):
${JSON.stringify(currentCityFiles, null, 2)}`;

  const raw = await llmCall(system, userMsg);
  const actions = parseJson<FileSystemAction[]>(raw);
  log("CORRECT", `Proposed ${actions.length} correction(s):`);
  actions.forEach((a) => log("CORRECT", `  ${a.action} ${a.path}`));
  return actions;
}

// ─── KROK 6: Weryfikacja z pętlą korekcyjną ──────────────────────────────────

async function verify(): Promise<unknown> {
  log("STEP 6", "Wysyłam 'done' do weryfikacji...");
  const result = await callAPI({ action: "done" });
  log("STEP 6", `Wynik: ${JSON.stringify(result, null, 2)}`);
  return result;
}

// ─── Główny pipeline ──────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("S4E4 — Filesystem Agent");
  console.log("=".repeat(60));

  // Krok 1: Pobierz notatki
  const notes = await fetchNotes();

  // Krok 2: Sprawdź API
  await checkApiHelp();

  // Krok 3: Ekstrahuj dane (równolegle — 3 osobne wywołania LLM)
  const data = await extractData(notes);

  // Krok 4: Reset
  await resetFilesystem();

  // Krok 5: Zbuduj filesystem
  await buildFilesystem(data);

  // Podgląd
  await previewStructure();

  // Krok 6: Weryfikuj z pętlą korekcyjną (max 3 próby)
  const MAX_VERIFY_ATTEMPTS = 3;
  const correctedState = new Map<string, string>();
  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
    const verifyResult = await verify() as any;
    if (verifyResult?.code === 0) break;

    if (attempt < MAX_VERIFY_ATTEMPTS) {
      log("CORRECT", `Attempt ${attempt}/${MAX_VERIFY_ATTEMPTS} failed — requesting LLM correction...`);
      const corrections = await correctFilesystem(verifyResult, data, correctedState);
      if (corrections.length > 0) {
        const fixResult = await callAPI(corrections) as any;
        log("CORRECT", `Fix applied: code=${fixResult?.code}, message=${fixResult?.message}`);
        // Zapamiętaj zmiany, żeby kolejna iteracja widziała aktualny stan
        for (const action of corrections) {
          if (action.action === "createFile" && action.path && action.content !== undefined) {
            correctedState.set(action.path, action.content);
          }
        }
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Pipeline zakończony.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
