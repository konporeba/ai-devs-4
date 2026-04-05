/**
 * OPERACJA DOMATOWO — Orkiestrator
 * =========================================
 * AI Devs 4 — S04E03: Współpraca kontekstowa agentów AI
 *
 * Architektura: pipeline 3 agentów sekwencyjnych
 *   1. Map Analyst  — odczytuje i interpretuje mapę taktyczną 11×11
 *   2. Strategist   — projektuje optymalny plan operacji w budżecie 300 AP
 *   3. Executor     — realizuje plan przez pętlę ReAct, odnajduje partyzanta
 *
 * Każdy agent ma jedną, izolowaną odpowiedzialność (wzorzec Single Responsibility).
 * Komunikacja między agentami odbywa się przez czyste, typowane obiekty TypeScript —
 * nie ma żadnego wspólnego, mutowalnego stanu (shared mutable state).
 *
 * Schemat przepływu danych:
 *   runMapAnalyst() → MapAnalysis
 *                         ↓
 *   runStrategist(mapAnalysis) → OperationPlan
 *                                      ↓
 *   runExecutor(operationPlan) → string | null (FLAG)
 */

import "dotenv/config";
import { logger }        from "./utils/logger";
import { runMapAnalyst } from "./agents/mapAnalyst";
import { runStrategist } from "./agents/strategist";
import { runExecutor }   from "./agents/executor";

// ── Walidacja zmiennych środowiskowych ────────────────────────────────────────

/**
 * Pomocnicza funkcja: pobiera wartość zmiennej środowiskowej lub rzuca błąd.
 * Dzięki temu od razu wiemy, czego brakuje, zanim zaczniemy właściwe działanie.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

// ── Orkiestrator ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.separator("OPERATION DOMATOWO");
  logger.info("ORCHESTRATOR", "Starting multi-agent rescue operation...");

  // Pobieramy klucze API ze zmiennych środowiskowych (.env)
  const gameApiKey       = requireEnv("AI_DEVS_API_KEY");
  const openRouterApiKey = requireEnv("OPENROUTER_API_KEY");

  // ── Etap 1: Map Analyst ───────────────────────────────────────────────────
  //
  // Agent Analityk Mapy pobiera surowe dane z API gry i zleca LLM
  // identyfikację priorytetowych celów (wysokie budynki), układu ulic
  // i pozycji startowej. Zwraca czysty, ustrukturyzowany obiekt MapAnalysis.
  //
  logger.info("ORCHESTRATOR", "Stage 1/3 — Map Analyst starting...");
  const mapAnalysis = await runMapAnalyst(gameApiKey, openRouterApiKey);
  logger.info("ORCHESTRATOR", "Stage 1/3 — Map Analyst complete.", {
    targets: mapAnalysis.priorityTargets.length,
    streets: mapAnalysis.streetCells.length,
  });

  // ── Etap 2: Strategist ────────────────────────────────────────────────────
  //
  // Agent Strateg otrzymuje TYLKO analizę mapy (nie surowe dane API) i
  // produkuje OperationPlan: jakie jednostki stworzyć, jakimi trasami jechać,
  // w jakiej kolejności sprawdzać pola — wszystko w budżecie 300 AP.
  //
  logger.info("ORCHESTRATOR", "Stage 2/3 — Strategist starting...");
  const operationPlan = await runStrategist(mapAnalysis, openRouterApiKey);
  logger.info("ORCHESTRATOR", "Stage 2/3 — Strategist complete.", {
    estimatedCost: operationPlan.totalEstimatedCost,
    inspections:   operationPlan.inspectionOrder.length,
  });

  // ── Etap 3: Executor ──────────────────────────────────────────────────────
  //
  // Agent Wykonawca realizuje plan krok po kroku, obserwuje odpowiedzi API
  // i pyta LLM o interpretację polskojęzycznych logów rekonesansu.
  // Gdy partyzant zostanie znaleziony, wzywa helikopter i pobiera flagę.
  //
  logger.info("ORCHESTRATOR", "Stage 3/3 — Executor starting...");
  const flag = await runExecutor(operationPlan, gameApiKey, openRouterApiKey);

  // ── Wynik końcowy ─────────────────────────────────────────────────────────

  logger.separator("OPERATION RESULT");
  if (flag) {
    logger.success("ORCHESTRATOR", `Mission accomplished! FLAG: ${flag}`);
  } else {
    logger.warn("ORCHESTRATOR", "Mission ended without a confirmed flag. Check logs for details.");
  }

  // Zamykamy strumień zapisu logu do pliku
  logger.close();
}

// ── Punkt wejścia ─────────────────────────────────────────────────────────────

// Uruchamiamy main() i obsługujemy nieoczekiwane błędy na najwyższym poziomie
main().catch(err => {
  logger.error("ORCHESTRATOR", "Unhandled error", {
    message: err instanceof Error ? err.message : String(err),
    stack:   err instanceof Error ? err.stack   : undefined,
  });
  logger.close();
  process.exit(1);
});
