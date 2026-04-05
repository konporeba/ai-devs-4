/**
 * NARZĘDZIE: apiClient — klient HTTP do API gry Domatowo
 *
 * Całość komunikacji z grą przechodzi przez jeden endpoint:
 *   POST https://hub.ag3nts.org/verify
 *
 * Każde żądanie ma identyczną strukturę:
 *   { apikey, task: "domatowo", answer: { action: "...", ...parametry } }
 *
 * Ten plik opakowuje surowe wywołania fetch w czytelne, typowane funkcje.
 * Dzięki temu agenty (mapAnalyst, executor) nie muszą znać szczegółów HTTP —
 * po prostu wywołują np. moveUnit(apiKey, id, "E4").
 *
 * Wzorzec projektowy: Facade (fasada) — upraszczamy złożony interfejs HTTP
 * do zestawu prostych, nazwanych funkcji.
 */

import { logger } from "../utils/logger";

// ── Stałe ──────────────────────────────────────────────────────────────────────

const BASE_URL = "https://hub.ag3nts.org/verify";
const TASK     = "domatowo";

// ── Typy odpowiedzi ────────────────────────────────────────────────────────────

/**
 * Bazowy typ odpowiedzi API.
 * Używamy index signature [key: string]: unknown, bo różne akcje zwracają
 * różne pola — nie możemy z góry wiedzieć, co API odeśle.
 * Agenty sami wyciągają potrzebne pola przez type guards (np. typeof x === "string").
 */
export interface ApiResponse {
  code?: number;
  message?: string;
  [key: string]: unknown;
}

// ── Centralna funkcja wysyłania żądań ──────────────────────────────────────────

/**
 * Wysyła jedną akcję do API gry Domatowo.
 * Wszystkie funkcje w tym pliku korzystają z tej jednej centralnej funkcji.
 *
 * Jeśli serwer zwróci status HTTP inny niż 2xx, rzucamy błąd z treścią odpowiedzi.
 * Dzięki temu agenty mogą łapać błędy przez try-catch bez parsowania HTTP samodzielnie.
 */
export async function sendAction(
  apiKey: string,
  answer: Record<string, unknown>
): Promise<ApiResponse> {
  const payload = { apikey: apiKey, task: TASK, answer };

  logger.apiCall("EXECUTOR", `→ ${BASE_URL}`, { answer });

  const response = await fetch(BASE_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error("EXECUTOR", `HTTP ${response.status}`, { text });
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as ApiResponse;
  logger.apiCall("EXECUTOR", `← Response`, data);
  return data;
}

// ── Typowane pomocniki dla konkretnych akcji ───────────────────────────────────

/** Pobiera dokumentację API (lista dostępnych akcji, koszty, format). */
export async function getHelp(apiKey: string): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "help" });
}

/** Pobiera pełną mapę terenu 11×11 z symbolami. */
export async function getMap(apiKey: string): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "getMap" });
}

/**
 * Tworzy transporter z N zwiadowcami na pokładzie.
 * Koszt: 5 AP (baza) + 5 AP × liczba_pasażerów.
 *
 * Kluczowa zaleta: cała załoga zajmuje JEDEN slot startowy.
 * To pozwala stworzyć 4 zwiadowców za cenę jednego slotu zamiast czterech.
 */
export async function createTransporter(
  apiKey: string,
  passengers: number
): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "create", type: "transporter", passengers });
}

/**
 * Przesuwa jednostkę do wskazanego pola.
 * Gra automatycznie oblicza trasę:
 *   - Transportery: trasa ograniczona do dróg
 *   - Zwiadowcy: najkrótsza trasa ortogonalna przez dowolny teren
 *
 * Pole parametru to "where" (nie "destination") — uwaga przy debugowaniu.
 */
export async function moveUnit(
  apiKey: string,
  unitId: string,
  where: string
): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "move", object: unitId, where });
}

/**
 * Wysadza N zwiadowców z transportera.
 * Zwiadowcy pojawiają się na wolnych polach wokół pojazdu. Koszt: 0 AP.
 *
 * Odpowiedź zawiera tablicę "spawned" z pozycjami każdego zwiadowcy —
 * parsujemy ją w parseSpawnedFromDismount() zamiast wywoływać getObjects().
 */
export async function dismountScouts(
  apiKey: string,
  transporterId: string,
  passengers: number
): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "dismount", object: transporterId, passengers });
}

/**
 * Wykonuje inspekcję pola, na którym stoi zwiadowca.
 * Koszt: 1 AP. Działa tylko z ID zwiadowcy (nie transportera).
 *
 * WAŻNE: Odpowiedź tej akcji to tylko potwierdzenie ("Searching...").
 * Właściwy wynik rekonesansu jest w getLogs() — jako najnowszy wpis.
 */
export async function inspectCell(
  apiKey: string,
  scoutId: string
): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "inspect", object: scoutId });
}

/**
 * Pobiera listę wszystkich aktywnych jednostek z ich typem, pozycją i ID.
 * Używane jako fallback gdy odpowiedź dismount nie zawiera pozycji zwiadowców.
 */
export async function getObjects(apiKey: string): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "getObjects" });
}

/**
 * Pobiera wpisy z dziennika akcji.
 * Każda inspekcja dodaje nowy wpis — najnowszy wpis (ostatni element tablicy)
 * to wynik właśnie wykonanej inspekcji.
 */
export async function getLogs(apiKey: string): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "getLogs" });
}

/**
 * Resetuje planszę — usuwa wszystkie jednostki, przywraca 300 AP
 * i losuje nową pozycję partyzanta.
 *
 * Wywoływany na początku każdego uruchomienia, żeby wyczyścić
 * ewentualne resztki po przerwanej poprzedniej sesji.
 */
export async function resetGame(apiKey: string): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "reset" });
}

/**
 * Wzywa helikopter ratunkowy do potwierdzonej lokalizacji partyzanta.
 * Działa tylko po tym, jak zwiadowca potwierdził obecność człowieka przez inspect.
 * Poprawna odpowiedź zawiera flagę (token ukończenia zadania).
 */
export async function callHelicopter(
  apiKey: string,
  destination: string
): Promise<ApiResponse> {
  return sendAction(apiKey, { action: "callHelicopter", destination });
}
