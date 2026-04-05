/**
 * AGENT: Executor (Wykonawca)
 *
 * Odpowiedzialność: mechaniczne, krok po kroku wykonanie planu operacji.
 *
 * Ten agent NIE pyta LLM o decyzje ruchowe — trasy są już ustalone przez Stratega.
 * LLM jest używany TYLKO do interpretacji polskojęzycznych wpisów z logów rekonesansu,
 * bo proste dopasowanie słów kluczowych jest zawodne przy negacjach i wariantach języka.
 *
 * Wzorzec ReAct (Reasoning + Acting):
 *   Obserwacja (log z API) → Rozumowanie (LLM: czy partyzant jest obecny?) → Akcja (jedź dalej lub wezwij helikopter)
 *
 * Przepływ wykonania:
 *   Faza 0: Reset gry (czyści stary stan)
 *   Faza 1+2: Dla każdej misji z planu:
 *              Stwórz transporter → Jedź do strefy → Wysadź zwiadowców → Sprawdź pola
 *   Faza 3: Sweep — reużyj zwiadowców do przeszukania pozostałych pól
 */

import { logger } from "../utils/logger";
import { callLLM, extractJSON } from "../tools/openRouter";
import { OperationPlan, TransporterMission } from "./strategist";
import {
  createTransporter,
  moveUnit,
  dismountScouts,
  inspectCell,
  getObjects,
  getLogs,
  callHelicopter,
  resetGame,
  ApiResponse,
} from "../tools/apiClient";

// ── Typy wewnętrzne ───────────────────────────────────────────────────────────

/**
 * Stan jednej jednostki na planszy (transporter lub zwiadowca).
 */
interface UnitState {
  id:         string;
  type:       "transporter" | "scout";
  position:   string;         // aktualna pozycja na planszy, np. "E4"
  scoutCrewIds: string[];     // ID zwiadowców na pokładzie (tylko dla transporterów)
}

/**
 * Globalny stan Executora — aktualizowany po każdej akcji API.
 * Nie ma tu żadnych wywołań LLM, tylko czyste dane operacyjne.
 */
interface ExecutorState {
  units:             Map<string, UnitState>; // mapa: id → stan jednostki
  actionPointsLeft:  number;                // aktualizowany z każdej odpowiedzi API
  inspectedCells:    Map<string, ApiResponse>; // pola już sprawdzone → ich odpowiedź
  partisanFound:     boolean;
  partisanLocation:  string | null;
  flag:              string | null;
}

/**
 * Wynik interpretacji logu rekonesansu przez LLM.
 * LLM zwraca JSON z tymi dokładnie polami.
 */
interface InspectInterpretation {
  partisanPresent: boolean;
  reasoning:       string;
}

// ── Główny Agent ──────────────────────────────────────────────────────────────

/**
 * Główna funkcja agenta Executor.
 * Zwraca flagę jeśli misja zakończyła się sukcesem, lub null jeśli partyzant
 * nie został znaleziony w dostępnym budżecie AP.
 */
export async function runExecutor(
  plan: OperationPlan,
  gameApiKey: string,
  openRouterApiKey: string
): Promise<string | null> {
  logger.separator("EXECUTOR — Start");
  logger.info("EXECUTOR", "Starting mechanical execution of operation plan", {
    missions:        plan.missions.length,
    inspectionOrder: plan.inspectionOrder,
    estimatedCost:   plan.totalEstimatedCost,
  });

  // Stan początkowy — jednostki nie istnieją, mamy pełen budżet 300 AP
  const state: ExecutorState = {
    units:            new Map(),
    actionPointsLeft: 300,
    inspectedCells:   new Map(),
    partisanFound:    false,
    partisanLocation: null,
    flag:             null,
  };

  // ── Faza 0: Reset gry ─────────────────────────────────────────────────────
  //
  // Czyści pozostałości po poprzedniej sesji: usuwa stare jednostki,
  // przywraca 300 AP i losuje nową pozycję partyzanta na planszy.
  // Jeśli reset nie powiedzie się, kontynuujemy — gra może być już czysta.

  logger.info("EXECUTOR", "Phase 0: Resetting game state...");
  try {
    const r = await resetGame(gameApiKey);
    logger.info("EXECUTOR", "Game reset OK.", { message: r.message });
  } catch (err) {
    logger.warn("EXECUTOR", "Reset failed — proceeding anyway.", { err: String(err) });
  }

  // ── Faza 1 + 2: Realizacja misji transporterowych ────────────────────────
  //
  // Każda misja z planu Stratega jest realizowana sekwencyjnie.
  // Przerywamy wcześniej jeśli:
  //   a) partyzant już znaleziony (nie ma po co dalej)
  //   b) zostało mniej niż 20 AP (za mało na cokolwiek użytecznego)

  const deployedScoutIds: string[] = []; // zbieramy ID zwiadowców ze wszystkich misji

  for (let mIdx = 0; mIdx < plan.missions.length; mIdx++) {
    if (state.partisanFound) break;
    if (state.actionPointsLeft < 20) {
      logger.warn("EXECUTOR", "AP critically low — stopping deployment.");
      break;
    }

    const mission = plan.missions[mIdx];
    logger.separator(`Mission ${mIdx + 1}/${plan.missions.length} → ${mission.destination}`);

    // executeMission zwraca ID zwiadowców wysadzonych w tej misji
    const scoutsFromMission = await executeMission(mission, mIdx, state, gameApiKey, openRouterApiKey);
    deployedScoutIds.push(...scoutsFromMission);
  }

  // ── Faza 3: Sweep — przeszukanie pozostałych pól ─────────────────────────
  //
  // Po wdrożeniu wszystkich misji zwiadowcy są nadal na planszy.
  // Reużywamy ich do sprawdzenia pozostałych, jeszcze nie odwiedzonych celów.
  //
  // Koszt: ~8–22 AP na dodatkową inspekcję (1 krok = 7 AP ruch + 1 AP inspekcja).
  // Przy ~100–150 AP pozostałych możemy sprawdzić ~8–15 dodatkowych pól.
  //
  // To kluczowy mechanizm — Strateg może zaplanować 8 inspekcji (limit zwiadowców),
  // ale sweep pozwala pokryć wszystkie ~30 celów B3 na mapie.

  if (!state.partisanFound && deployedScoutIds.length > 0) {
    // Filtrujemy tylko te pola, które jeszcze nie zostały sprawdzone
    const remainingTargets = plan.inspectionOrder.filter(c => !state.inspectedCells.has(c));

    if (remainingTargets.length > 0) {
      logger.separator("Phase 3: Sweep — remaining targets");
      logger.info("EXECUTOR", `Sweeping ${remainingTargets.length} remaining cells with ${deployedScoutIds.length} scouts`, {
        apRemaining: state.actionPointsLeft,
        targets: remainingTargets,
      });

      await sweepRemainingCells(
        remainingTargets,
        deployedScoutIds,
        state,
        gameApiKey,
        openRouterApiKey
      );
    }
  }

  // ── Podsumowanie ──────────────────────────────────────────────────────────

  if (state.partisanFound) {
    logger.success("EXECUTOR", `Operation successful! Partisan at: ${state.partisanLocation}`);
    if (state.flag) logger.success("EXECUTOR", `FLAG: ${state.flag}`);
  } else {
    logger.warn("EXECUTOR", "All cells searched — partisan not found in this session.", {
      inspectedCount: state.inspectedCells.size,
      apRemaining:    state.actionPointsLeft,
    });
  }

  logger.separator("EXECUTOR — Done");
  return state.flag;
}

// ── Realizacja pojedynczej misji ──────────────────────────────────────────────

/**
 * Realizuje jedną misję transportera z planu Stratega:
 *   1. Stwórz transporter z N zwiadowcami na pokładzie (1 slot startowy)
 *   2. Przejedź do pola docelowego (gra auto-oblicza trasę drogową)
 *   3. Wysadź zwiadowców (gratis)
 *   4. Ustal pozycje zwiadowców (z odpowiedzi dismount lub przez getObjects)
 *   5. Przesuń każdego zwiadowcę do przypisanego pola inspekcji
 *   6. Wykonaj inspekcję → pobierz log → LLM interpretuje wynik
 *   7. Jeśli partyzant znaleziony: wezwij helikopter
 *
 * Zwraca listę ID zwiadowców wdrożonych w tej misji (do fazy sweep).
 * Zwraca [] jeśli misja nie powiodła się krytycznie.
 */
async function executeMission(
  mission: TransporterMission,
  mIdx: number,
  state: ExecutorState,
  gameApiKey: string,
  openRouterApiKey: string
): Promise<string[]> {

  // ── Krok 1: Stwórz transporter ze zwiadowcami ─────────────────────────────
  logger.info("EXECUTOR", `Creating transporter (${mission.passengers} scouts)...`);
  let createResp: ApiResponse;
  try {
    createResp = await createTransporter(gameApiKey, mission.passengers);
  } catch (err) {
    logger.warn("EXECUTOR", `Failed to create transporter for mission ${mIdx + 1}`, { err: String(err) });
    return [];
  }

  // Wyciągamy ID transportera, pozycję startową i listę ID zwiadowców na pokładzie
  const transporterId = extractId(createResp);
  const spawnPos      = extractPos(createResp);
  const crewIds       = extractCrewIds(createResp);
  updateAP(state, createResp); // synchronizujemy licznik AP z odpowiedzią API

  // Rejestrujemy transporter i jego załogę w stanie agenta
  state.units.set(transporterId, {
    id: transporterId, type: "transporter", position: spawnPos, scoutCrewIds: crewIds,
  });

  logger.info("EXECUTOR", `Transporter ${transporterId.slice(0,8)}... spawned at ${spawnPos}`, {
    passengers: mission.passengers, crewIds: crewIds.map(id => id.slice(0,8) + "..."),
    apLeft: state.actionPointsLeft,
  });

  // Rejestrujemy zwiadowców jako jednostki — na razie są na pokładzie transportera
  for (const scoutId of crewIds) {
    state.units.set(scoutId, {
      id: scoutId, type: "scout", position: spawnPos, scoutCrewIds: [],
    });
  }

  // ── Krok 2: Przejedź transporterem do strefy docelowej ───────────────────
  //
  // Podajemy tylko cel — gra sama oblicza trasę ograniczoną do dróg.
  // Koszt: 1 AP za każde pole trasy.

  logger.info("EXECUTOR", `Moving transporter to ${mission.destination}...`);
  let moveResp: ApiResponse;
  try {
    moveResp = await moveUnit(gameApiKey, transporterId, mission.destination);
  } catch (err) {
    logger.warn("EXECUTOR", `Failed to move transporter to ${mission.destination}`, { err: String(err) });
    return [];
  }

  const newPos = extractPos(moveResp) || mission.destination;
  const tUnit  = state.units.get(transporterId);
  if (tUnit) tUnit.position = newPos;
  updateAP(state, moveResp);

  logger.info("EXECUTOR", `Transporter arrived at ${newPos}`, { apLeft: state.actionPointsLeft });

  // ── Krok 3: Wysadź zwiadowców (bezpłatne) ────────────────────────────────
  //
  // Zwiadowcy pojawiają się na wolnych polach wokół transportera.
  // Gra automatycznie wybiera miejsca — nie mamy na to wpływu.

  logger.info("EXECUTOR", `Dismounting ${mission.passengers} scouts...`);
  let dismountResp: ApiResponse | null = null;
  try {
    dismountResp = await dismountScouts(gameApiKey, transporterId, mission.passengers);
    logger.info("EXECUTOR", "Dismount complete.", dismountResp);
  } catch (err) {
    logger.warn("EXECUTOR", "Dismount failed — scouts may still be aboard.", { err: String(err) });
  }

  // ── Krok 4: Ustal pozycje zwiadowców po wysadzeniu ───────────────────────
  //
  // Pierwsze źródło: tablica "spawned" w odpowiedzi dismount (szybsze, nie wymaga extra API call).
  // Awaryjne źródło: getObjects() — zapytanie o wszystkie aktywne jednostki na planszy.

  let scoutMap: Map<string, string>; // scoutId → aktualna pozycja

  const spawnedFromDismount = parseSpawnedFromDismount(dismountResp ?? {}, crewIds);
  if (spawnedFromDismount.size > 0) {
    scoutMap = spawnedFromDismount;
    logger.info("EXECUTOR", `Scout positions from dismount response:`, {
      scouts: Object.fromEntries(
        Array.from(scoutMap.entries()).map(([id, pos]) => [id.slice(0, 8) + "...", pos])
      ),
    });
  } else {
    // Fallback: pytamy API o wszystkie obiekty i filtrujemy nasze ID zwiadowców
    logger.info("EXECUTOR", "Fetching scout positions via getObjects...");
    try {
      const objResp = await getObjects(gameApiKey);
      scoutMap = parseScoutPositions(objResp, crewIds);
    } catch (err) {
      logger.warn("EXECUTOR", "getObjects failed — placing scouts at transporter position.", { err: String(err) });
      scoutMap = new Map(crewIds.map(id => [id, newPos]));
    }
  }

  // ── Kroki 5–7: Ruch zwiadowców + inspekcja + interpretacja LLM ──────────
  //
  // Każdy zwiadowca dostaje jedno pole do sprawdzenia (z mission.inspectCells).
  // Kolejność: przesuń zwiadowcę → wykonaj inspekcję → pobierz log → zapytaj LLM.

  const inspectCells = mission.inspectCells.slice(0, crewIds.length);
  for (let i = 0; i < crewIds.length; i++) {
    if (state.partisanFound) break; // wczesne wyjście — misja wykonana
    if (state.actionPointsLeft < 10) {
      logger.warn("EXECUTOR", "AP critically low — stopping inspections.");
      break;
    }

    const scoutId     = crewIds[i];
    const targetCell  = inspectCells[i];
    if (!targetCell) continue;

    const scoutPos = scoutMap.get(scoutId) ?? newPos;

    // Przesuń zwiadowcę do celu (tylko jeśli nie jest już na miejscu)
    if (scoutPos !== targetCell) {
      logger.info("EXECUTOR", `Scout ${scoutId.slice(0,8)}... moving ${scoutPos} → ${targetCell}`);
      try {
        const scoutMoveResp = await moveUnit(gameApiKey, scoutId, targetCell);
        updateAP(state, scoutMoveResp);
        scoutMap.set(scoutId, targetCell); // aktualizujemy lokalną mapę pozycji
        logger.info("EXECUTOR", `Scout arrived at ${targetCell}`, { apLeft: state.actionPointsLeft });
      } catch (err) {
        logger.warn("EXECUTOR", `Scout move failed — inspecting from ${scoutPos}`, { err: String(err) });
      }
    }

    // Wykonaj inspekcję bieżącego pola
    // Uwaga: API zwraca tylko potwierdzenie akcji ("Searching... check logs for details.")
    // Właściwy wynik rekonesansu jest w getLogs — pobieramy go zaraz poniżej.
    logger.info("EXECUTOR", `Inspecting ${targetCell} via scout ${scoutId.slice(0,8)}...`);
    let inspResult: ApiResponse;
    try {
      inspResult = await inspectCell(gameApiKey, scoutId);
      updateAP(state, inspResult);
    } catch (err) {
      logger.warn("EXECUTOR", `Inspect failed for ${targetCell}`, { err: String(err) });
      continue;
    }

    state.inspectedCells.set(targetCell, inspResult);
    logger.info("EXECUTOR", `Inspect result for ${targetCell}:`, inspResult);

    // Pobierz log — rzeczywisty wynik inspekcji jest tutaj
    const logEntryCount = typeof inspResult["entries"] === "number" ? inspResult["entries"] : -1;
    logger.info("EXECUTOR", `Inspect logged (total entries: ${logEntryCount}). Reading getLogs...`);

    let latestLogEntry: unknown = null;
    try {
      const logsResp = await getLogs(gameApiKey);
      updateAP(state, logsResp); // API może aktualizować AP nawet przy odczycie logów
      const logs = Array.isArray(logsResp["logs"]) ? logsResp["logs"] : [];
      // Ostatni wpis w logu to właśnie ta inspekcja, którą właśnie wykonaliśmy
      latestLogEntry = logs[logs.length - 1];
      logger.info("EXECUTOR", `Latest log entry for ${targetCell}:`, latestLogEntry);
    } catch (err) {
      logger.warn("EXECUTOR", "getLogs failed after inspect.", { err: String(err) });
    }

    // Zapytaj LLM czy w logu jest potwierdzenie obecności człowieka
    const found = await detectPartisanFromLog(latestLogEntry, targetCell, openRouterApiKey);
    if (found) {
      state.partisanFound    = true;
      state.partisanLocation = targetCell;
      logger.success("EXECUTOR", `PARTISAN CONFIRMED at ${targetCell}!`);

      // Natychmiast wzywamy helikopter — nie czekamy na koniec pętli
      try {
        const heliResp = await callHelicopter(gameApiKey, targetCell);
        logger.success("EXECUTOR", "Helicopter called!", heliResp);
        state.flag = extractFlag(heliResp);
      } catch (err) {
        logger.error("EXECUTOR", "callHelicopter failed!", { err: String(err) });
      }
      break;
    }

    logger.info("EXECUTOR", `Cell ${targetCell}: clear. AP remaining: ${state.actionPointsLeft}`);
  }

  // Synchronizujemy pozycje zwiadowców w globalnym stanie
  // (do tej pory śledziliśmy je w lokalnej zmiennej scoutMap)
  for (const [scoutId, pos] of scoutMap.entries()) {
    const unit = state.units.get(scoutId);
    if (unit) unit.position = pos;
  }

  return crewIds; // zwracamy ID wdrożonych zwiadowców do użycia w fazie sweep
}

// ── Faza Sweep ────────────────────────────────────────────────────────────────

/**
 * Reużywa już wdrożonych zwiadowców do sprawdzenia pozostałych celów.
 *
 * Przydzielanie zwiadowców: round-robin (po kolei, cyklicznie).
 * Gra obsługuje trasowanie — podajemy tylko cel, reszta jest automatyczna.
 *
 * Sweep jest kluczowy do pełnego pokrycia ~30 budynków B3 na mapie,
 * gdy bezpośrednie misje pokrywają tylko 8 (limit zwiadowców).
 */
async function sweepRemainingCells(
  remainingTargets: string[],
  scoutIds: string[],
  state: ExecutorState,
  gameApiKey: string,
  openRouterApiKey: string
): Promise<void> {
  if (scoutIds.length === 0) return;

  let targetQueue = [...remainingTargets]; // kopia — nie mutujemy oryginału
  let scoutIdx = 0; // indeks do round-robin

  while (targetQueue.length > 0 && !state.partisanFound) {
    // Minimalny próg AP: ruch (7) + inspekcja (1) + getLogs (0) = ~8, bierzemy zapas
    if (state.actionPointsLeft < 15) {
      logger.warn("EXECUTOR", `AP too low (${state.actionPointsLeft}) — stopping sweep.`);
      break;
    }

    const cell    = targetQueue.shift()!; // pobierz następny cel z kolejki
    const scoutId = scoutIds[scoutIdx % scoutIds.length]; // round-robin
    scoutIdx++;

    // Odczytujemy bieżącą pozycję zwiadowcy z globalnego stanu
    const scoutUnit  = state.units.get(scoutId);
    const currentPos = scoutUnit?.position ?? "unknown";

    logger.info("EXECUTOR", `[Sweep] Scout ${scoutId.slice(0,8)}... ${currentPos} → ${cell}`);

    // ── Ruch zwiadowcy do następnego celu ────────────────────────────────────
    if (currentPos !== cell) {
      try {
        const moveResp = await moveUnit(gameApiKey, scoutId, cell);
        const newPos   = extractPos(moveResp) || cell;
        if (scoutUnit) scoutUnit.position = newPos; // aktualizujemy stan w mapie (referencja)
        updateAP(state, moveResp);
        logger.info("EXECUTOR", `[Sweep] Scout at ${newPos}, AP: ${state.actionPointsLeft}`);
      } catch (err) {
        logger.warn("EXECUTOR", `[Sweep] Move to ${cell} failed — skipping.`, { err: String(err) });
        continue;
      }
    }

    // ── Inspekcja + odczyt logu + interpretacja LLM ───────────────────────
    try {
      const inspResp = await inspectCell(gameApiKey, scoutId);
      updateAP(state, inspResp);

      const logsResp = await getLogs(gameApiKey);
      updateAP(state, logsResp); // POPRAWKA: aktualizuj AP po getLogs (było pominięte)
      const logs = Array.isArray(logsResp["logs"]) ? logsResp["logs"] : [];
      const latestEntry = logs[logs.length - 1];

      state.inspectedCells.set(cell, inspResp);
      logger.info("EXECUTOR", `[Sweep] Log for ${cell}:`, latestEntry);

      const found = await detectPartisanFromLog(latestEntry, cell, openRouterApiKey);
      if (found) {
        state.partisanFound    = true;
        state.partisanLocation = cell;
        logger.success("EXECUTOR", `PARTISAN CONFIRMED at ${cell}!`);

        // POPRAWKA: owij callHelicopter w try-catch — błąd API nie może crashować agenta
        try {
          const heliResp = await callHelicopter(gameApiKey, cell);
          logger.success("EXECUTOR", "Helicopter called!", heliResp);
          state.flag = extractFlag(heliResp);
        } catch (err) {
          logger.error("EXECUTOR", "callHelicopter failed!", { err: String(err) });
        }
        return;
      }

      logger.info("EXECUTOR", `[Sweep] ${cell}: clear. Remaining: ${targetQueue.length} cells, AP: ${state.actionPointsLeft}`);
    } catch (err) {
      logger.warn("EXECUTOR", `[Sweep] Inspect failed at ${cell}`, { err: String(err) });
    }
  }

  logger.info("EXECUTOR", `Sweep complete. Inspected ${state.inspectedCells.size} total cells.`);
}

// ── Detekcja partyzanta przez LLM ─────────────────────────────────────────────

/**
 * Analizuje wpis z logu rekonesansu i stwierdza, czy partyzant jest obecny.
 *
 * Dlaczego LLM zamiast prostego sprawdzenia słów kluczowych?
 *   - Logi są po polsku (np. "Brak obecności ludzkiej." = brak człowieka)
 *   - Proste dopasowanie "człowiek" złapałoby "Brak obecności LUDZKIEJ" jako false positive
 *   - LLM poprawnie obsługuje negacje, synonimy i kontekst językowy
 *
 * API inspect samo w sobie zwraca tylko "Searching... check logs for details."
 * Właściwy wynik jest w najnowszym wpisie getLogs — przekazujemy go tutaj.
 */
async function detectPartisanFromLog(
  logEntry: unknown,
  cell: string,
  openRouterApiKey: string
): Promise<boolean> {
  if (!logEntry) return false;

  logger.info("EXECUTOR", `Asking LLM to interpret log entry for ${cell}...`);
  try {
    const raw = await callLLM(
      "EXECUTOR",
      openRouterApiKey,
      [
        {
          role: "system",
          content: [
            "You are a military analyst reading a Polish-language scout reconnaissance log.",
            "Determine whether the log entry CONFIRMS the physical presence of a living human being (partisan / survivor) at this location.",
            "IMPORTANT: Phrases like 'Brak obecności ludzkiej' mean NO human present.",
            "Only return true if the entry explicitly states a person WAS found.",
            'Return ONLY valid JSON (no prose): {"partisanPresent": true|false, "reasoning": "one sentence"}',
          ].join(" "),
        },
        {
          role: "user",
          content: `Cell ${cell} scout log entry:\n${JSON.stringify(logEntry, null, 2)}\n\nIs a living human confirmed present?`,
        },
      ],
      `Interpret log entry for ${cell}`
    );
    // Parsujemy JSON zwrócony przez LLM do typowanego obiektu
    const interp = extractJSON<InspectInterpretation>(raw);
    logger.info("EXECUTOR", `LLM interpretation for ${cell}:`, interp);
    if (interp.partisanPresent) {
      logger.success("EXECUTOR", `Partisan CONFIRMED at ${cell} by LLM!`, interp);
    }
    return interp.partisanPresent;
  } catch (err) {
    // Jeśli LLM zawiedzie, zakładamy "brak" — bezpieczniejsze niż false positive
    logger.warn("EXECUTOR", `LLM interpretation failed for ${cell} — assuming clear.`, { err: String(err) });
    return false;
  }
}

// ── Pomocniki do parsowania odpowiedzi API ────────────────────────────────────

/**
 * Wyciąga ID jednostki z odpowiedzi API.
 * API może zwracać ID w polu "object" lub "id" — obsługujemy oba warianty.
 */
function extractId(response: ApiResponse): string {
  const id = response["object"] ?? response["id"];
  if (typeof id !== "string" || !id) {
    throw new Error(`Cannot extract unit ID from: ${JSON.stringify(response)}`);
  }
  return id;
}

/**
 * Wyciąga pozycję jednostki z odpowiedzi API.
 * API używa różnych nazw pola w zależności od kontekstu — sprawdzamy wszystkie warianty.
 */
function extractPos(response: ApiResponse): string {
  const pos = response["spawn"] ?? response["position"] ?? response["where"] ?? response["pos"];
  return typeof pos === "string" ? pos : "";
}

/**
 * Wyciąga listę ID zwiadowców z odpowiedzi create transportera.
 * Pole "crew" zawiera tablicę obiektów {id: string}.
 */
function extractCrewIds(response: ApiResponse): string[] {
  const crew = response["crew"];
  if (!Array.isArray(crew)) return [];
  return crew
    .filter((m): m is { id: string } => m && typeof m.id === "string")
    .map(m => m.id);
}

/**
 * Aktualizuje licznik AP w stanie agenta na podstawie odpowiedzi API.
 * Każda odpowiedź zawiera "action_points_left" — synchronizujemy po każdej akcji.
 */
function updateAP(state: ExecutorState, response: ApiResponse): void {
  const apLeft = response["action_points_left"];
  if (typeof apLeft === "number") {
    state.actionPointsLeft = apLeft;
  }
}

/**
 * Parsuje pozycje zwiadowców z odpowiedzi na akcję dismount.
 * Format: {"spawned": [{"scout": "abc...", "where": "E1"}, ...]}
 *
 * Filtrujemy tylko zwiadowców należących do tej misji (crewIds),
 * bo "spawned" może zawierać inne jednostki.
 */
function parseSpawnedFromDismount(response: ApiResponse, crewIds: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const crewSet = new Set(crewIds); // Set dla O(1) lookup
  const spawned = response["spawned"];
  if (!Array.isArray(spawned)) return result;
  for (const entry of spawned) {
    if (!entry || typeof entry !== "object") continue;
    const id  = entry["scout"];
    const pos = entry["where"];
    if (typeof id === "string" && typeof pos === "string" && crewSet.has(id)) {
      result.set(id, pos);
    }
  }
  return result;
}

/**
 * Parsuje odpowiedź getObjects, żeby znaleźć pozycje konkretnych zwiadowców.
 * API może zwracać tablicę obiektów w różnych polach — sprawdzamy kilka wariantów.
 */
function parseScoutPositions(response: ApiResponse, crewIds: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const crewSet = new Set(crewIds);

  // API może umieścić jednostki w różnych polach odpowiedzi
  const candidates = [response["objects"], response["units"], response["data"]];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (!item || typeof item !== "object") continue;
      const id  = item["id"] ?? item["object"];
      const pos = item["position"] ?? item["spawn"] ?? item["where"];
      if (typeof id === "string" && typeof pos === "string" && crewSet.has(id)) {
        result.set(id, pos);
      }
    }
    if (result.size > 0) break; // znaleźliśmy dane — nie szukamy dalej
  }
  return result;
}

/**
 * Wyciąga flagę z odpowiedzi callHelicopter.
 * Flaga może pojawić się wbudowana w JSON jako {{FLG:...}} lub w polu "message".
 */
function extractFlag(response: ApiResponse): string | null {
  const text = JSON.stringify(response);
  const match = text.match(/\{\{FLG:[^}]+\}\}|FLG\{[^}]+\}/);
  if (match) return match[0];
  if (typeof response["message"] === "string") return response["message"];
  return null;
}
