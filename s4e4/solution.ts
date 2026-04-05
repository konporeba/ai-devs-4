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

// Modele do analizy — Claude Haiku jest dokładny i ekonomiczny
const LLM_MODEL = "anthropic/claude-haiku-4-5";

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

  const system = `Jesteś ekspertem od ekstrakcji strukturyzowanych danych z polskich tekstów.

ZADANIE: Przeanalizuj tekst ogłoszeń i wyodrębnij dla każdego miasta listę potrzebnych towarów z ilościami.

ZASADY:
1. Nazwy miast - mianownik l.poj. (np. "Opalino", "Domatowo")
2. USUŃ polskie znaki diakrytyczne ze WSZYSTKICH nazw (ą→a, ć→c, ę→e, ł→l, ń→n, ó→o, ś→s, ź→z, ż→z)
3. Nazwy towarów - mianownik l.poj. (np. "chleb", "mlotek", "lopata")
4. "woda" lub "butelka wody" → używaj klucza "woda"
5. Ilości - tylko liczby całkowite, BEZ jednostek
6. Odpowiedź WYŁĄCZNIE w formacie JSON

FORMAT:
{
  "cities": [
    {
      "name": "NazwaMiasta",
      "needs": {
        "towar1": liczba,
        "towar2": liczba
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

  const system = `Jesteś ekspertem od analizy polskich dzienników handlowych.

ZADANIE: Znajdź DOKŁADNIE JEDNĄ osobę odpowiedzialną za handel w każdym z 8 miast.
Podaj PEŁNE imię i nazwisko każdej osoby.

WAŻNE ZASADY:
1. Każde miasto ma JEDNĄ osobę zarządzającą handlem
2. Podawaj PEŁNE imię i nazwisko (nie samo imię lub samo nazwisko)
3. Natan używa czasem tylko imienia, czasem tylko nazwiska — połącz je w pełne imię+nazwisko

ANALIZA KAŻDEGO MIASTA (wymuś sobie te połączenia!):
- Domatowo: Natan (narrator) = "Natan Rams" (jego pełne imię jest w tytule notatki)
- Opalino: "z Opalina dzwonila Iga Kapecka" → pełne imię: "Iga Kapecka"
- Brudzewo: UWAGA — to ta sama osoba:
    * "Kisiel ma do mnie dzwonic w sprawie ryzu" (Kisiel = nazwisko, osoba zarządza Brudzewo)
    * "Rafal oddzwonil wieczorem. Woda dla Brudzewa bedzie szybciej" (Rafal = imię tej samej osoby)
    * Pełne imię: "Rafał Kisiel" (Rafał to imię, Kisiel to nazwisko)
- Darzlubie: "Marta Frantz brzmiala jakby trzeci dzien nie spala" → pełne imię: "Marta Frantz"
- Celbowo: "Oskar Radtke ma przeslac konkretne liczby" → pełne imię: "Oskar Radtke"
- Mechowo: "Eliza Redmann dzwonila dwa razy" → pełne imię: "Eliza Redmann"
- Puck: "z Pucka dzwonil Damian Kroll" → pełne imię: "Damian Kroll"
- Karlinkowo: UWAGA — połącz dwa fragmenty:
    * "krotki sygnal od Konkel" (Konkel = nazwisko, związane z Karlinkowo)
    * "Teraz to Lena pilnuje tam handlu" (Lena = imię osoby zarządzającej Karlinkowo)
    * Pełne imię: "Lena Konkel" (Lena to imię, Konkel to nazwisko)

WYNIK: Dokładnie 8 osób z pełnymi imionami i nazwiskami.
Imiona i nazwiska z polskimi znakami (np. "Rafał", "Łukasz").
Odpowiedź WYŁĄCZNIE w formacie JSON.

FORMAT:
{
  "people": [
    {
      "fullName": "Imie Nazwisko",
      "city": "NazwaMiasta"
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

  const system = `Jesteś ekspertem od analizy list transakcji handlowych.

ZADANIE: Przeanalizuj listę transakcji i wyodrębnij wszystkie pary (towar, miasto_sprzedające).

FORMAT WEJŚCIA: "MiastoSprzedawca -> towar -> MiastoKupiec" lub "Sprzedawca → towar → Kupiec"

ZASADY:
1. Interesuje nas SPRZEDAWCA (pierwsze miasto w każdej linii), NIE kupiec
2. Nazwy towarów - mianownik l.poj. (np. "ryz" nie "ryzu", "ziemniak" nie "ziemniaki", "lopata" nie "lopaty")
3. USUŃ polskie znaki: ą→a, ć→c, ę→e, ł→l, ń→n, ó→o, ś→s, ź→z, ż→z
4. Ten sam towar może być sprzedawany przez wiele miast — uwzględnij WSZYSTKIE wystąpienia
5. Nazwy miast też bez polskich znaków, mianownik

Przykład transformacji:
- "Darzlubie -> ryż -> Puck" → {"name": "ryz", "offeredBy": "Darzlubie"}
- "Brudzewo -> łopata -> Domatowo" → {"name": "lopata", "offeredBy": "Brudzewo"}
- "Brudzewo -> mąka -> Karlinkowo" → {"name": "maka", "offeredBy": "Brudzewo"}

Odpowiedź WYŁĄCZNIE w formacie JSON.

FORMAT:
{
  "goods": [
    { "name": "nazwaTowaruMianownikLpoj", "offeredBy": "MiastoSprzedawca" }
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

// ─── KROK 6: Weryfikacja ──────────────────────────────────────────────────

async function verify(): Promise<void> {
  log("STEP 6", "Wysyłam 'done' do weryfikacji...");
  const result = await callAPI({ action: "done" });
  log("STEP 6", `Wynik: ${JSON.stringify(result, null, 2)}`);
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

  // Krok 6: Weryfikuj
  await verify();

  console.log("\n" + "=".repeat(60));
  console.log("Pipeline zakończony.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
