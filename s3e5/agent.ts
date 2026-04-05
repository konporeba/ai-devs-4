/**
 * =====================================================================
 * AGENT: SaveThem - Planowanie optymalnej trasy do Skolwin
 * =====================================================================
 *
 * ARCHITEKTURA: Pojedynczy agent reaktywno-eksploracyjny
 * --------------------------------------------------------
 * Zamiast systemu wielu agentów, używamy jednego agenta działającego
 * w pętli "rozpoznaj → zaplanuj → wykonaj". To odpowiedni wybór, bo:
 * 1. Zadanie jest sekwencyjne: najpierw trzeba poznać teren i reguły,
 *    potem zaplanować trasę i ją wysłać.
 * 2. Narzędzia są "jednowymiarowe" (każde odpowiada tylko na jedno query).
 * 3. Nie ma potrzeby równoległego przetwarzania wielu źródeł naraz.
 *
 * PRZEPŁYW DZIAŁANIA AGENTA:
 * 1. Wyszukaj dostępne narzędzia przez toolsearch API
 * 2. Pobierz mapę Skolwin (/api/maps)
 * 3. Pobierz dane pojazdów (/api/wehicles)
 * 4. Wczytaj zasady z notatek (/api/books)
 * 5. Oblicz optymalną trasę (algorytm przeszukiwania grafu)
 * 6. Wyślij odpowiedź do /verify
 */

import * as https from "https";
import * as http from "http";
import * as fs from "fs";

// =====================================================================
// KONFIGURACJA
// =====================================================================

// Klucz API do autoryzacji wszystkich zapytań
const API_KEY = "1fd2f6a6-9e2b-4ab4-bd4d-20198d42b18e";

// Bazowy adres serwera zadania
const BASE_URL = "https://hub.ag3nts.org";

// Zasoby startowe - musimy się zmieścić w tych limitach
const INITIAL_FOOD = 10; // 10 porcji jedzenia
const INITIAL_FUEL = 10; // 10 jednostek paliwa

// =====================================================================
// TYPY DANYCH (TypeScript interfaces)
// =====================================================================

/**
 * Reprezentacja jednego kafelka na mapie
 * Mapa to siatka 10x10 kafelków
 */
type TileType = "." | "T" | "W" | "R" | "S" | "G";
// . = wolne pole (passable)
// T = drzewo (passable, ale +0.2 paliwa dla pojazdów silnikowych)
// W = woda (nieprzechodnia dla samochodu/rakiety, ok dla konia/piechura)
// R = skały (absolutnie nieprzechodni)
// S = start
// G = cel

/** Typ środka transportu */
type VehicleType = "rocket" | "car" | "horse" | "walk";

/** Kierunki ruchu na mapie */
type Direction = "up" | "down" | "left" | "right";

/** Zużycie zasobów dla każdego środka transportu */
interface VehicleStats {
  name: VehicleType;
  fuelPerMove: number; // paliwo za każdy krok
  foodPerMove: number; // jedzenie za każdy krok
  canCrossWater: boolean; // czy może przechodzić przez wodę?
}

/**
 * Stan agenta w trakcie wędrówki:
 * pozycja + zasoby + aktualny środek transportu
 */
interface AgentState {
  row: number; // aktualna pozycja (wiersz, 0=góra)
  col: number; // aktualna pozycja (kolumna, 0=lewa)
  food: number; // pozostałe jedzenie
  fuel: number; // pozostałe paliwo
  vehicle: VehicleType; // aktualny środek transportu
  commands: string[]; // lista wykonanych komend
}

/** Odpowiedź z API toolsearch */
interface ToolSearchResponse {
  code: number;
  message: string;
  tools: Array<{
    name: string;
    url: string;
    description: string;
    parameter: string;
    score: number;
  }>;
}

/** Odpowiedź z API maps */
interface MapsResponse {
  code: number;
  message: string;
  cityName?: string;
  map?: TileType[][];
  text?: string;
}

/** Odpowiedź z API wehicles (uwaga: literówka w nazwie endpointu) */
interface VehiclesResponse {
  code: number;
  message: string;
  name?: string;
  consumption?: {
    fuel: number;
    food: number;
  };
}

/** Odpowiedź weryfikacyjna z /verify */
interface VerifyResponse {
  code: number;
  message: string;
  note?: string;
  flag?: string;
}

// =====================================================================
// FUNKCJE POMOCNICZE - KOMUNIKACJA Z API
// =====================================================================

/**
 * Wysyła zapytanie POST do endpointu API i zwraca odpowiedź jako JSON.
 *
 * Dlaczego POST zamiast GET?
 * - API wymaga przekazania apikey i query w ciele żądania
 * - To standardowe podejście dla API wymagającego autoryzacji
 *
 * @param endpoint - pełny URL lub ścieżka (np. "/api/maps")
 * @param body - obiekt do wysłania jako JSON
 */
function apiPost<T>(endpoint: string, body: object): Promise<T> {
  return new Promise((resolve, reject) => {
    // Obsługujemy zarówno pełne URL-e jak i same ścieżki
    const url = endpoint.startsWith("http")
      ? endpoint
      : `${BASE_URL}${endpoint}`;

    // Przygotowujemy dane do wysłania
    const jsonBody = JSON.stringify(body);

    // Parsujemy URL aby wyciągnąć hosta i ścieżkę
    const urlObj = new URL(url);

    // Konfiguracja żądania HTTP
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(jsonBody),
      },
    };

    // Wybieramy moduł https lub http w zależności od protokołu
    const requester = urlObj.protocol === "https:" ? https : http;

    const req = requester.request(options, (res) => {
      let data = "";

      // Zbieramy dane przychodzące w kawałkach (streaming)
      res.on("data", (chunk) => {
        data += chunk;
      });

      // Po otrzymaniu wszystkich danych - parsujemy JSON
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(new Error(`Błąd parsowania JSON: ${data}`));
        }
      });
    });

    req.on("error", reject);

    // Wysyłamy ciało żądania
    req.write(jsonBody);
    req.end();
  });
}

// =====================================================================
// FAZA 1: ODKRYWANIE NARZĘDZI
// =====================================================================

/**
 * Używa toolsearch do znalezienia dostępnych narzędzi.
 *
 * To jest kluczowy pattern w architekturze agentów:
 * "discovery before action" - najpierw odkrywamy co mamy do dyspozycji,
 * potem korzystamy z tych zasobów.
 *
 * @param query - zapytanie w języku naturalnym (tylko angielski!)
 */
async function searchTools(query: string): Promise<ToolSearchResponse> {
  log(`[TOOLSEARCH] Szukam narzędzi: "${query}"`);
  const result = await apiPost<ToolSearchResponse>("/api/toolsearch", {
    apikey: API_KEY,
    query,
  });
  log(
    `[TOOLSEARCH] Znaleziono ${result.tools?.length || 0} narzędzi: ${result.tools?.map((t) => t.name).join(", ")}`
  );
  return result;
}

// =====================================================================
// FAZA 2: POBIERANIE MAPY
// =====================================================================

/**
 * Pobiera mapę terenu dla danego miasta z /api/maps.
 *
 * Kluczowe odkrycie: endpoint /api/maps potrzebuje NAZWY MIASTA w query,
 * nie ogólnego opisu. To pokazuje, jak ważna jest eksploracja narzędzi
 * zanim się z nich skorzysta.
 *
 * @param cityName - nazwa miasta (np. "Skolwin")
 */
async function getMap(cityName: string): Promise<TileType[][]> {
  log(`[MAPS] Pobieram mapę dla miasta: ${cityName}`);
  const result = await apiPost<MapsResponse>("/api/maps", {
    apikey: API_KEY,
    query: cityName,
  });

  if (!result.map) {
    throw new Error(`Nie znaleziono mapy dla miasta ${cityName}: ${result.message}`);
  }

  log(`[MAPS] Mapa pobrana pomyślnie (${result.map.length}x${result.map[0].length})`);
  return result.map;
}

// =====================================================================
// FAZA 3: POBIERANIE DANYCH POJAZDÓW
// =====================================================================

/**
 * Pobiera statystyki pojazdu z /api/wehicles.
 *
 * Uwaga: nazwa endpointu zawiera celową literówkę "wehicles" zamiast
 * "vehicles" - to jest cecha systemu zadania, nie błąd w naszym kodzie!
 *
 * Każdy pojazd ma inne zużycie paliwa i jedzenia. To jest kluczowe
 * do optymalizacji trasy.
 *
 * @param vehicleName - nazwa pojazdu (rocket/car/horse/walk)
 */
async function getVehicleStats(vehicleName: string): Promise<VehicleStats> {
  log(`[VEHICLES] Pobieram dane pojazdu: ${vehicleName}`);
  const result = await apiPost<VehiclesResponse>("/api/wehicles", {
    apikey: API_KEY,
    query: vehicleName,
  });

  if (!result.consumption) {
    throw new Error(`Brak danych dla pojazdu ${vehicleName}`);
  }

  // Definiujemy który pojazd może przechodzić przez wodę
  // (wiedza z /api/books: tylko horse i walk mogą)
  const canCrossWater = vehicleName === "horse" || vehicleName === "walk";

  return {
    name: vehicleName as VehicleType,
    fuelPerMove: result.consumption.fuel,
    foodPerMove: result.consumption.food,
    canCrossWater,
  };
}

// =====================================================================
// FAZA 4: PLANOWANIE TRASY
// =====================================================================

/**
 * Analizuje mapę i znajduje pozycję startową (S) oraz cel (G).
 *
 * @param map - dwuwymiarowa tablica kafelków
 */
function findPositions(
  map: TileType[][]
): { start: [number, number]; goal: [number, number] } {
  let start: [number, number] | null = null;
  let goal: [number, number] | null = null;

  for (let row = 0; row < map.length; row++) {
    for (let col = 0; col < map[row].length; col++) {
      if (map[row][col] === "S") start = [row, col];
      if (map[row][col] === "G") goal = [row, col];
    }
  }

  if (!start || !goal) {
    throw new Error("Nie znaleziono pozycji startowej (S) lub celu (G) na mapie!");
  }

  log(`[PATHFIND] Start: (${start[0]},${start[1]}), Cel: (${goal[0]},${goal[1]})`);
  return { start, goal };
}

/**
 * Sprawdza czy kafelek jest dostępny dla danego środka transportu.
 *
 * Zasady przejścia przez teren (z /api/books):
 * - R (skały): całkowicie blokują ruch
 * - W (woda): można przejść pieszo lub konno; auto/rakieta - NIE
 * - T (drzewo): można przejść wszystkim, ale +0.2 paliwa dla silnikowych
 * - . / S / G: zawsze przechodnie
 *
 * @param tile - typ kafelka
 * @param vehicle - aktualny środek transportu
 */
function isTilePassable(tile: TileType, vehicle: VehicleStats): boolean {
  if (tile === "R") return false; // Skały - blokują wszystko
  if (tile === "W") return vehicle.canCrossWater; // Woda - tylko horse/walk
  return true; // Wszystko inne jest przechodnie
}

/**
 * Oblicza koszt wejścia na dany kafelek.
 *
 * Koszt to para [paliwo, jedzenie] wydane na ten jeden krok.
 * Drzewo (T) dolicza +0.2 paliwa dla pojazdów silnikowych (rocket, car).
 *
 * @param tile - typ kafelka celu
 * @param vehicle - aktualny środek transportu
 */
function getMoveCost(
  tile: TileType,
  vehicle: VehicleStats
): { fuel: number; food: number } {
  let fuel = vehicle.fuelPerMove;
  let food = vehicle.foodPerMove;

  // Drzewo: dodatkowe 0.2 paliwa dla napędzanych pojazdów
  if (tile === "T" && vehicle.fuelPerMove > 0) {
    fuel += 0.2;
  }

  return { fuel, food };
}

/**
 * GŁÓWNA FUNKCJA PLANOWANIA TRASY
 *
 * Używamy algorytmu BFS (Breadth-First Search) / A* z uwzględnieniem
 * zasobów. Stan to (row, col, fuel, food, vehicle).
 *
 * STRATEGIA OPTYMALIZACYJNA:
 * Zamiast czystego BFS, używamy specjalnej wiedzy dziedzinowej:
 *
 * Problem: woda dzieli mapę na lewą i prawą część.
 * - Rakieta: szybka (0.1 food/ruch), ale nie może przez wodę
 * - Pieszy: może przez wodę, ale drogi (2.5 food/ruch)
 *
 * Optymalna strategia:
 * 1. Start z RAKIETĄ (mało jedzenia = oszczędzamy)
 * 2. Jedź do krawędzi rzeki (col 5, row 4)
 * 3. DISMOUNT - wysiądź z rakiety
 * 4. Idź pieszo przez 1 wodny kafelek (4,6)
 * 5. Dojdź do celu G(4,8) jeszcze 2 kroki pieszo
 *
 * Weryfikacja zasobów:
 * - Paliwo: 8 kroków rakietą = 8.2 paliwa (drzewo na (4,2)) ≤ 10 ✓
 * - Jedzenie: 8×0.1 + 3×2.5 = 0.8 + 7.5 = 8.3 ≤ 10 ✓
 *
 * @param map - mapa terenu
 * @param allVehicles - dane wszystkich pojazdów
 */
function planOptimalRoute(
  map: TileType[][],
  allVehicles: Map<VehicleType, VehicleStats>
): string[] {
  const { start, goal } = findPositions(map);

  log(`[PATHFIND] Planuję trasę...`);
  log(`[PATHFIND] Zasoby: ${INITIAL_FOOD} jedzenia, ${INITIAL_FUEL} paliwa`);

  // Używamy algorytmu BFS ze stanem (row, col, fuel, food, vehicle, commands)
  // State key: "row,col,vehicle,fuel_rounded,food_rounded"
  // (zaokrąglamy do 1 miejsca po przecinku żeby ograniczyć przestrzeń stanów)

  interface SearchState {
    row: number;
    col: number;
    fuel: number;
    food: number;
    vehicle: VehicleType;
    commands: string[];
    costSoFar: number; // całkowity koszt (liczba kroków) - do optymalizacji
  }

  // Kolejka priorytetowa (Dijkstra) - minimalizujemy liczbę kroków
  const queue: SearchState[] = [];

  // Stan początkowy: próbujemy każdy pojazd startowy
  for (const [vehicleName, vehicleStats] of allVehicles) {
    // Nie startujemy z "walk" jako nazwanym pojazdem jeśli są lepsze opcje
    queue.push({
      row: start[0],
      col: start[1],
      fuel: INITIAL_FUEL,
      food: INITIAL_FOOD,
      vehicle: vehicleName,
      commands: [vehicleName], // pierwszy element to nazwa pojazdu
      costSoFar: 0,
    });
  }

  // Odwiedzone stany: zapobiegamy zapętleniu
  // Klucz: "row,col,vehicle,fuel1d,food1d"
  const visited = new Set<string>();

  const makeKey = (s: SearchState): string => {
    return `${s.row},${s.col},${s.vehicle},${Math.round(s.fuel * 10)},${Math.round(s.food * 10)}`;
  };

  // Sortujemy kolejkę po długości ścieżki (BFS-like przez sortowanie)
  const sortQueue = () => {
    queue.sort((a, b) => a.costSoFar - b.costSoFar);
  };

  sortQueue();

  // Kierunki ruchu z odpowiadającymi zmianami pozycji
  const moves: Array<{ dir: Direction; dr: number; dc: number }> = [
    { dir: "up", dr: -1, dc: 0 }, // góra = zmniejsz wiersz
    { dir: "down", dr: 1, dc: 0 }, // dół = zwiększ wiersz
    { dir: "left", dr: 0, dc: -1 }, // lewo = zmniejsz kolumnę
    { dir: "right", dr: 0, dc: 1 }, // prawo = zwiększ kolumnę
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 100000;

  while (queue.length > 0 && iterations < MAX_ITERATIONS) {
    iterations++;

    // Pobieramy najlepszy stan z kolejki
    const current = queue.shift()!;

    // Sprawdzamy czy dotarliśmy do celu
    if (current.row === goal[0] && current.col === goal[1]) {
      log(
        `[PATHFIND] Znaleziono trasę! Kroki: ${current.commands.length - 1}, Iterations: ${iterations}`
      );
      log(
        `[PATHFIND] Zużycie: paliwo=${(INITIAL_FUEL - current.fuel).toFixed(1)}, jedzenie=${(INITIAL_FOOD - current.food).toFixed(1)}`
      );
      return current.commands;
    }

    // Sprawdzamy czy nie odwiedziliśmy już tego stanu
    const key = makeKey(current);
    if (visited.has(key)) continue;
    visited.add(key);

    const currentVehicle = allVehicles.get(current.vehicle)!;

    // RUCH - próbujemy wszystkie 4 kierunki
    for (const move of moves) {
      const newRow = current.row + move.dr;
      const newCol = current.col + move.dc;

      // Sprawdzamy czy nie wychodzimy poza mapę
      if (newRow < 0 || newRow >= map.length || newCol < 0 || newCol >= map[0].length) {
        continue;
      }

      const targetTile = map[newRow][newCol];

      // Sprawdzamy czy kafelek jest dostępny dla aktualnego pojazdu
      if (!isTilePassable(targetTile, currentVehicle)) {
        continue;
      }

      // Obliczamy koszt ruchu
      const cost = getMoveCost(targetTile, currentVehicle);

      // Sprawdzamy czy mamy wystarczające zasoby
      if (current.fuel < cost.fuel - 0.001 || current.food < cost.food - 0.001) {
        continue;
      }

      queue.push({
        row: newRow,
        col: newCol,
        fuel: current.fuel - cost.fuel,
        food: current.food - cost.food,
        vehicle: current.vehicle,
        commands: [...current.commands, move.dir],
        costSoFar: current.costSoFar + 1,
      });
    }

    // DISMOUNT - wysiądź z pojazdu i idź pieszo
    // Można to zrobić tylko jeśli aktualnie jedziemy pojazdem (nie pieszo)
    if (current.vehicle !== "walk") {
      const walkStats = allVehicles.get("walk")!;
      queue.push({
        row: current.row,
        col: current.col,
        fuel: current.fuel, // dismount nie kosztuje paliwa
        food: current.food, // dismount nie kosztuje jedzenia
        vehicle: "walk",
        commands: [...current.commands, "dismount"],
        costSoFar: current.costSoFar, // dismount nie liczy się jako krok
      });
    }

    // Re-sortujemy kolejkę po dodaniu nowych stanów
    // W prawdziwej implementacji używalibyśmy priority queue (kopiec)
    // Tu dla uproszczenia sortujemy tablicę
    if (queue.length % 1000 === 0) {
      sortQueue();
    }
  }

  sortQueue();

  throw new Error(`Nie znaleziono trasy do celu po ${iterations} iteracjach!`);
}

// =====================================================================
// FAZA 5: WYSYŁANIE ODPOWIEDZI
// =====================================================================

/**
 * Wysyła planowaną trasę do endpointu /verify.
 *
 * Format odpowiedzi:
 * - Pierwszy element: nazwa pojazdu startowego
 * - Kolejne elementy: komendy ruchu (up/down/left/right/dismount)
 *
 * Przykład: ["rocket", "up", "up", "right", "dismount", "right"]
 *
 * @param route - tablica komend (pojazd + ruchy)
 */
async function submitAnswer(route: string[]): Promise<VerifyResponse> {
  log(`[VERIFY] Wysyłam trasę: ${JSON.stringify(route)}`);

  const result = await apiPost<VerifyResponse>("/verify", {
    apikey: API_KEY,
    task: "savethem",
    answer: route,
  });

  log(`[VERIFY] Odpowiedź serwera: code=${result.code}, message="${result.message}"`);
  if (result.flag) {
    log(`[VERIFY] 🏆 FLAGA: ${result.flag}`);
  }
  if (result.note) {
    log(`[VERIFY] Nota: ${result.note}`);
  }

  return result;
}

// =====================================================================
// LOGOWANIE
// =====================================================================

/** Ścieżka do pliku logów - wszystkie kroki agenta są zapisywane */
const LOG_FILE = "x:\\AI_Devs4\\s3e5\\agent_log.txt";

/**
 * Zapisuje wiadomość do konsoli i do pliku logów.
 *
 * Dlaczego logujemy do pliku?
 * - Możemy prześledzić każdy krok agenta po fakcie
 * - Pomaga w debugowaniu gdy agent podejmuje nieoczekiwane decyzje
 * - Dobra praktyka w systemach produkcyjnych
 *
 * @param message - wiadomość do zalogowania
 */
function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;

  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
}

// =====================================================================
// GŁÓWNA FUNKCJA AGENTA
// =====================================================================

/**
 * Główna pętla agenta. Realizuje strategię:
 * ODKRYJ → ZBIERZ DANE → ZAPLANUJ → WYKONAJ
 *
 * To jest wzorzec "ReAct" (Reason + Act):
 * 1. Reason: zbieramy informacje, analizujemy mapę, planujemy
 * 2. Act: wysyłamy zaplanowaną trasę
 */
async function runAgent(): Promise<void> {
  // Wyczyść stary log i zacznij nowy
  fs.writeFileSync(LOG_FILE, "", "utf-8");

  log("=".repeat(60));
  log("AGENT SAVETHEM - START");
  log("=".repeat(60));

  try {
    // -----------------------------------------------------------------
    // FAZA 1: ODKRYJ NARZĘDZIA
    // -----------------------------------------------------------------
    log("\n--- FAZA 1: Odkrywanie narzędzi ---");

    // Szukamy narzędzi do map
    await searchTools("map terrain grid movement rules");
    // Szukamy narzędzi do pojazdów
    await searchTools("vehicles transportation fuel consumption");
    // Szukamy narzędzi do zasad
    await searchTools("notes rules game mechanics");

    // -----------------------------------------------------------------
    // FAZA 2: POBIERZ MAPĘ
    // -----------------------------------------------------------------
    log("\n--- FAZA 2: Pobieranie mapy ---");
    const map = await getMap("Skolwin");

    // Wypisz mapę w czytelnej formie
    log("[MAP] Mapa Skolwin:");
    for (let row = 0; row < map.length; row++) {
      log(`[MAP] Row ${row}: ${map[row].join(" ")}`);
    }

    // -----------------------------------------------------------------
    // FAZA 3: POBIERZ DANE POJAZDÓW
    // -----------------------------------------------------------------
    log("\n--- FAZA 3: Pobieranie danych pojazdów ---");

    const vehicleNames: VehicleType[] = ["rocket", "car", "horse", "walk"];
    const allVehicles = new Map<VehicleType, VehicleStats>();

    for (const vehicleName of vehicleNames) {
      const stats = await getVehicleStats(vehicleName);
      allVehicles.set(vehicleName, stats);
      log(
        `[VEHICLES] ${vehicleName}: paliwo=${stats.fuelPerMove}/ruch, jedzenie=${stats.foodPerMove}/ruch, może_wodę=${stats.canCrossWater}`
      );
    }

    // -----------------------------------------------------------------
    // FAZA 4: ZAPLANUJ TRASĘ
    // -----------------------------------------------------------------
    log("\n--- FAZA 4: Planowanie optymalnej trasy ---");

    // Wywołujemy algorytm wyszukiwania ścieżki
    const route = planOptimalRoute(map, allVehicles);

    log("\n[RESULT] Optymalna trasa:");
    log(`[RESULT] Pojazd startowy: ${route[0]}`);
    log(`[RESULT] Komendy: ${route.slice(1).join(" → ")}`);
    log(`[RESULT] Liczba kroków: ${route.filter((c) => ["up", "down", "left", "right"].includes(c)).length}`);

    // Symulujemy trasę żeby sprawdzić zasoby
    simulateAndLogRoute(route, map, allVehicles);

    // -----------------------------------------------------------------
    // FAZA 5: WYŚLIJ ODPOWIEDŹ
    // -----------------------------------------------------------------
    log("\n--- FAZA 5: Wysyłanie odpowiedzi ---");
    const result = await submitAnswer(route);

    // Flaga może pojawić się w polu "flag" lub w polu "message" w formacie {FLG:...}
    const flagInMessage = result.message && result.message.includes("FLG:");
    if (result.code === 200 || result.flag || flagInMessage) {
      log("\n[SUCCESS] ✓ Zadanie ukończone pomyślnie!");
      log(`[SUCCESS] 🏆 FLAGA: ${result.flag || result.message}`);
    } else {
      log(`\n[FAIL] ✗ Zadanie nieudane. Code: ${result.code}, Message: ${result.message}`);
    }
  } catch (error) {
    log(`[ERROR] Błąd krytyczny: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  log("\n" + "=".repeat(60));
  log("AGENT SAVETHEM - KONIEC");
  log("=".repeat(60));
}

/**
 * Symuluje trasę krok po kroku i loguje zużycie zasobów.
 * Pomaga zweryfikować, że trasa jest poprawna zanim wyślemy odpowiedź.
 *
 * @param route - lista komend
 * @param map - mapa terenu
 * @param allVehicles - dane pojazdów
 */
function simulateAndLogRoute(
  route: string[],
  map: TileType[][],
  allVehicles: Map<VehicleType, VehicleStats>
): void {
  const { start } = findPositions(map);

  let row = start[0];
  let col = start[1];
  let fuel = INITIAL_FUEL;
  let food = INITIAL_FOOD;
  let currentVehicle = allVehicles.get(route[0] as VehicleType)!;

  log(`\n[SIM] Symulacja trasy:`);
  log(`[SIM] Start: (${row},${col}), pojazd=${currentVehicle.name}, paliwo=${fuel}, jedzenie=${food}`);

  for (let i = 1; i < route.length; i++) {
    const cmd = route[i];

    if (cmd === "dismount") {
      currentVehicle = allVehicles.get("walk")!;
      log(`[SIM] Krok ${i}: DISMOUNT → teraz idę pieszo @ (${row},${col})`);
      continue;
    }

    // Oblicz nową pozycję
    const dirMap: Record<string, [number, number]> = {
      up: [-1, 0],
      down: [1, 0],
      left: [0, -1],
      right: [0, 1],
    };

    const [dr, dc] = dirMap[cmd];
    const newRow = row + dr;
    const newCol = col + dc;
    const tile = map[newRow][newCol];
    const cost = getMoveCost(tile, currentVehicle);

    fuel -= cost.fuel;
    food -= cost.food;
    row = newRow;
    col = newCol;

    log(
      `[SIM] Krok ${i}: ${cmd} → (${row},${col})=${tile}, -paliwo=${cost.fuel.toFixed(1)}, -jedzenie=${cost.food.toFixed(1)} | zostało: paliwo=${fuel.toFixed(1)}, jedzenie=${food.toFixed(1)}`
    );
  }

  log(`[SIM] Koniec symulacji: pozycja=(${row},${col}), paliwo_pozostałe=${fuel.toFixed(1)}, jedzenie_pozostałe=${food.toFixed(1)}`);

  if (fuel < -0.001 || food < -0.001) {
    log(`[SIM] ⚠️ UWAGA: Niewystarczające zasoby! paliwo=${fuel.toFixed(2)}, jedzenie=${food.toFixed(2)}`);
  } else {
    log(`[SIM] ✓ Zasoby wystarczające!`);
  }
}

// =====================================================================
// URUCHOMIENIE AGENTA
// =====================================================================

// Punkt wejścia - uruchamiamy agenta
runAgent().catch((error) => {
  console.error("Krytyczny błąd agenta:", error);
  process.exit(1);
});
