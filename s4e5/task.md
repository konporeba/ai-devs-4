# Zadanie praktyczne

Musisz uporządkować pracę magazynu żywności i narzędzi tak, aby przygotować zamówienia, które zaspokoją potrzeby wszystkich wskazanych miast. Do dyspozycji dostajesz gotowe API magazynu, generator podpisów bezpieczeństwa oraz dostęp tylko do odczytu do bazy danych, z której trzeba wyciągnąć dane potrzebne do autoryzacji zamówienia.

To zadanie nie polega na zgadywaniu. Najpierw poznaj strukturę danych, później ustal pełne zapotrzebowanie miast, a na końcu zbuduj jedno zamówienie, którego zawartość będzie zgodna z wymaganiami Centrali.

- **Nazwa zadania:** `foodwarehouse`
- **Odpowiedź wysyłasz do:** `https://hub.ag3nts.org/verify`
- **Plik z zapotrzebowaniem miast:** `https://hub.ag3nts.org/dane/food4cities.json`

---

## Baza danych SQLite

W tym zadaniu rozmawiasz także z bazą danych SQLite. Dostęp do niej jest wyłącznie w trybie odczytu.

Na początek najlepiej pobrać pomoc API:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "foodwarehouse",
  "answer": {
    "tool": "help"
  }
}
```

---

## Jak działa API

Każde wywołanie wysyłasz do `/verify` w polu `answer` jako obiekt z polem `tool`.

Najważniejsze narzędzia:

| Narzędzie            | Opis                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `orders`             | Odczyt, tworzenie, uzupełnianie i usuwanie zamówień                    |
| `signatureGenerator` | Generowanie podpisu SHA1 na podstawie danych użytkownika z bazy SQLite |
| `database`           | Odczyt danych i schematów z bazy SQLite                                |
| `reset`              | Przywrócenie początkowego stanu zamówień                               |
| `done`               | Końcowa weryfikacja rozwiązania                                        |

---

## Reset

Jeśli po drodze namieszasz w stanie zadania, użyj `reset`:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "foodwarehouse",
  "answer": {
    "tool": "reset"
  }
}
```

---

## Praca z zamówieniami

### Pobranie listy zamówień

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "foodwarehouse",
  "answer": {
    "tool": "orders",
    "action": "get"
  }
}
```

### Tworzenie nowego zamówienia

Nowe zamówienie tworzysz dopiero wtedy, gdy znasz już tytuł, `creatorID`, kod `destination` oraz poprawny podpis:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "foodwarehouse",
  "answer": {
    "tool": "orders",
    "action": "create",
    "title": "Dostawa dla Torunia",
    "creatorID": 2,
    "destination": "1234",
    "signature": "tutaj-podpis-sha1"
  }
}
```

### Dopisywanie towarów — pojedynczo

Po utworzeniu zamówienia możesz dopisywać towary pojedynczo:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "foodwarehouse",
  "answer": {
    "tool": "orders",
    "action": "append",
    "id": "tutaj-id-zamowienia",
    "name": "woda",
    "items": 120
  }
}
```

### Dopisywanie towarów — batch mode

Możesz też użyć batch mode i dopisać wiele pozycji naraz. To ważne, bo `orders.append` przyjmuje również obiekt z wieloma towarami:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "foodwarehouse",
  "answer": {
    "tool": "orders",
    "action": "append",
    "id": "tutaj-id-zamowienia",
    "items": {
      "chleb": 45,
      "woda": 120,
      "mlotek": 6
    }
  }
}
```

> **Uwaga:** Jeżeli dopiszesz do zamówienia towar, który już w nim istnieje, system zwiększy jego ilość zamiast tworzyć duplikat.

---

## Odczyt bazy SQLite

### Wyświetlenie tabel

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "foodwarehouse",
  "answer": {
    "tool": "database",
    "query": "show tables"
  }
}
```

### Zapytania SELECT

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "foodwarehouse",
  "answer": {
    "tool": "database",
    "query": "select * from tabela"
  }
}
```

---

## Co musisz zrobić

1. Ustal, które miasta biorą udział w operacji na podstawie pliku `food4cities.json`
2. Znajdź odpowiednie wartości dla pola `destination` dla tych miast
3. Odczytaj z `food4cities.json`, jakie towary i ilości są potrzebne w każdym z tych miast
4. Przygotuj osobne zamówienie dla każdego wymaganego miasta
5. Każde zamówienie utwórz z poprawnym `creatorID`, `destination` i podpisem wygenerowanym na podstawie danych z bazy SQLite
6. Uzupełnij zamówienia dokładnie tymi towarami, których potrzebują miasta — bez braków i bez nadmiarów
7. Gdy wszystko będzie gotowe, wywołaj narzędzie `done`

---

## Dodatkowe uwagi

- Musisz utworzyć tyle zamówień, ile mamy miast w pliku JSON
- Jeśli coś zepsujesz po drodze, użyj `reset`, żeby wrócić do stanu początkowego
- Każde zamówienie musi mieć poprawny `creatorID` oraz `signature`

---

## Finalne sprawdzenie

Gdy uznasz, że wszystkie wymagane zamówienia są gotowe, wyślij finalne sprawdzenie:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "foodwarehouse",
  "answer": {
    "tool": "done"
  }
}
```

Jeśli komplet zamówień będzie zgodny z potrzebami miast, trafi pod właściwe kody docelowe i zachowa poprawne podpisy, Centrala odeśle flagę.
