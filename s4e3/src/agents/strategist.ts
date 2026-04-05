/**
 * AGENT: Strategist (Strateg)
 *
 * Odpowiedzialność: zaprojektuj konkretny, świadomy kosztów plan operacji.
 * Agent TYLKO planuje — nie dotyka API gry, nie porusza jednostkami.
 *
 * Zasady projektowania planu:
 *   - Zwiadowcy ZAWSZE jadą wewnątrz transporterów (nie tworzymy ich samodzielnie)
 *   - Jeden transporter zajmuje JEDEN slot startowy niezależnie od liczby pasażerów
 *   - Maks. 4 transportery, maks. 4 pasażerów każdy = do 16 zwiadowców teoretycznie
 *   - Twardy limit: łącznie max 8 zwiadowców we wszystkich misjach
 *   - Budżet: 300 AP na całą operację
 *
 * Wzorzec użycia LLM: jeden prompt → jeden JSON z planem misji.
 * LLM musi tutaj "myśleć" — optymalizuje trasę, liczy koszty AP, respektuje ograniczenia.
 */

import { logger } from "../utils/logger";
import { callLLM, extractJSON } from "../tools/openRouter";
import { MapAnalysis } from "./mapAnalyst";

// ── Stałe z ograniczeniami zasobów ───────────────────────────────────────────

/**
 * Limity zasobów dostępnych podczas operacji.
 * Używamy `as const`, żeby TypeScript traktował te wartości jako literały —
 * nie można ich przypadkowo nadpisać.
 */
export const RESOURCE_LIMITS = {
  maxTransporters:    4,
  maxPassengersEach:  4,
  maxScoutsTotal:     8,  // twardy globalny limit — suma pasażerów we wszystkich misjach ≤ 8
  totalActionPoints: 300,
} as const;

/**
 * Koszty poszczególnych akcji w punktach akcji (AP).
 * Przekazujemy je do promptu LLM, żeby model mógł dokładnie wyliczyć budżet.
 */
export const ACTION_COSTS = {
  createTransporter:      5,  // koszt bazowy stworzenia transportera
  transporterPassenger:   5,  // dodatkowy koszt za każdego pasażera (zwiadowcę)
  transporterMovePerCell: 1,  // ruch transportera po drodze — bardzo tani
  scoutMovePerCell:       7,  // ruch zwiadowcy pieszo — bardzo drogi, minimalizować!
  inspect:                1,  // inspekcja pola przez zwiadowcę
  dismount:               0,  // wysadzenie zwiadowców — bezpłatne
} as const;

// ── Typy wyjściowe ────────────────────────────────────────────────────────────

/**
 * Jedna misja transportera:
 * załaduj N zwiadowców → jedź do strefy docelowej → wysadź → zwiadowcy sprawdzają pola.
 *
 * UWAGA: samodzielni zwiadowcy nigdy nie są tworzeni — zawsze jadą w transporterze.
 * Dzięki temu jeden slot startowy = jeden transporter z całą załogą.
 */
export interface TransporterMission {
  /** Liczba zwiadowców do załadowania (1–4). */
  passengers: number;
  /**
   * Docelowe pole, do którego jedzie transporter przed wysadzeniem.
   * Gra automatycznie oblicza trasę drogową — podajemy tylko cel.
   */
  destination: string;
  /**
   * Pola do sprawdzenia przez wysadzonych zwiadowców.
   * Każdy zwiadowca dostaje jedno pole. Długość musi równać się passengers.
   */
  inspectCells: string[];
  /** Szacowany koszt AP dla całej tej misji. */
  estimatedCost: number;
}

/**
 * Kompletny plan operacji produkowany przez Stratega.
 * To jest "kontrakt" przekazywany do agenta Executor.
 */
export interface OperationPlan {
  missions:           TransporterMission[];
  totalEstimatedCost: number;
  /** Płaska, uporządkowana lista wszystkich pól do sprawdzenia (do śledzenia postępu). */
  inspectionOrder:    string[];
  /** Uzasadnienie planu w języku naturalnym. */
  rationale:          string;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

/**
 * Główna funkcja agenta Strategist.
 *
 * Kroki:
 *   1. Zbuduj szczegółowy system prompt z ograniczeniami i kosztami
 *   2. Prześlij analizę mapy do LLM i poproś o plan
 *   3. Sparsuj JSON i opcjonalnie ostrzeż o przekroczeniu budżetu AP
 */
export async function runStrategist(
  mapAnalysis: MapAnalysis,
  openRouterApiKey: string
): Promise<OperationPlan> {
  logger.separator("STRATEGIST — Start");
  logger.info("STRATEGIST", "Building operation plan from map analysis...", {
    priorityTargets: mapAnalysis.priorityTargets.length,
    streetCells:     mapAnalysis.streetCells.length,
    startPosition:   mapAnalysis.startPosition,
  });

  // ── System prompt: rola + reguły + koszty ────────────────────────────────
  //
  // Przekazujemy stałe z kodu (RESOURCE_LIMITS, ACTION_COSTS) bezpośrednio
  // do promptu — dzięki temu jeśli zmienimy ograniczenia w kodzie,
  // LLM automatycznie dostaje zaktualizowane wartości.

  const systemPrompt = `
You are the Operations Strategist for a military rescue mission.
You receive a tactical map analysis and produce an operation plan.

RESOURCE LIMITS:
- Max transporters: ${RESOURCE_LIMITS.maxTransporters}
- Max scouts per transporter: ${RESOURCE_LIMITS.maxPassengersEach}
- Max scouts TOTAL across ALL missions: ${RESOURCE_LIMITS.maxScoutsTotal} (HARD LIMIT — sum of all passengers must be ≤ 8!)
- Total action points (AP): ${RESOURCE_LIMITS.totalActionPoints}

ACTION COSTS:
- Create transporter (base): ${ACTION_COSTS.createTransporter} AP
- Each scout passenger: ${ACTION_COSTS.transporterPassenger} AP
- Transporter move: ${ACTION_COSTS.transporterMovePerCell} AP/cell (road-only path, auto-calculated)
- Scout move on foot: ${ACTION_COSTS.scoutMovePerCell} AP/cell (VERY EXPENSIVE — keep short!)
- Dismount scouts: ${ACTION_COSTS.dismount} AP (FREE)
- Inspect cell: ${ACTION_COSTS.inspect} AP

CRITICAL RULES:
1. NEVER create standalone scouts. ALL scouts must be passengers inside a transporter.
   Reason: standalone scouts each need their own spawn slot (only 4 total).
   A transporter with 4 passengers uses just 1 spawn slot and gives 4 scouts.
2. Total scouts across ALL missions MUST NOT exceed 8.
   Example valid distributions: 4+4, 4+3+1, 3+3+2, 2+2+2+2
   Example INVALID: 4+4+3 (sum=11 > 8) — the game will REJECT the 3rd transporter.
3. After driving to the target area, DISMOUNT scouts (free action).
   The scouts then walk short distances (1–2 cells max) to inspect tall buildings.
4. Each transporter destination should be a ROAD CELL adjacent to the target buildings.
5. Assign exactly one inspect cell per scout (length of inspectCells = passengers).
6. With 8 scouts total and 30 priority targets, pick the 8 most important cells.

Return ONLY valid JSON — no markdown fences, no prose:
{
  "missions": [
    {
      "passengers": 4,
      "destination": "E1",
      "inspectCells": ["F1", "G1", "F2", "G2"],
      "estimatedCost": 30
    }
  ],
  "totalEstimatedCost": 120,
  "inspectionOrder": ["F1","G1","F2","G2",...],
  "rationale": "Brief explanation..."
}

estimatedCost per mission = createTransporter + (passengers × 5) + (transporter travel cells × 1) + (scout foot travel × 7) + (inspections × 1)
`.trim();

  // ── User prompt: dane do planowania ──────────────────────────────────────
  //
  // Strateg NIE dostaje surowych danych API — tylko wynik pracy Map Analyst.
  // To jest celowa izolacja kontekstu: każdy agent widzi tylko to, co potrzebuje.

  const userPrompt = `
MAP ANALYSIS:
${JSON.stringify(mapAnalysis, null, 2)}

Design the operation plan. Focus: reach tall buildings fast with transporters,
minimal scout foot travel. Prioritise highest-priority targets first.
`.trim();

  // Wywołanie LLM — jeden prompt, jeden JSON z planem
  const rawPlan = await callLLM(
    "STRATEGIST",
    openRouterApiKey,
    [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ],
    "Design optimal operation plan within 300 AP budget"
  );

  // ── Parsowanie odpowiedzi LLM ─────────────────────────────────────────────

  let plan: OperationPlan;
  try {
    plan = extractJSON<OperationPlan>(rawPlan);
  } catch (err) {
    logger.error("STRATEGIST", "Failed to parse LLM JSON response", { rawPlan, err });
    throw new Error("Strategist: LLM returned invalid JSON");
  }

  // Ostrzeżenie jeśli LLM zaplanował za drogo — plan nadal zostaje przekazany,
  // ale Executor może wyczerpać AP przed zakończeniem operacji
  if (plan.totalEstimatedCost > RESOURCE_LIMITS.totalActionPoints) {
    logger.warn(
      "STRATEGIST",
      `Plan exceeds AP budget! Estimated: ${plan.totalEstimatedCost}, Limit: ${RESOURCE_LIMITS.totalActionPoints}`
    );
  }

  logger.success("STRATEGIST", "Operation plan ready", {
    missions:           plan.missions.length,
    totalEstimatedCost: plan.totalEstimatedCost,
    inspectionOrder:    plan.inspectionOrder,
    rationale:          plan.rationale,
  });

  logger.separator("STRATEGIST — Done");
  return plan;
}
