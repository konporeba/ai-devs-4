/**
 * AGENT: Map Analyst (Analityk Mapy)
 *
 * Odpowiedzialność: pobierz surowe dane gry (dokumentację API + mapę) i wyprodukuj
 * strukturalną analizę identyfikującą:
 *   - priorytetowe cele poszukiwań (najwyższe budynki, gdzie ukrywa się partyzant)
 *   - układ ulic (po których mogą jeździć transportery)
 *   - pozycję startową jednostek
 *
 * Ten agent NIE planuje ruchów — to jest zadanie Stratega.
 *
 * Wzorzec użycia LLM: jeden prompt → jeden ustrukturyzowany JSON.
 * Jest to najprostszy możliwy sposób wykorzystania LLM jako "tłumacza"
 * między surową reprezentacją danych a ustrukturyzowaną wiedzą.
 */

import { logger } from "../utils/logger";
import { callLLM, extractJSON } from "../tools/openRouter";
import { getHelp, getMap } from "../tools/apiClient";

// ── Typy wyjściowe ────────────────────────────────────────────────────────────

/**
 * Reprezentacja pojedynczego pola mapy.
 * Każde pole na siatce 11×11 opisane jest symbolem z legendy.
 */
export interface MapCell {
  coord: string;       // np. "C3" — kolumna C, wiersz 3
  symbol: string;      // surowy symbol z mapy (np. "B3" = wysoki budynek)
  description: string; // czytelny opis terenu
  passableByTransporter: boolean; // czy transporter może tu wjechać?
  passableByScout: boolean;       // czy zwiadowca może tu wejść pieszo?
}

/**
 * Wynik analizy mapy zwracany przez agenta.
 * Wszystkie dane są już przetworzone przez LLM — nie ma tu surowych odpowiedzi API.
 */
export interface MapAnalysis {
  /** Pola najprawdopodobniej zawierające partyzanta, posortowane wg priorytetu (1 = najwyższy). */
  priorityTargets: Array<{
    coord: string;
    reason: string;
    priority: number;
  }>;
  /** Wszystkie pola z ulicami/drogami — po nich jeżdżą transportery. */
  streetCells: string[];
  /** Pozycja startowa jednostek (zazwyczaj A1 lub podobna). */
  startPosition: string;
  /** Dekodowana legenda symboli z odpowiedzi help. */
  symbolLegend: Record<string, string>;
  /** Pełna siatka jako tablica 2D — do programatycznego przetwarzania. */
  grid: string[][];
  /** Etykiety kolumn (np. ["A","B",...,"K"]) */
  columns: string[];
  /** Etykiety wierszy (np. ["1","2",...,"11"]) */
  rows: string[];
  /** Krótkie podsumowanie mapy i uzasadnienie w języku naturalnym. */
  summary: string;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

/**
 * Główna funkcja agenta Map Analyst.
 *
 * Kroki:
 *   1. Pobierz dokumentację akcji (help) i mapę z API gry
 *   2. Wyślij oba dokumenty do LLM z pytaniem o analizę
 *   3. Sparsuj JSON zwrócony przez LLM i zwróć jako MapAnalysis
 */
export async function runMapAnalyst(
  gameApiKey: string,
  openRouterApiKey: string
): Promise<MapAnalysis> {
  logger.separator("MAP ANALYST — Start");
  logger.info("MAP_ANALYST", "Fetching help documentation and map from API...");

  // ── Krok 1: Pobierz surowe dane z API ─────────────────────────────────────
  // getHelp() → co możemy robić (akcje, koszty, format poleceń)
  // getMap()  → aktualna siatka terenu 11×11

  const helpResponse = await getHelp(gameApiKey);
  const mapResponse  = await getMap(gameApiKey);

  logger.info("MAP_ANALYST", "Raw data fetched successfully.");

  // ── Krok 2: Poproś LLM o analizę mapy ────────────────────────────────────
  //
  // System prompt definiuje ROLĘ modelu i FORMAT odpowiedzi.
  // User prompt dostarcza DANE do analizy.
  //
  // Dlaczego LLM zamiast kodu?
  // Bo interpretacja symboli mapy i wnioskowanie "który budynek jest najwyższy"
  // wymaga rozumienia języka i kontekstu — LLM radzi sobie z tym naturalnie.

  const systemPrompt = `
You are the Map Analyst for a military rescue operation.
Your job is to analyse a tactical map of a destroyed city called Domatowo and identify:
1. The most likely hiding spots for a wounded partisan who said he is hiding in "one of the tallest buildings".
2. All cells passable by transporters (streets/roads).
3. The starting position for units.

You must return ONLY valid JSON — no markdown fences, no prose.

Return this exact structure:
{
  "priorityTargets": [
    { "coord": "X0", "reason": "...", "priority": 1 },
    ...
  ],
  "streetCells": ["A1", "A2", ...],
  "startPosition": "A1",
  "symbolLegend": { "SYMBOL": "description", ... },
  "grid": [["A1_symbol","A2_symbol",...], ...],
  "columns": ["A","B",...],
  "rows": ["1","2",...],
  "summary": "Plain-text summary of the map and reasoning..."
}

Rules:
- priorityTargets must be ordered by priority (1 = most likely location).
- Include ALL tall building cells in priorityTargets.
- streetCells must include every cell a wheeled transporter can traverse.
- coords use column letter + row number, e.g. "C3" (column C, row 3).
`.trim();

  const userPrompt = `
HELP / API DOCUMENTATION:
${JSON.stringify(helpResponse, null, 2)}

MAP DATA:
${JSON.stringify(mapResponse, null, 2)}

INTERCEPTED AUDIO CLUE:
"I survived. Bombs destroyed the city. Soldiers were here, searching for resources, they took the oil. Now it's empty. I have a weapon, I am wounded. I hid in one of the tallest buildings. I have no food. Help."

Analyse the map and return the JSON as instructed.
`.trim();

  // Wywołanie LLM — jeden prompt, jedna odpowiedź (nie pętla ReAct)
  const rawAnalysis = await callLLM(
    "MAP_ANALYST",
    openRouterApiKey,
    [
      { role: "system",    content: systemPrompt },
      { role: "user",      content: userPrompt   },
    ],
    "Analyse map terrain and identify priority targets"
  );

  // ── Krok 3: Parsuj i waliduj odpowiedź LLM ───────────────────────────────
  //
  // extractJSON<T> usuwa znaczniki markdown (```json ... ```) jeśli LLM je dodał,
  // a następnie parsuje JSON. Rzuca błąd jeśli JSON jest niepoprawny.

  let analysis: MapAnalysis;
  try {
    analysis = extractJSON<MapAnalysis>(rawAnalysis);
  } catch (err) {
    logger.error("MAP_ANALYST", "Failed to parse LLM JSON response", { rawAnalysis, err });
    throw new Error("MapAnalyst: LLM returned invalid JSON");
  }

  logger.success(
    "MAP_ANALYST",
    `Analysis complete — ${analysis.priorityTargets.length} priority targets identified`,
    {
      targets:    analysis.priorityTargets,
      startPos:   analysis.startPosition,
      streetCount: analysis.streetCells.length,
      summary:    analysis.summary,
    }
  );

  logger.separator("MAP ANALYST — Done");
  return analysis;
}
