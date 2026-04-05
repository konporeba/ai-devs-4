# Zadanie: Negotiations

## Opis

Twoim celem jest przygotowanie jednego lub dwóch narzędzi, które nasz automat wykorzysta do namierzenia miast oferujących wszystkie potrzebne mu przedmioty. Wtedy będzie mógł podjąć negocjacje cen ze znalezionymi miastami.

Automat sam wie najlepiej, co jest nam potrzebne do uruchomienia turbiny wiatrowej, aby zapewnić nam dodatkowe źródło zasilania.

Agent podaje parametry do Twoich narzędzi w języku naturalnym. Pamiętaj też, że musisz tak opisać te narzędzia, aby automat wiedział, jakie parametry i do którego narzędzia powinien przekazać.

Celem naszego agenta jest uzyskanie informacji, gdzie może kupić (nazwy miast) wszystkie potrzebne mu przedmioty. Potrzebne nam są miasta, które oferują **wszystkie** potrzebne przedmioty jednocześnie. Nasz agent musi pozyskać te informacje, korzystając z Twoich narzędzi.

**Pliki z bazą wiedzy agenta:** [https://hub.ag3nts.org/dane/s03e04_csv/](https://hub.ag3nts.org/dane/s03e04_csv/)

W razie problemów użyj narzędzia do debugowania, aby dokładnie wiedzieć, co dzieje się w backendzie.

**Nazwa zadania:** `negotiations`

---

## Odpowiedź

Swoją odpowiedź jak zawsze wysyłasz do `/verify`:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "negotiations",
  "answer": {
    "tools": [
      {
        "URL": "https://twoja-domena.pl/api/narzedzie1",
        "description": "Opis pierwszego narzędzia - co robi i jakie parametry przyjmuje w polu params"
      },
      {
        "URL": "https://twoja-domena.pl/api/narzedzie2",
        "description": "Opis drugiego narzędzia - co robi i jakie parametry przyjmuje w polu params"
      }
    ]
  }
}
```

---

## Format komunikacji z narzędziami

Agent wysyła zapytania `POST` do Twojego URL w formacie:

```json
{
  "params": "wartość przekazana przez agenta"
}
```

Oczekiwany format odpowiedzi:

```json
{
  "output": "odpowiedź dla agenta"
}
```

---

## Ważne ograniczenia

- Odpowiedź narzędzia nie może przekraczać **500 bajtów** i nie może być krótsza niż **4 bajty**.
- Agent ma do dyspozycji maksymalnie **10 kroków**, aby dojść do odpowiedzi.
- Agent będzie starał się namierzyć miasta dla **3 przedmiotów**.
- Możesz zarejestrować najwyżej **2 narzędzia** (ale równie dobrze możesz ogarnąć wszystko jednym).
- Jeśli agent nie otrzymał żadnej odpowiedzi od narzędzia, przerywa pracę.

---

## Jak udostępnić swoje API?

Zrób to podobnie jak w zadaniu S01E03. Możesz postawić endpointy na dowolnym publicznie dostępnym serwerze albo wykorzystać rozwiązania takie jak np. [ngrok](https://ngrok.com).

---

## Weryfikacja

Weryfikacja jest **asynchroniczna** — po wysłaniu narzędzi musisz poczekać kilka sekund, a następnie odpytać o wynik. Zrobisz to, wysyłając na ten sam adres `/verify` zapytanie z polem `"action"` ustawionym na `"check"`:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "negotiations",
  "answer": {
    "action": "check"
  }
}
```

Możesz też sprawdzić wynik na panelu do debugowania w Centrali: [https://hub.ag3nts.org/debug](https://hub.ag3nts.org/debug)

---

## Krok po kroku

1. Pobierz pliki z wiedzą z lokalizacji [https://hub.ag3nts.org/dane/s03e04_csv/](https://hub.ag3nts.org/dane/s03e04_csv/).
2. Zastanów się, ile i jakich narzędzi potrzebujesz do przeszukiwania informacji o tym, jakie miasto oferuje na sprzedaż konkretny przedmiot.
3. Przygotuj 1–2 narzędzia umożliwiające sprawdzenie, które miasto posiada poszukiwane przedmioty. Bądź gotowy, że agent wyśle zapytanie np. jako naturalne zapytanie: _„potrzebuję kabla długości 10 metrów"_ zamiast _„kabel 10m"_.
4. Zgłoś adresy URL do centrali w ramach zadania i dobrze je opisz, aby agent wiedział, kiedy ma ich używać i jakie dane ma im przekazać.
5. Agent będzie używał Twoich narzędzi tak długo, aż zgromadzi wszystkie informacje niezbędne do stwierdzenia, które miasta posiadają jednocześnie wszystkie potrzebne mu przedmioty.
6. Agent sam zgłosi do centrali, które miasta znalazł — jeśli będą poprawne, otrzymasz flagę.
7. Odbierz flagę za pomocą funkcji `check` opisanej wyżej lub odczytaj ją przez narzędzie do debugowania. Pamiętaj, że agent potrzebuje trochę czasu (minimum **30–60 sekund**), aby przygotować odpowiedź.
