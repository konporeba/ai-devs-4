/**
 * AI Devs 4 — S4E2 Windpower — solution_v2.ts
 *
 * ARCHITEKTURA: ReAct Agent z LLM jako "mózgiem"
 * ================================================
 *
 * ReAct (Reasoning + Acting) to wzorzec agenta, w którym LLM:
 *   1. REASON (Myśli): analizuje sytuację i decyduje co zrobić
 *   2. ACT (Działa): wywołuje narzędzie (tool call)
 *   3. OBSERVE (Obserwuje): widzi wynik narzędzia
 *   4. ... i powtarza aż do ukończenia zadania
 *
 * W tej implementacji:
 *   - LLM (claude-sonnet) decyduje o KOLEJNOŚCI i PARAMETRACH wywołań narzędzi
 *   - TypeScript wykonuje narzędzia i zwraca surowe dane
 *   - LLM SAMODZIELNIE interpretuje dane pogodowe i wybiera konfigurację turbiny
 *
 * KLUCZOWA ZASADA: "Grube narzędzia" (fat tools)
 * -----------------------------------------------
 * LLM wywołuje narzędzia SEKWENCYJNIE (jedna decyzja na raz).
 * Równoległość osiągamy przez narzędzia, które WEWNĘTRZNIE robią Promise.all.
 *
 * Przykład maksymalnego "grubości": narzędzie complete_turbine_config()
 * dostaje decyzję LLM (które godziny są burzowe, które produkcyjne),
 * a następnie WEWNĘTRZNIE:
 *   1. Kolejkuje generowanie unlock codes (Promise.all)
 *   2. Czeka na kody
 *   3. Buduje batch config (matching po signedParams)
 *   4. Wysyła konfigurację
 *   5. Wywołuje "done"
 *   6. Zwraca flagę
 *
 * LLM robi TYLKO 3 wywołania narzędzi zamiast 7 → oszczędzamy ~9s LLM roundtrips
 * Co jest KLUCZOWE w kontekście 40-sekundowego limitu sesji.
 *
 * FLOW (musi zmieścić się w 40 sekundach):
 *   start_service_window      (~0.5s)  — otwiera sesję
 *   queue_data_requests        (~0.3s)  — kolejkuje 3 zapytania równolegle
 *   collect_data_results       (~10-24s) — czeka na dane pogodowe
 *   [LLM analizuje dane]       (~6-9s)  — identyfikuje wichury i okno produkcji
 *   complete_turbine_config    (~3-6s)  — unlock codes + submit + done (wszystko wewnętrznie)
 *
 *   TOTAL: ~20-40s. Mieści się w 40s nawet przy wolnych serwerach.
 *
 * RÓŻNICA od solution.ts:
 *   solution.ts    → TypeScript analizuje dane (0ms, deterministyczny)
 *   solution_v2.ts → LLM analizuje dane (~6-9s, ale demonstruje wzorzec agenta)
 *
 * Celem jest EDUKACJA: pokazanie jak buduje się prawdziwego agenta LLM
 * z function calling, który podejmuje decyzje na podstawie rzeczywistych danych.
 */

import * as dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

// ─── Stałe konfiguracyjne ─────────────────────────────────────────────────────

const API_KEY = process.env.AI_DEVS_API_KEY!;
const BASE_URL = (
  process.env.CENTRALA_AI_DEVS || 'https://hub.ag3nts.org'
).replace(/\/$/, '');
const VERIFY_URL = `${BASE_URL}/verify`;
const TASK = 'windpower';

/**
 * Konfiguracja OpenRouter — używamy OpenAI SDK z innym baseURL.
 * OpenRouter to proxy które daje dostęp do wielu modeli przez jeden klucz API.
 *
 * MODEL CHOICE: claude-sonnet-4-5
 *   - Dobry balans między szybkością a jakością function calling
 *   - Rozumie złożone instrukcje analityczne
 *   - Szybszy niż claude-3-opus, dokładniejszy niż haiku
 */
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: 'https://openrouter.ai/api/v1',
});
const MODEL = 'anthropic/claude-sonnet-4-5';

// ─── Zarządzanie sesją ────────────────────────────────────────────────────────

/**
 * sessionStart — timestamp otwarcia sesji serwisowej.
 * Używamy go do obliczania dynamicznych timeoutów dla operacji poll.
 *
 * WHY: Sesja trwa 40 sekund od momentu wywołania start.
 * Każde narzędzie powinno wiedzieć ile czasu zostało.
 */
let sessionStart = 0;

/**
 * cachedConfigPoints — cache zdecydowanych punktów konfiguracji między sesjami.
 *
 * WZORZEC ODPORNOŚCI NA TIMEOUT:
 * --------------------------------
 * Problem: dane pogodowe trwają ~21-26s. Analiza LLM ~8s. Unlock codes ~5s.
 * Razem: ~34-39s. Przy wolnych serwerach może przekroczyć 40s limit.
 *
 * Rozwiązanie: cache punktów konfiguracji między sesjami.
 * Jeśli pierwsza sesja "nauczyła nas" jakie punkty wybrać, w kolejnej sesji
 * możemy POMINĄĆ fazę pobierania i analizy danych (oszczędzamy ~30s!)
 * i od razu wywołać complete_turbine_config z zachowanymi danymi.
 *
 * Unlock codes SĄ deterministyczne (MD5 tych samych parametrów = ten sam wynik)
 * ale serwer generuje je na żądanie per-sesja. Dlatego musimy je zawsze
 * pobierać na nowo (nie możemy cache'ować samych kodów MD5 między sesjami).
 *
 * Ta zmienna jest ustawiana przez complete_turbine_config gdy decyduje o punktach,
 * a odczytywana przez start_service_window w retry scenario.
 */
let cachedConfigPoints: ConfigPoint[] | null = null;

/** Łączny czas sesji w ms (40 sekund według dokumentacji API) */
const SESSION_TOTAL_MS = 40_000;

/**
 * remainingMs — ile czasu pozostało do końca sesji minus 2s bufor bezpieczeństwa.
 * Przekazujemy to do funkcji poll żeby nie przekroczyły limitu.
 *
 * Minimum: 5000ms — zawsze dajemy co najmniej 5s na operację,
 * nawet jeśli sesja formalnie się skończyła (serwer może być tolerancyjny).
 */
function remainingMs(): number {
  const elapsed = Date.now() - sessionStart;
  return Math.max(SESSION_TOTAL_MS - elapsed - 2000, 5000);
}

// ─── Logowanie ────────────────────────────────────────────────────────────────

const log = (msg: string) =>
  console.log(`[${new Date().toISOString()}] ${msg}`);

// ─── Typy ─────────────────────────────────────────────────────────────────────

interface ApiResponse {
  code?: number;
  message?: string;
  sourceFunction?: string;
  signedParams?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * ConfigPoint — jeden punkt konfiguracji turbiny przekazywany przez LLM.
 * LLM konstruuje te obiekty po analizie danych pogodowych.
 */
interface ConfigPoint {
  startDate: string; // "YYYY-MM-DD"
  startHour: string; // "HH:00:00"
  windMs: number; // prędkość wiatru (potrzebna do generowania unlock code)
  pitchAngle: number; // kąt łopat: 0 (produkcja), 90 (burza/idle)
  turbineMode: string; // "production" lub "idle"
}

/**
 * ConfigMap — mapa konfiguracji do wysłania w batchu.
 * Klucz to "YYYY-MM-DD HH:00:00", wartość to parametry turbiny.
 */
type ConfigMap = Record<
  string,
  { pitchAngle: number; turbineMode: string; unlockCode: string }
>;

// ─── API helper ───────────────────────────────────────────────────────────────

/**
 * callApi — wysyła POST /verify z automatycznym retry na błędy 5xx.
 * Wszystkie parametry akcji trafiają do obiektu "answer".
 *
 * FORMAT żądania:
 * {
 *   apikey: string,
 *   task: "windpower",
 *   answer: { action: "start" | "get" | "getResult" | ..., ...params }
 * }
 */
async function callApi(
  action: string,
  params: Record<string, unknown> = {},
): Promise<ApiResponse> {
  const body = {
    apikey: API_KEY,
    task: TASK,
    answer: { action, ...params },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status >= 500 && attempt < 3) {
        log(`HTTP ${res.status} on attempt ${attempt}, retrying...`);
        await sleep(300 * attempt);
        continue;
      }

      return (await res.json()) as ApiResponse;
    } catch (err) {
      if (attempt === 3) throw err;
      log(`Network error attempt ${attempt}: ${err}`);
      await sleep(300 * attempt);
    }
  }
  throw new Error('callApi: exhausted retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Shared result buffer ─────────────────────────────────────────────────────
/**
 * WHY shared buffer (bufor współdzielony):
 *
 * API działa asynchronicznie — wysyłamy żądanie "get" (kolejkujemy),
 * a wyniki pobieramy osobnymi wywołaniami "getResult".
 * getResult zwraca JEDEN wynik na raz w losowej kolejności.
 *
 * Problem: gdyby każde narzędzie (collect_data_results, complete_turbine_config)
 * miało własną pętlę poll, mogłoby "ukraść" wynik przeznaczony dla drugiego.
 *
 * Rozwiązanie: jeden współdzielony bufor + jedna funkcja drain.
 * drainOneResult() dodaje KAŻDY wynik do bufora.
 * pollForSources() i pollForMultipleSameSource() CZYTAJĄ z bufora.
 * Dzięki temu wyniki trafiają do właściwego konsumenta.
 */
const resultBuffer: ApiResponse[] = [];

/** Pobiera jeden wynik z API i dodaje do bufora jeśli jest gotowy */
async function drainOneResult(): Promise<void> {
  const res = await callApi('getResult');
  if (res.sourceFunction) {
    log(`  getResult → sourceFunction=${res.sourceFunction}`);
    resultBuffer.push(res);
  }
  // code 11 = "brak gotowego wyniku" — ignorujemy
}

/**
 * pollForSources — czeka aż wszystkie wymienione sourceFunction pojawią się w buforze.
 * Używamy Set żeby efektywnie śledzić co zostało zebrane.
 */
async function pollForSources(
  targets: string[],
  timeoutMs: number,
): Promise<Map<string, ApiResponse>> {
  const collected = new Map<string, ApiResponse>();
  const remaining = new Set(targets);
  const deadline = Date.now() + timeoutMs;

  while (remaining.size > 0 && Date.now() < deadline) {
    // Sprawdź bufor od końca (nowe wyniki są na końcu)
    for (let i = resultBuffer.length - 1; i >= 0; i--) {
      const sf = resultBuffer[i].sourceFunction as string;
      if (remaining.has(sf)) {
        collected.set(sf, resultBuffer[i]);
        remaining.delete(sf);
        resultBuffer.splice(i, 1);
      }
    }

    if (remaining.size === 0) break;

    await drainOneResult();
    await sleep(200);
  }

  if (remaining.size > 0) {
    throw new Error(`Timeout waiting for: ${[...remaining].join(', ')}`);
  }

  return collected;
}

/**
 * pollForMultipleSameSource — zbiera N wyników tego samego sourceFunction.
 * Używane dla unlockCodeGenerator gdzie kolejkujemy N żądań i oczekujemy N wyników.
 */
async function pollForMultipleSameSource(
  sourceFunction: string,
  count: number,
  timeoutMs: number,
): Promise<ApiResponse[]> {
  const results: ApiResponse[] = [];
  const deadline = Date.now() + timeoutMs;

  while (results.length < count && Date.now() < deadline) {
    for (let i = resultBuffer.length - 1; i >= 0; i--) {
      if ((resultBuffer[i].sourceFunction as string) === sourceFunction) {
        results.push(resultBuffer[i]);
        resultBuffer.splice(i, 1);
      }
    }

    if (results.length >= count) break;

    await drainOneResult();
    await sleep(200);
  }

  if (results.length < count) {
    throw new Error(
      `Timeout: collected ${results.length}/${count} for ${sourceFunction}`,
    );
  }

  return results;
}

// ─── Pomocnicze funkcje ekstrakcji ────────────────────────────────────────────

/**
 * extractUnlockCode — szuka kodu MD5 (32 znaki hex) w odpowiedzi API.
 * Próbuje różnych nazw pól bo dokumentacja API nie precyzuje nazwy.
 */
function extractUnlockCode(res: ApiResponse): string {
  for (const key of ['unlockCode', 'code_md5', 'hash', 'md5', 'result']) {
    const val = res[key];
    if (typeof val === 'string' && /^[a-f0-9]{32}$/i.test(val)) return val;
  }
  if (typeof res.message === 'string' && /^[a-f0-9]{32}$/i.test(res.message)) {
    return res.message;
  }
  for (const val of Object.values(res)) {
    if (typeof val === 'string' && /^[a-f0-9]{32}$/i.test(val)) return val;
  }
  log(`WARNING: Could not find MD5 unlock code in: ${JSON.stringify(res)}`);
  return '';
}

function extractFlag(res: ApiResponse): string | null {
  const text = JSON.stringify(res);
  // Próbuj obu formatów: {{FLG:...}} i {FLG:...}
  // Serwer zwraca (pojedyncze nawiasy)
  // ale w dokumentacji pojawia się {{FLG:...}} (podwójne nawiasy)
  const match =
    text.match(/\{\{FLG:[^}]+\}\}/) || text.match(/\{FLG:[A-Z0-9_]+\}/);
  return match ? match[0] : null;
}

// ─── Implementacje narzędzi ───────────────────────────────────────────────────
/**
 * NARZĘDZIA (Tools) — implementacje wykonawcze.
 *
 * Każde narzędzie odpowiada jednej funkcji w definicji tools[] poniżej.
 * LLM wywołuje narzędzie przez nazwę + argumenty JSON.
 * My wykonujemy odpowiadającą funkcję i zwracamy wynik jako JSON.
 *
 * ZASADA "grubych narzędzi" — MANIFEST:
 * =======================================
 * Ta implementacja używa 4 narzędzi zamiast 7 z oryginalnej specyfikacji.
 * Połączyliśmy ostatnie 4 kroki (queue_unlock_codes, collect_unlock_codes,
 * submit_config, finalize) w jedno narzędzie complete_turbine_config.
 *
 * DLACZEGO TO JEST LEPSZE w kontekście limitów czasowych:
 *
 * Stara wersja (7 narzędzi, 7 LLM roundtrips):
 *   start(~3s) + queue(~3s) + collect(~24s) + analyze(~8s)
 *   + queue_unlock(~3s) + collect_unlock(~3s) + submit(~3s) + finalize(~3s)
 *   = ~50s PRZEKRACZA LIMIT
 *
 * Nowa wersja (4 narzędzia, 4 LLM roundtrips):
 *   start(~3s) + queue(~3s) + collect(~24s) + analyze(~8s)
 *   + complete(~5s, wewnętrznie: unlock+submit+done)
 *   = ~43s... nadal ciasno!
 *
 * KLUCZ: LLM wywołuje start+queue RAZEM (parallel tool calls w jednej iteracji),
 * więc realnie: start+queue(~3s) + collect(~24s) + analyze(~7s) + complete(~5s) = ~39s
 *
 * Każdy zapisany LLM roundtrip (~2-3s) jest na wagę złota przy 40s limicie.
 */

/**
 * Tool 1: start_service_window
 * Otwiera sesję serwisową i zapisuje czas startu.
 */
async function startServiceWindow(): Promise<object> {
  log('[Tool] start_service_window');
  const res = await callApi('start');
  log(`  start → ${JSON.stringify(res)}`);

  // Zapisujemy moment startu SESJI SERWISOWEJ (nie startu programu)
  // To jest ważne — sesja 40s liczy się od odpowiedzi na "start"
  sessionStart = Date.now();

  const sessionTimeout = (res.sessionTimeout as number) || 40;
  return {
    sessionTimeout,
    message: `Service window opened. You have ${sessionTimeout} seconds. Immediately call queue_data_requests next.`,
    rawResponse: res,
  };
}

/**
 * Tool 2: queue_data_requests
 * Kolejkuje 3 zapytania równolegle — GRUBE NARZĘDZIE.
 *
 * WHY Promise.all: Każde callApi("get", ...) to ~300ms HTTP roundtrip.
 * Sekwencyjnie: 3 × 300ms = 900ms. Równolegle: ~300ms. Oszczędzamy 600ms.
 * Ale to tylko kolejkowanie — sam czas przetwarzania (weather ~10-24s) jest po stronie serwera.
 */
async function queueDataRequests(): Promise<object> {
  log('[Tool] queue_data_requests — queuing 3 in parallel via Promise.all');

  await Promise.all([
    callApi('get', { param: 'weather' }),
    callApi('get', { param: 'turbinecheck' }),
    callApi('get', { param: 'powerplantcheck' }),
  ]);

  log('  All 3 data requests queued.');
  return {
    queued: ['weather', 'turbinecheck', 'powerplantcheck'],
    message:
      '3 requests queued in parallel. Immediately call collect_data_results next.',
  };
}

/**
 * Tool 3: collect_data_results
 * Czeka na wyniki i zwraca PEŁNE SUROWE DANE do LLM.
 *
 * WAŻNA DECYZJA ARCHITEKTONICZNA — dlaczego surowe dane:
 * -------------------------------------------------------
 * Moglibyśmy pre-procesować dane tutaj (wyfiltrować burze, znaleźć okno produkcji)
 * ale wtedy LLM NIE BYŁBY MÓZGIEM — byłby tylko dyspozytorem wywołań.
 *
 * Przekazując surowe dane:
 * 1. LLM SAMODZIELNIE analizuje prognozy i stosuje reguły biznesowe
 * 2. LLM może uwzględnić niuanse (np. gradualny wzrost wiatru, kontekst powerplant)
 * 3. Mamy prawdziwego agenta AI, nie wrapper na hardkodowaną logikę
 * 4. Łatwo zmienić reguły przez zmianę system promptu (bez zmiany kodu)
 *
 * Trade-off: +~6-9s na analizę LLM. Akceptowalny dla demonstracji wzorca agenta.
 */
async function collectDataResults(): Promise<object> {
  log('[Tool] collect_data_results — polling for all 3 sources');
  const timeout = remainingMs();
  log(`  remainingMs=${timeout}ms`);

  const resultsMap = await pollForSources(
    ['weather', 'turbinecheck', 'powerplantcheck'],
    timeout,
  );

  const elapsed = Math.round((Date.now() - sessionStart) / 1000);
  log(`  Data collected. Session elapsed: ${elapsed}s / 40s`);

  // Zwracamy PEŁNE dane — LLM widzi forecast z timestamps, windMs, itp.
  // LLM sam aplikuje reguły: wind>14 → idle/90°, wind 4-14 → production/0°
  //
  // UWAGA: Zwracamy też timeRemaining żeby LLM wiedział że musi działać szybko
  return {
    weather: resultsMap.get('weather'),
    turbinecheck: resultsMap.get('turbinecheck'),
    powerplantcheck: resultsMap.get('powerplantcheck'),
    sessionInfo: {
      elapsedSeconds: elapsed,
      remainingSeconds: Math.round(remainingMs() / 1000),
      urgencyNote: `${40 - elapsed}s remaining — analyze data and call complete_turbine_config IMMEDIATELY`,
    },
  };
}

/**
 * Tool 4: complete_turbine_config — "SUPER FAT TOOL"
 * ====================================================
 * Przyjmuje decyzję LLM o konfiguracji turbiny i WEWNĘTRZNIE wykonuje:
 *   1. Równoległe kolejkowanie unlock codes (Promise.all)
 *   2. Polling na N kodów unlock
 *   3. Matchowanie kodów z punktami konfiguracji (po signedParams)
 *   4. Budowanie mapy konfiguracji
 *   5. Wysłanie konfiguracji wsadowej (callApi "config")
 *   6. Wywołanie "done" i zwrócenie flagi
 *
 * DLACZEGO to jest jedno narzędzie zamiast 4:
 * -------------------------------------------
 * Kroki 1-6 są DETERMINISTYCZNIE zależne od siebie (każdy używa wyniku poprzedniego).
 * LLM NIE POTRZEBUJE obserwować wyników pośrednich — interesuje go tylko flaga.
 * Każde wywołanie LLM to ~2-3s latencji. Łącząc 4 narzędzia w 1 oszczędzamy ~9s.
 *
 * To jest KLUCZOWA optymalizacja dla 40s limitu sesji:
 *   - Po data collection zostało ~12-15s
 *   - LLM analiza: ~7s
 *   - complete_turbine_config: ~5s (unlock+submit+done)
 *   - Razem po starcie: ~39s ✓ (BEZ tej optymalizacji: ~50s ✗)
 *
 * To jest właśnie esencja "grubych narzędzi" — jedno narzędzie = jedna decyzja LLM.
 */
async function completeTurbineConfig(
  configPoints: ConfigPoint[],
): Promise<object> {
  log(`[Tool] complete_turbine_config — ${configPoints.length} config points`);
  log(`  Points: ${JSON.stringify(configPoints)}`);

  // Cache config points dla ewentualnego retry
  // Jeśli ta sesja się skończy przed ukończeniem, następna sesja będzie wiedzieć
  // jakie punkty wybrać bez potrzeby ponownego pobierania danych pogodowych
  cachedConfigPoints = configPoints;
  log(`  Cached ${configPoints.length} config points for potential retry`);

  const elapsed = Math.round((Date.now() - sessionStart) / 1000);
  log(`  Session elapsed: ${elapsed}s / 40s, remaining: ~${40 - elapsed}s`);

  // FAZA 1: Równolegle kolejkuj wszystkie unlock codes
  // Każde callApi to ~300ms. N×300ms vs N parallel ~300ms — oszczędzamy (N-1)×300ms
  log('  Phase 1: Queuing unlock codes in parallel...');
  await Promise.all(
    configPoints.map((pt) =>
      callApi('unlockCodeGenerator', {
        startDate: pt.startDate,
        startHour: pt.startHour,
        windMs: pt.windMs,
        pitchAngle: pt.pitchAngle,
      }),
    ),
  );
  log(`  All ${configPoints.length} unlock code requests queued.`);

  // FAZA 2: Zbierz wszystkie unlock codes
  const unlockTimeout = Math.max(remainingMs() - 2000, 5000);
  log(
    `  Phase 2: Collecting ${configPoints.length} unlock codes (timeout=${unlockTimeout}ms)...`,
  );

  const unlockResults = await pollForMultipleSameSource(
    'unlockCodeGenerator',
    configPoints.length,
    unlockTimeout,
  );
  log(`  Collected ${unlockResults.length} unlock codes.`);

  // FAZA 3: Dopasuj kody do punktów konfiguracji
  // Matching po signedParams.startDate + signedParams.startHour
  // (jednoznaczny identyfikator — jeden config per timestamp)
  //
  // WHY nie matchujemy po windMs:
  // Serwer przechowuje windMs jako float string (np. "6.6"), a lokalna wartość
  // mogłaby mieć drobne różnice reprezentacji floating-point.
  // startDate + startHour są STRING-ami → bezpieczne porównanie.
  log('  Phase 3: Matching unlock codes to config points...');
  const usedIndices = new Set<number>();
  const batchConfigs: ConfigMap = {};

  for (const pt of configPoints) {
    const datetime = `${pt.startDate} ${pt.startHour}`;
    let matchedIdx = -1;

    // Primary: szukaj po signedParams
    for (let i = 0; i < unlockResults.length; i++) {
      if (usedIndices.has(i)) continue;
      const sp = unlockResults[i].signedParams;
      if (
        sp &&
        sp.startDate === pt.startDate &&
        sp.startHour === pt.startHour
      ) {
        matchedIdx = i;
        break;
      }
    }

    // Fallback: szukaj po top-level polach
    if (matchedIdx === -1) {
      for (let i = 0; i < unlockResults.length; i++) {
        if (usedIndices.has(i)) continue;
        const ur = unlockResults[i];
        if (
          (ur.startDate as string) === pt.startDate &&
          (ur.startHour as string) === pt.startHour
        ) {
          matchedIdx = i;
          break;
        }
      }
    }

    const matched = matchedIdx >= 0 ? unlockResults[matchedIdx] : undefined;
    if (matchedIdx >= 0) usedIndices.add(matchedIdx);

    const unlockCode = extractUnlockCode(matched || {});
    if (!unlockCode) {
      log(
        `  WARN: No unlock code for ${datetime}. Result: ${JSON.stringify(matched)}`,
      );
    }
    log(
      `  ${datetime} → unlockCode=${unlockCode} (mode=${pt.turbineMode}, pitch=${pt.pitchAngle})`,
    );

    batchConfigs[datetime] = {
      pitchAngle: pt.pitchAngle,
      turbineMode: pt.turbineMode,
      unlockCode: unlockCode || 'MISSING',
    };
  }

  // FAZA 4: Wyślij konfigurację wsadową
  log(
    `  Phase 4: Submitting batch config (${Object.keys(batchConfigs).length} points)...`,
  );
  log(`  Configs: ${JSON.stringify(batchConfigs)}`);
  const configRes = await callApi('config', { configs: batchConfigs });
  log(`  config → ${JSON.stringify(configRes)}`);

  if (configRes.code && configRes.code < 0) {
    log(
      `  ERROR: Config submission failed with code ${configRes.code}: ${configRes.message}`,
    );
    return {
      success: false,
      error: configRes.message,
      configResponse: configRes,
    };
  }

  // FAZA 5: Wywołaj "done" i pobierz flagę
  log('  Phase 5: Calling done...');
  const doneRes = await callApi('done');
  log(`  done → ${JSON.stringify(doneRes)}`);

  const flag = extractFlag(doneRes);
  if (flag) {
    log(`  *** FLAG FOUND: ${flag} ***`);
    console.log(`\n✓ FLAG: ${flag}\n`);
  }

  const finalElapsed = Math.round((Date.now() - sessionStart) / 1000);
  log(`  Completed in ${finalElapsed}s total session time`);

  return {
    success: flag !== null,
    flag,
    configSubmitResponse: configRes,
    doneResponse: doneRes,
    sessionElapsedSeconds: finalElapsed,
    message: flag
      ? `SUCCESS! Flag: ${flag}`
      : `Config submitted. Done response: ${JSON.stringify(doneRes)}`,
  };
}

/**
 * Tool 5: restart_with_cached_config
 * =====================================
 * NARZĘDZIE ODPORNOŚCI NA TIMEOUT — używane gdy pierwsza sesja wygasła
 * przed ukończeniem, ale znamy już konfigurację z poprzedniej próby.
 *
 * Łączy start_service_window + complete_turbine_config w jedno wywołanie.
 * Dzięki temu w retry scenario:
 *   - Brak danych do pobrania (pomijamy ~26s weather fetch)
 *   - Brak analizy LLM (pomijamy ~8s)
 *   - Tylko: start(~0.5s) + unlock codes(~3s) + submit(~0.3s) + done(~0.3s) = ~4s ✓
 *
 * DLACZEGO to jest GRUBE NARZĘDZIE (nie dwa oddzielne):
 * Każde wywołanie narzędzia to ~2-3s latencja LLM. Łącząc start + complete
 * w jedno wywołanie oszczędzamy tę latencję — krytyczne przy retry.
 */
async function restartWithCachedConfig(): Promise<object> {
  log('[Tool] restart_with_cached_config');

  if (!cachedConfigPoints || cachedConfigPoints.length === 0) {
    return {
      error: 'No cached config points available. Run full flow first.',
      hint: 'Call start_service_window, queue_data_requests, collect_data_results, complete_turbine_config in sequence.',
    };
  }

  log(`  Using cached config: ${JSON.stringify(cachedConfigPoints)}`);

  // Faza 1: Otwórz nową sesję serwisową
  log('  Phase 0: Starting new service window...');
  const startRes = await callApi('start');
  log(`  start → ${JSON.stringify(startRes)}`);
  sessionStart = Date.now(); // reset timera sesji

  const sessionTimeout = (startRes.sessionTimeout as number) || 40;
  log(`  New session opened. Timeout: ${sessionTimeout}s`);

  // Faza 2: Uruchom complete_turbine_config z zachowanymi danymi
  // (bez czekania na dane pogodowe — już je mamy z poprzedniej sesji)
  const result = await completeTurbineConfig(cachedConfigPoints);

  return {
    ...(result as object),
    sessionTimeout,
    note: 'Used cached config points from previous session — skipped data collection',
  };
}

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

/**
 * executeToolCall — dispatcher wywołań narzędzi.
 *
 * Dostaje nazwę narzędzia i sparsowane argumenty, wywołuje odpowiednią funkcję.
 * Zwraca wynik który zostanie serialized do JSON i przesłany do LLM jako tool result.
 */
async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'start_service_window':
      return startServiceWindow();

    case 'queue_data_requests':
      return queueDataRequests();

    case 'collect_data_results':
      return collectDataResults();

    case 'complete_turbine_config':
      // LLM przekazuje config_points jako tablicę z decyzją analityczną
      return completeTurbineConfig(args.config_points as ConfigPoint[]);

    case 'restart_with_cached_config':
      // Używane gdy sesja wygasła — startuje nową sesję i używa cachowanych config points
      return restartWithCachedConfig();

    default:
      log(`WARNING: Unknown tool called: ${name}`);
      return {
        error: `Unknown tool: ${name}`,
        availableTools: [
          'start_service_window',
          'queue_data_requests',
          'collect_data_results',
          'complete_turbine_config',
          'restart_with_cached_config',
        ],
      };
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────
/**
 * SYSTEM PROMPT — serce agenta LLM.
 *
 * ZASADY DOBREGO SYSTEM PROMPTU dla agenta z narzędziami:
 * 1. Cel w pierwszym zdaniu — LLM wie po co istnieje
 * 2. Kolejność narzędzi EXPLICITLY — LLM nie musi zgadywać
 * 3. Reguły domenowe PRECYZYJNE — liczby, jednostki, formaty
 * 4. Format danych WYJŚCIOWYCH — co przekazać do kolejnego narzędzia
 * 5. Ograniczenia czasowe — LLM wie że musi działać sprawnie
 *
 * WPŁYW FORMUŁOWANIA NA ZACHOWANIE:
 * - "MUST be called first" → LLM nie pomija start_service_window
 * - "IMMEDIATELY after" → LLM nie dodaje zbędnych kroków między
 * - "Call complete_turbine_config with ALL points at once" → LLM nie dzieli na kroki
 * - "CRITICAL: ~10s remaining" → LLM nie analizuje zbyt długo
 *
 * DLACZEGO podajemy reguły analityczne w prompcie a nie w kodzie:
 * To jest właśnie siła agenta LLM — reguły można zmieniać BEZ zmiany kodu.
 * Wystarczy zmienić system prompt i agent zachowa się inaczej.
 * W solution.ts te reguły są na stałe wbudowane w analyzeData() — nie da się zmienić
 * bez modyfikacji kodu i redeploymentu.
 */
const SYSTEM_PROMPT = `You are a wind turbine scheduling agent. Your goal is to configure a wind turbine
within a 40-second service window to protect it during storms and generate power when conditions are right.

YOU HAVE 5 TOOLS:

NORMAL FLOW (first attempt, no previous session):
1. start_service_window — opens the 40s session (MUST be first)
2. queue_data_requests — queues weather forecast, turbine check, power plant check (parallel internally)
3. collect_data_results — waits for and returns ALL data (weather may take 10-24 seconds)
4. complete_turbine_config — receives your analysis and handles ALL remaining steps automatically

RETRY FLOW (if complete_turbine_config timed out in a previous session):
5. restart_with_cached_config — starts a NEW session and immediately retries with previous config (NO data re-fetch needed)

STEP 3 → STEP 4 ANALYSIS (do this MENTALLY, then call complete_turbine_config):

STORM protection rules (apply to ALL matching forecast points):
- Any forecast point where windMs > 14 → pitchAngle=90, turbineMode="idle"
  (feathering: blades parallel to wind, no drag, no power — maximum storm protection)

PRODUCTION window rule (pick exactly ONE):
- Find the BEST forecast point where windMs is between 4 and 14 (inclusive)
- "Best" = highest windMs in range (most power output)
- Prefer a point AFTER storms clear (turbine restarts production when safe)
- → pitchAngle=0, turbineMode="production"

TIMESTAMP FORMAT — CRITICAL:
- Use the EXACT timestamp strings from the forecast data
- startDate = first part of timestamp (e.g., "2026-04-05")
- startHour = second part of timestamp (e.g., "18:00:00")

WHAT complete_turbine_config DOES AUTOMATICALLY:
- Generates digital signatures (MD5 unlock codes) for each config point
- Matches codes to config points
- Submits the batch configuration
- Calls 'done' and retrieves the flag
- Returns the flag to you

IF complete_turbine_config FAILS with timeout error:
- Call restart_with_cached_config immediately (it will use your previously analyzed config)
- This tool opens a new session and completes in ~5 seconds

CRITICAL TIME CONSTRAINT:
- collect_data_results will tell you how many seconds remain
- You have roughly 10-15 seconds to analyze and call complete_turbine_config
- Analyze quickly — the rules are clear and deterministic
- After any tool returns a flag, output it in format: {{FLG:...}}

DO NOT:
- Call start_service_window + queue_data_requests + collect_data_results again after a timeout
- Use restart_with_cached_config unless a previous complete_turbine_config timed out
- Ask for clarification — apply the rules and proceed`;

// ─── Definicje narzędzi (OpenAI function calling format) ──────────────────────
/**
 * DEFINICJE NARZĘDZI — specyfikacja dla LLM co może wywołać.
 *
 * OpenAI function calling format wymaga:
 * - name: unikalny identyfikator (snake_case)
 * - description: co robi narzędzie (LLM czyta to przy decydowaniu)
 * - parameters: JSON Schema opisujący argumenty
 *
 * UWAGA o "grubych narzędziach" w tej wersji:
 * Mamy TYLKO 4 narzędzia zamiast 7 z oryginalnej specyfikacji.
 * complete_turbine_config zastępuje: queue_unlock_codes + collect_unlock_codes
 * + submit_config + finalize.
 *
 * To oszczędza 3 LLM roundtrips × ~3s = ~9s krytycznego czasu sesji.
 * Bez tej optymalizacji agent regularnie przekraczał 40s limit.
 */
const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'start_service_window',
      description:
        'Opens the 40-second service window for turbine configuration. MUST be called first — starts the countdown timer.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'queue_data_requests',
      description:
        'Queues weather forecast, turbine status check, and power plant requirements — all three fetched in parallel internally. Call IMMEDIATELY after start_service_window.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'collect_data_results',
      description:
        'Waits for and returns all three data sources (weather forecast, turbine status, power requirements). Weather may take 10-24 seconds. Returns raw data INCLUDING a sessionInfo field showing how many seconds remain — analyze quickly after this!',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_turbine_config',
      description:
        'SUPER-TOOL: Takes your analyzed config points and handles ALL remaining steps: generates unlock codes (in parallel), submits configuration, calls done, and returns the flag. Call this ONCE with ALL config points after your analysis.',
      parameters: {
        type: 'object',
        properties: {
          config_points: {
            type: 'array',
            description:
              'ALL configuration points from your analysis. Include EVERY storm hour (pitchAngle=90, turbineMode=idle) AND the production window (pitchAngle=0, turbineMode=production).',
            items: {
              type: 'object',
              properties: {
                startDate: {
                  type: 'string',
                  description:
                    'Date in YYYY-MM-DD format (from forecast timestamp)',
                },
                startHour: {
                  type: 'string',
                  description:
                    'Hour in HH:00:00 format (from forecast timestamp)',
                },
                windMs: {
                  type: 'number',
                  description:
                    'Wind speed in m/s (use exact value from forecast)',
                },
                pitchAngle: {
                  type: 'number',
                  description: '90 for storm/idle, 0 for production',
                },
                turbineMode: {
                  type: 'string',
                  enum: ['production', 'idle'],
                  description:
                    'idle for storm hours, production for generation window',
                },
              },
              required: [
                'startDate',
                'startHour',
                'windMs',
                'pitchAngle',
                'turbineMode',
              ],
            },
          },
        },
        required: ['config_points'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restart_with_cached_config',
      description:
        'RETRY TOOL: Use this ONLY when complete_turbine_config failed with a timeout error. Automatically starts a new 40s service window and retries the configuration using your previously analyzed config points. No data re-collection needed — completes in ~5 seconds.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

// ─── Główna pętla agenta ReAct ────────────────────────────────────────────────
/**
 * runAgent — główna pętla wzorca ReAct.
 *
 * WZORZEC ReAct (Reasoning + Acting):
 * =====================================
 *
 * Każda ITERACJA pętli to jeden cykl:
 *
 * 1. REASON: Wysyłamy historię konwersacji do LLM.
 *    LLM "czyta" wszystko co się do tej pory wydarzyło
 *    i decyduje co zrobić dalej.
 *
 * 2. ACT: LLM zwraca tool_calls — lista narzędzi do wywołania.
 *    Jeśli LLM zwraca TEXT bez tool_calls → zadanie skończone.
 *
 * 3. OBSERVE: Wykonujemy narzędzia i dodajemy wyniki do historii.
 *    LLM w NASTĘPNEJ iteracji widzi te wyniki i może reagować.
 *
 * HISTORIA KONWERSACJI (messages):
 * ---------------------------------
 * Każda wiadomość to jeden krok:
 * { role: "system" }    → instrukcje systemowe (niezmienne)
 * { role: "assistant" } → odpowiedź LLM (z tool_calls lub tekstem)
 * { role: "tool" }      → wynik wykonania narzędzia
 *
 * LLM widzi CAŁĄ historię → "pamięta" co już zrobił i jakie były wyniki.
 * Dzięki temu nie wykonuje tych samych kroków dwa razy.
 *
 * RÓWNOLEGŁE WYWOŁANIA NARZĘDZI (Parallel Tool Calls):
 * -----------------------------------------------------
 * LLM może zwrócić KILKA tool_calls naraz (np. start_service_window +
 * queue_data_requests w jednej iteracji jeśli model zdecyduje).
 * Wykonujemy je równolegle przez Promise.all na liście tool_calls.
 *
 * W tej implementacji LLM FAKTYCZNIE wywołuje start i queue razem
 * (widać w logach: "2 tool call(s) to execute") — to dodatkowa optymalizacja.
 *
 * WHY Promise.all: Narzędzia w jednej iteracji są niezależne od siebie.
 * Sequential byłoby bezpieczniejsze ale wolniejsze — a czas jest krytyczny.
 *
 * LIMIT ITERACJI:
 * ---------------
 * Maksymalnie 10 iteracji (4 narzędzia + ewentualne retry = max ~8 iteracji).
 * W idealnym scenariuszu: 4-5 iteracji.
 */
async function runAgent(): Promise<void> {
  // Historia konwersacji — serce wzorca ReAct
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  log('Starting ReAct agent loop...');

  // 15 iteracji: 4-5 normalnych + do 3 retry po 2 iteracje = max ~11 iteracji
  for (let iteration = 0; iteration < 15; iteration++) {
    log(`--- Iteration ${iteration + 1} ---`);

    // REASON: Zapytaj LLM co zrobić dalej
    // LLM widzi całą historię (messages) i dostępne narzędzia (tools)
    // tool_choice: "auto" = LLM sam decyduje czy wywołać narzędzie czy zakończyć
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
    });

    const message = response.choices[0].message;

    // Dodaj odpowiedź LLM do historii — musi być przed tool results
    messages.push(message);

    if (message.content) {
      log(
        `LLM: ${message.content.substring(0, 400)}${message.content.length > 400 ? '...' : ''}`,
      );
    } else {
      log(`LLM: (no text content, tool calls only)`);
    }

    // TERMINATION CHECK: Brak tool_calls = LLM zakończył pracę
    // LLM zwraca tekst (odpowiedź końcową) zamiast tool call gdy:
    // a) Zadanie jest wykonane (complete_turbine_config zwróciło flagę)
    // b) Wystąpił błąd i LLM nie wie co dalej
    // c) LLM "zapomniał" wywołać narzędzie (błąd promptu)
    if (!message.tool_calls || message.tool_calls.length === 0) {
      log('Agent finished — no more tool calls.');
      if (message.content) {
        log(`Final message: ${message.content}`);
      }
      break;
    }

    log(`ACT: ${message.tool_calls.length} tool call(s) to execute`);

    // ACT + OBSERVE: Wykonaj wszystkie narzędzia i zbierz wyniki
    //
    // RÓWNOLEGŁE WYKONANIE TOOL CALLS:
    // ---------------------------------
    // LLM może zwrócić kilka tool_calls w jednej iteracji.
    // Promise.all wykonuje je równolegle.
    //
    // WAŻNE: To NIE jest to samo co wewnętrzna równoległość narzędzi.
    // To jest równoległość na poziomie wywołań narzędzi przez LLM.
    // Przykład: LLM zwraca [start_service_window, queue_data_requests] naraz
    // → uruchamiamy oba równolegle → oszczędzamy ~0.5s na wywołaniu
    //
    // W praktyce claude-sonnet-4-5 często wywołuje start + queue razem
    // bo widzi że są niezależne i oba mogą ruszyć natychmiast.
    const toolResults = await Promise.all(
      message.tool_calls.map(async (tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch (err) {
          log(
            `WARNING: Failed to parse tool arguments for ${tc.function.name}: ${err}`,
          );
        }

        const argsPreview = JSON.stringify(args).substring(0, 200);
        log(
          `  Executing: ${tc.function.name}(${argsPreview}${argsPreview.length >= 200 ? '...' : ''})`,
        );

        let result: unknown;
        try {
          result = await executeToolCall(tc.function.name, args);
        } catch (err) {
          // Narzędzie rzuciło wyjątek — zwróć błąd do LLM żeby mógł reagować
          // LLM zobaczy error i zdecyduje czy próbować ponownie czy zakończyć
          log(`  ERROR in ${tc.function.name}: ${err}`);
          result = { error: String(err), tool: tc.function.name };
        }

        const resultJson = JSON.stringify(result);
        log(
          `  Result: ${resultJson.substring(0, 300)}${resultJson.length > 300 ? '...' : ''}`,
        );

        // Format tool result zgodny z OpenAI API
        // tool_call_id musi pasować do id z tool_call — LLM łączy wyniki z wywołaniami
        return {
          role: 'tool' as const,
          tool_call_id: tc.id,
          content: resultJson,
        };
      }),
    );

    // Dodaj wyniki do historii — LLM zobaczy je w następnej iteracji
    messages.push(...toolResults);
  }

  log('ReAct agent loop completed.');
}

// ─── main ─────────────────────────────────────────────────────────────────────

/**
 * main — entry point.
 *
 * Inicjalizuje sessionStart PRZED runAgent jako wartość domyślną.
 * startServiceWindow() nadpisze go na właściwy czas (moment odpowiedzi od serwera).
 */
async function main(): Promise<void> {
  // Pre-inicjalizacja — zostanie nadpisana przez startServiceWindow()
  sessionStart = Date.now();

  log('=== Windpower ReAct Agent v2 ===');
  log(`Model: ${MODEL}`);
  log('Architecture: ReAct (Reasoning + Acting) with LLM as decision maker');
  log(
    "Tools: 4 'fat tools' — start, queue, collect, complete (all-in-one finish)",
  );
  log('');

  await runAgent();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
