# Plan rozwiązania: S4E4 — Filesystem z notatek Natana

---

## 1. Analiza problemu

Zadanie polega na:

1. Pobraniu notatek Natana (`natan_notes.zip`) — 4 pliki: ogłoszenia, rozmowy, transakcje, README
2. Zanalizowaniu ich za pomocą LLM, by wyodrębnić strukturyzowane dane
3. Zbudowaniu wirtualnego filesystemu przez API (`/verify`)
4. Weryfikacji przez wywołanie akcji `done`

**Endpoint API:** `https://hub.ag3nts.org/verify`
**Task name:** `filesystem`

---

## 2. Architektura: Pipeline agentowy (6 kroków)

Zamiast jednego monolitycznego agenta — **pipeline wielokrokowy** z osobnymi wywołaniami LLM:

```
[Krok 1] Note Fetcher     → pobiera i rozpakowuje ZIP z notatkami (4 pliki)
[Krok 2] API Help         → odpytuje /help, poznaje limity i akcje API
[Krok 3] Data Extractor   → 3 równoległe wywołania LLM:
                              - 3a: Miasta + potrzeby towarowe (z ogłoszenia.txt)
                              - 3b: Osoby zarządzające miastami (z rozmowy.txt)
                              - 3c: Towary na sprzedaż (z transakcje.txt)
[Krok 4] Reset            → czyści poprzedni stan (akcja `reset`)
[Krok 5] Filesystem Build → 32 akcje jednym batch requestem:
                              3 katalogi + 8 plików miast + 8 plików osób + 13 plików towarów
[Krok 6] Verify           → wysyła akcję `done` → flaga
```

**Dlaczego pipeline, a nie jeden agent?**

- Separacja odpowiedzialności (SoC) — każdy krok testowalny niezależnie
- 3 równoległe wywołania LLM w kroku 3 (szybciej, mniejszy kontekst per wywołanie)
- LLM z węższym zakresem zadania = wyższa jakość ekstrakcji
- Łatwiejsza debugowalność — logujemy wynik każdego kroku

---

## 3. Struktura danych wyodrębniona z notatek

### `/miasta/<nazwa>` — plik JSON z potrzebami

Nazwa pliku: mianownik, małe litery, bez polskich znaków (np. `/miasta/brudzewo`).

```json
{
  "ryz": 55,
  "woda": 140,
  "wiertarka": 5
}
```

### `/osoby/<imie_nazwisko>` — plik markdown z linkiem

Nazwa pliku: `imie_nazwisko` (małe litery, podkreślenie, bez polskich znaków).
Treść może zawierać polskie znaki (tylko nazwy plików muszą być ASCII).

```markdown
Rafał Kisiel

[Brudzewo](/miasta/brudzewo)
```

### `/towary/<towar>` — plik markdown z linkami do sprzedawców

Jeden plik per unikalny towar. Jeśli wiele miast sprzedaje ten sam towar → wiele linków.

```markdown
[Brudzewo](/miasta/brudzewo)
[Puck](/miasta/puck)
```

---

## 4. Implementacja

### Stos technologiczny

- **TypeScript** + `tsx` (uruchomienie bez kompilacji)
- **`jszip`** — rozpakowywanie ZIP w pamięci
- **`dotenv`** — zmienne środowiskowe z `.env`
- **OpenRouter API** → model `anthropic/claude-haiku-4-5`
- Wbudowane `fetch` (Node 18+) — bez dodatkowych HTTP lib

### Struktura plików

```
s4e4/
├── .env              ← OPENROUTER_API_KEY, AI_DEVS_API_KEY, CENTRAL_HUB_LINK
├── PLAN.md           ← ten plik
├── solution.ts       ← główna logika agenta
├── package.json
└── tsconfig.json
```

---

## 5. Kluczowe wnioski z procesu (błędy i poprawki)

| Problem                               | Przyczyna                                                           | Rozwiązanie                                                   |
| ------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| HTTP 400 OpenRouter                   | Błędny ID modelu (`gemini-2.5-flash-preview`)                       | Zmiana na `anthropic/claude-haiku-4-5`                        |
| `createDir` nie działa                | API używa `createDirectory`, nie `createDir`                        | Poprawione po lekturze `/help`                                |
| Zbyt wiele osób (10 zamiast 8)        | LLM traktował Rafała i Konkela jako osobne osoby zarządzające       | Ulepszony prompt z jasnymi przykładami                        |
| Link `/miasta/domatow` nieznaleziony  | LLM pisał "Domatów" (z ó) → `toFileName()` = "domatow" ≠ "domatowo" | Funkcja `matchCityFile()` — fuzzy prefix matching             |
| Brak "Rafał Kisiel" i "Lena Konkel"   | LLM nie połączył imion z nazwiskami z różnych akapitów              | Explicit examples w prompcie (imię + nazwisko z różnych zdań) |
| Nazwy plików muszą być `^[a-z0-9_]+$` | Limit API                                                           | Funkcja `toFileName()` — ASCII, małe litery, podkreślenia     |
| Towary z wieloma sprzedawcami         | `global_unique_names: true` — jeden plik per towar                  | Grupowanie po towarze, wiele linków markdown w jednym pliku   |

---

## 6. Prompty LLM (finalne)

### 3a — Potrzeby miast (ogłoszenia.txt)

- Ekstrakcja miast i ich potrzeb z tablic ogłoszeń
- Nazwy bez polskich znaków, mianownik l.poj., ilości jako liczby

### 3b — Osoby odpowiedzialne (rozmowy.txt)

- Dokładnie 1 osoba per miasto (zarządca, nie transportowiec)
- Łączenie imion i nazwisk z różnych akapitów (kluczowy przypadek: Rafał + Kisiel, Lena + Konkel)
- Explicit examples dla trudnych przypadków bezpośrednio w prompcie

### 3c — Towary na sprzedaż (transakcje.txt)

- Format wejścia: `Sprzedawca → towar → Kupiec`
- Ekstrakcja par (towar, sprzedawca) — duplikaty są oczekiwane (wiele miast, ten sam towar)
- Nazwy towarów: mianownik l.poj.

---

## 7. Uruchomienie

```bash
cd s4e4
npm install
npm start
```

Oczekiwany wynik końcowy:

```json
{ "code": 0, "message": "{FLG:DEALWITHIT}" }
```
