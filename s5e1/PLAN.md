# PLAN — Zadanie: radiomonitoring

## Cel

Zaprojektowanie i implementacja systemu wieloagentowego w TypeScript, który:
1. Uruchamia sesję nasłuchu radiowego
2. Iteracyjnie pobiera przechwycone materiały
3. Inteligentnie routuje i analizuje dane (tekst, binaria, szum)
4. Agreguje informacje o mieście "Syjon"
5. Wysyła końcowy raport do Centrali

---

## Architektura: Pipeline wieloagentowy

Kluczowa zasada: **nie jeden wielki prompt, tylko inteligentny pipeline**.

```
┌─────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR                             │
│  start → loop(listen) → aggregate → transmit                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ raw data
                           ▼
                   ┌───────────────┐
                   │  DATA ROUTER  │  (programmatic — zero LLM cost)
                   └──┬────┬───┬──┘
                      │    │   │
              text    │    │   │  binary (Base64)
              ─────   │    │   │  ───────────────
                      ▼    │   ▼
             ┌─────────┐   │  ┌──────────────────┐
             │  TEXT   │   │  │  BINARY DECODER  │  (programmatic)
             │ ANALYST │   │  │  identify MIME   │
             │  (LLM)  │   │  └──────┬───────────┘
             └────┬────┘   │         │
                  │        │  ┌──────┴───────────────────┐
                  │        │  │ image? audio? json? pdf? │
                  │        │  └──────┬───────────────────┘
                  │        │         │
                  │        │  ┌──────▼───────────────┐
                  │        │  │  TYPE-SPECIFIC        │
                  │        │  │  ANALYZER (LLM/code)  │
                  │        │  └──────────────────────┘
                  │   noise│        │
                  │   skip │        │
                  ▼        ▼        ▼
             ┌──────────────────────────┐
             │   INFORMATION AGGREGATOR │
             │ cityName, cityArea,      │
             │ warehousesCount, phone   │
             └────────────┬─────────────┘
                          │ all data collected?
                          ▼
                   ┌──────────────┐
                   │   TRANSMIT   │
                   │   REPORT     │
                   └──────────────┘
```

---

## Składniki systemu

### 1. `ApiClient` (src/apiClient.ts)
- Enkapsuluje komunikację z `process.env.CENTRAL_HUB` (zmienna ze `.env`)
- Metody: `start()`, `listen()`, `transmit(report)`
- `listen()` zwraca ustrukturyzowany obiekt zawierający zarówno dane jak i stan sesji:
  - pole `code` z odpowiedzi API mapowane na `SessionStatus`:
    - `CONTINUE` — dane do przetworzenia, nasłuch kontynuowany
    - `END_OF_DATA` — system sygnalizuje koniec materiału
- Obsługuje błędy HTTP i retry logic

### 2. `DataRouter` (src/dataRouter.ts)
- **Czysto programistyczny** (zero LLM tokens)
- Klasyfikuje każdą odpowiedź API:
  - `TEXT` — zawiera pole `transcription`
  - `BINARY` — zawiera pole `attachment` (Base64)
  - `NOISE` — brak przydatnych danych (brak treści lub krótki szum)
- Dla binarek: określa podtyp MIME w kolejności:
  1. **Pierwotnie:** pole `meta` z odpowiedzi API (np. `"application/json"`) — deterministyczne i bezkosztowe
  2. **Fallback:** wykrywanie przez magic bytes po zdekodowaniu Base64
  - Podtypy: `IMAGE` (jpeg, png, gif, webp), `AUDIO` (mp3, wav, ogg), `JSON` / `TEXT_FILE`, `PDF`, `UNKNOWN`

### 3. `TextAnalystAgent` (src/agents/textAnalyst.ts)
- Przyjmuje transkrypcję tekstową
- Wysyła do LLM (claude-haiku lub gpt-4o-mini — taniego modelu)
- Ekstrakt: wzmianka o mieście, liczbie magazynów, numerze telefonu, powierzchni
- Zwraca ustrukturyzowany obiekt `ExtractedInfo`

### 4. `ImageAnalystAgent` (src/agents/imageAnalyst.ts)
- Przyjmuje zdekodowane bajty obrazu + MIME type
- Konwertuje do base64 data URL
- Wysyła do modelu multimodalnego (np. `google/gemini-2.0-flash` przez OpenRouter)
- Ekstrakt: tekst widoczny na obrazie, mapa, dane geograficzne

### 5. `AudioTranscriber` (src/agents/audioTranscriber.ts)
- Przyjmuje zdekodowane bajty audio
- Jeśli mały (<1MB): wysyła do Whisper przez **Groq API** (`whisper-large-v3`) jako `multipart/form-data` z buforem pliku — Groq jest szybszy i tańszy niż OpenRouter dla audio
  - UWAGA: Whisper wymaga wysyłki pliku jako `FormData`, **nie** JSON z base64 — należy zdekodować base64 do `Buffer` i wysłać jako stream
- Jeśli duży (≥1MB): pomija transkrypcję, loguje ostrzeżenie
- Alternatywnie: ekstrakt metadanych ID3 bez LLM

### 6. `JsonParser` (src/handlers/jsonParser.ts)
- **Czysto programistyczny**
- Parsuje JSON/tekstowe pliki binarne
- Szuka kluczowych pól (city, area, warehouses, phone)

### 7. `InformationAggregator` (src/aggregator.ts)
- Zbiera wszystkie `ExtractedInfo` ze wszystkich agentów
- Merguje dane, rozwiązuje konflikty (np. różne wartości dla tego samego pola)
- Gdy ma wszystkie 4 pola: sygnalizuje gotowość do transmisji
- Buduje końcowy raport **programistycznie** — bez dodatkowego wywołania LLM

### 8. `Orchestrator` (src/orchestrator.ts)
- Koordynuje cały przepływ
- Pętla: `listen → route → analyze → aggregate`
- Zatrzymuje się gdy `ApiClient` zwróci `SessionStatus.END_OF_DATA` lub gdy agregator ma komplet danych
- Max iteracje jako fail-safe (np. 50)
- Po zakończeniu pętli wywołuje `ApiClient.transmit()` z raportem zbudowanym przez `InformationAggregator` — bez dodatkowej syntezy LLM

### 9. `Logger` (src/logger.ts)
- Loguje każdy krok do pliku `logs/session.log`
- Format JSON-lines z timestampem
- Poziomy: INFO, WARN, ERROR, DEBUG

---

## Struktura plików

```
s5e1/
├── src/
│   ├── orchestrator.ts          # główny koordynator
│   ├── apiClient.ts             # komunikacja z hub.ag3nts.org
│   ├── dataRouter.ts            # klasyfikacja i routing danych
│   ├── aggregator.ts            # agregacja wyników
│   ├── logger.ts                # logowanie
│   ├── types.ts                 # wspólne typy TypeScript
│   └── agents/
│       ├── textAnalyst.ts       # analiza transkrypcji tekstowych
│       ├── imageAnalyst.ts      # analiza obrazów (multimodal)
│       └── audioTranscriber.ts  # transkrypcja audio
│   └── handlers/
│       └── jsonParser.ts        # parsowanie JSON/tekst binarny
├── logs/                        # generowane pliki logów
├── index.ts                     # punkt wejścia
├── package.json
├── tsconfig.json
├── .env                         # klucze API (już istnieje)
└── PLAN.md
```

---

## Modele LLM i strategia kosztów

| Typ danych | Handler | Model | Koszt |
|---|---|---|---|
| Szum | DataRouter | — | $0 |
| JSON/tekst plik | JsonParser | — | $0 |
| Wykrywanie MIME | DataRouter | — (`meta` field + magic bytes) | $0 |
| Transkrypcja tekstowa | TextAnalystAgent | `anthropic/claude-haiku-4-5` via OpenRouter | Niski |
| Obraz | ImageAnalystAgent | `google/gemini-2.0-flash` via OpenRouter | Średni |
| Audio | AudioTranscriber | `whisper-large-v3` via Groq API (multipart/form-data) | Niski |
| Budowanie raportu końcowego | InformationAggregator | — (programistyczne) | $0 |

---

## Kroki implementacji

1. **Setup projektu** — `package.json`, `tsconfig.json`, zależności (`axios`, `dotenv`, `file-type`)
2. **Typy i Logger** — `types.ts`, `logger.ts`
3. **ApiClient** — komunikacja z API
4. **DataRouter** — klasyfikacja danych (programistyczna)
5. **Agenci analizy** — TextAnalyst, ImageAnalyst, AudioTranscriber, JsonParser
6. **InformationAggregator** — mergowanie wyników
7. **Orchestrator** — pętla główna
8. **index.ts** — punkt startowy
9. **Testy manualne i debugging**

---

## Obsługa błędów i edge cases

- **Retry z backoff**: ApiClient retry 3x z exponential backoff dla błędów sieciowych
- **Timeout**: każde wywołanie LLM ma timeout 30s
- **Duże binaria**: pliki >5MB są logowane i pomijane (zamiast kosztownego wysłania do LLM)
- **Niekompletne dane**: Orchestrator kontynuuje nasłuch nawet po wykryciu części informacji
- **Fail-safe**: max 50 iteracji nasłuchu zapobiega nieskończonej pętli
- **Walidacja raportu**: przed `transmit` sprawdzana poprawność formatu `cityArea` (2 miejsca dziesiętne)

---

## Środowisko i uruchomienie

```bash
# Instalacja zależności
npm install

# Uruchomienie systemu
npm run start

# Podgląd logów w czasie rzeczywistym
tail -f logs/session.log
```

---

## Oczekiwane wyjście

System loguje każdy krok i na końcu wyświetla raport:

```json
{
  "cityName": "...",
  "cityArea": "12.34",
  "warehousesCount": 321,
  "phoneNumber": "123456789"
}
```

oraz odpowiedź z Centrali po transmisji.
