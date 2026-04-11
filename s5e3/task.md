# Zadanie praktyczne

Mamy dostęp do serwera, na którym zgromadzone są logi z archiwum czasu. Znajdują się one w katalogu `/data`. Twoim celem jest namierzenie, którego dnia, w jakim mieście i w jakich współrzędnych musimy się pojawić, aby spotkać się z Rafałem.

Musisz wyszukać datę, kiedy odnaleziono Rafała, i pojawić się w tamtym miejscu **dzień wcześniej**. Serwer, z którym się łączysz, ma dostęp do standardowych narzędzi linuksowych.

- **Nazwa zadania:** `shellaccess`
- **Odpowiedź wysyłasz do:** <https://hub.ag3nts.org/verify>

## Jak wysyłać polecenia

W polu `answer` umieszczasz obiekt JSON z polem `cmd`, w którym wpisujesz komendę powłoki do wykonania.

**Przykład — sprawdzenie, co jest w katalogu domowym:**

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "shellaccess",
  "answer": {
    "cmd": "ls -la"
  }
}
```

**Inny przykład — odczyt konkretnego pliku:**

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "shellaccess",
  "answer": {
    "cmd": "cat /sciezka/do/pliku"
  }
}
```

## Co musisz zrobić

- Eksploruj zawartość serwera komendami powłoki (`ls`, `find`, `cat` itp.)
- Przeglądnij co przygotowaliśmy dla Ciebie w katalogu `/data/`
- Wydobądź z plików informacje: kiedy znaleziono ciało Rafała, w jakim mieście się to wydarzyło oraz jakie są współrzędne tego miejsca
- Wypisz na ekran (komendami powłoki) plik JSON w formacie jak podany niżej
- System sam wykryje, czy dane są prawidłowe i odeśle Ci flagę

## Jak zgłosić odpowiedź?

Zadanie uznajemy za zaliczone, gdy uda Ci się wykonać na serwerze takie polecenie, które zwróci potrzebne dane w formacie JSON, takim jak poniżej. Gdy to się stanie, centrala zwróci Ci flagę.

```json
{
  "date": "2020-01-01",
  "city": "nazwa miasta",
  "longitude": 10.000001,
  "latitude": 12.345678
}
```
