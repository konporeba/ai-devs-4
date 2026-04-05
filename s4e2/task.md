# Zadanie praktyczne

Twoim zadaniem jest zaprogramowanie harmonogramu pracy turbiny wiatrowej w taki sposób, aby uzyskać moc niezbędną do uruchomienia elektrowni.

Elektrownia nie może pracować przez cały czas, ponieważ jej bateria na to nie pozwoli. Musisz więc uruchomić jej system tylko wtedy, gdy naprawdę będzie wymagany. Jesteś w stanie znaleźć idealny czas poprzez analizę wyników prognozy pogody.

Dostarczone przez nas API dają Ci też informacje na temat stanu samej turbiny oraz na temat wymagań elektrowni. Przygotowanie raportu do każdej z funkcji wymaga czasu. Nie jesteśmy w stanie powiedzieć, ile konkretnie czasu zajmie wykonanie danej funkcji, ale wywołania te są kolejkowane. Później musisz tylko wywołać funkcję do pobierania wygenerowanych raportów.

Każdy wygenerowany raport da się pobrać tylko jednokrotnie. Jeśli uda Ci się wszystko skonfigurować w czasie 40 sekund, to jesteśmy uratowani i możemy przejść do fazy produkcji prądu.

- **Nazwa zadania:** `windpower`
- **Odpowiedź wysyłasz do:** `/verify`

> ⚠️ **UWAGA:** to zadanie posiada limit czasu (40 sekund), w którym musisz się zmieścić. Liniowe wykonywanie wszystkich akcji nie umożliwi Ci ukończenia zadania.

---

## Komunikacja z API

Z API porozumiewasz się w ten sposób:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "windpower",
  "answer": {
    "action": "..."
  }
}
```

### Rozpoczęcie — akcja `help`

Sugerujemy od rozpoczęcia:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "windpower",
  "answer": {
    "action": "help"
  }
}
```

### Uruchomienie okna serwisowego — akcja `start`

Zanim przystąpisz do konfiguracji turbiny wiatrowej, musisz uruchomić okno serwisowe poprzez wydanie polecenia:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "windpower",
  "answer": {
    "action": "start"
  }
}
```

### Wysyłanie konfiguracji — akcja `config`

Przykładowe wysłanie pojedynczej konfiguracji (w godzinie zawsze ustawiaj minuty i sekundy na zera):

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "windpower",
  "answer": {
    "action": "config",
    "startDate": "2238-12-31",
    "startHour": "12:00:00",
    "pitchAngle": 0,
    "turbineMode": "idle",
    "unlockCode": "tutaj-podpis-md5-z-unlockCodeGenerator"
  }
}
```

Możesz także wysłać wiele konfiguracji za jednym razem (inny format danych):

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "windpower",
  "answer": {
    "action": "config",
    "configs": {
      "2026-03-24 20:00:00": {
        "pitchAngle": 45,
        "turbineMode": "production",
        "unlockCode": "tutaj-podpis-1"
      },
      "2026-03-24 18:00:00": {
        "pitchAngle": 90,
        "turbineMode": "idle",
        "unlockCode": "tutaj-podpis-2"
      }
    }
  }
}
```

---

## Co musisz zrobić

1. **Odczytaj prognozę pogody** — znajdź wszystkie momenty, w których wiatr jest bardzo silny i może zniszczyć łopaty wiatraka. Zabezpiecz wtedy turbinę (odpowiednie nachylenie łopat i odpowiedni tryb pracy).
2. **Wyznacz punkt produkcji** — wskaż moment, w którym możliwe jest wygenerowanie brakującej energii, i ustaw tam optymalne nachylenie łopat wirnika oraz poprawny tryb pracy umożliwiający produkcję prądu.
3. **Podpisz konfiguracje cyfrowo** — każda przesłana do API konfiguracja musi być cyfrowo podpisana. Użyj generatora kodów `unlockCodeGenerator` i wygenerowane kody wyślij razem z konfiguracją.
4. **Zapisz konfigurację** — przez akcję `config`.
5. **Wyślij akcję `done`** — sprawdzi ona, czy Twoja konfiguracja jest poprawna.

---

## Dodatkowe uwagi

- Większość funkcji działa **asynchronicznie**. Najpierw dodajesz zadanie do kolejki, potem odbierasz wynik przez akcję `getResult`. Odpowiedzi przychodzą w losowej kolejności.
- Za **wichurę** uznajesz wiatr powyżej wytrzymałości wiatraka.
- Przy wichurze turbina **nie powinna stawiać oporu** i **nie może produkować prądu**.
- Przed finalnym `done` musisz wykonać test turbiny przez akcję `turbinecheck`.
- Każdy punkt konfiguracji musi mieć poprawny `unlockCode` z funkcji `unlockCodeGenerator`.

---

Jeśli konfiguracja będzie poprawna i zmieścisz się w czasie, Centrala odeśle flagę.
