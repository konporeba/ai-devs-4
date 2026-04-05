# Zadanie: Reactor

## Opis

Twoim zadaniem jest doprowadzenie robota transportującego urządzenie chłodzące w pobliże reaktora.

Do sterowania robotem służy specjalnie przygotowane API, które przyjmuje polecenia: `start`, `reset`, `left`, `wait` oraz `right`. Możesz wysłać tylko jedno polecenie jednocześnie.

Zadanie uznajemy za zaliczone, jeśli robot przejdzie przez całą mapę, nie będąc przy tym zgniecionym przez elementy reaktora. Bloczki reaktora poruszają się w górę i w dół, a status ich aktualnego kierunku, podobnie jak ich pozycja, są zwracane przez API.

Napisz aplikację, która na podstawie aktualnej sytuacji na planszy będzie decydowała, jakie kroki powinien podjąć robot.

**Graficzny podgląd sytuacji w reaktorze:** [https://hub.ag3nts.org/reactor_preview.html](https://hub.ag3nts.org/reactor_preview.html)

**Nazwa zadania:** `reactor`

---

## Komendy

Komendy dla robota wysyłasz do `/verify`:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "reactor",
  "answer": {
    "command": "start"
  }
}
```

---

## Mechanika zadania

- Plansza ma wymiary **7 na 5 pól**.
- Robot porusza się zawsze po najniższej kondygnacji — pozycja startowa to **kolumna 1, wiersz 5**.
- Miejsce instalacji modułu chłodzenia (punkt docelowy) to **kolumna 7, wiersz 5**.
- Każdy blok reaktora zajmuje dokładnie **2 pola** i porusza się cyklicznie góra/dół. Gdy dojdzie do pozycji skrajnie wysokiej, zaczyna wracać na dół, a gdy osiągnie pozycję najniższą — wraca do góry.
- Bloki poruszają się **tylko wtedy, gdy wydajesz polecenia**. Odczekanie np. 10 sekund nie zmieni niczego na planszy. Jeśli chcesz, aby stan planszy zmienił się bez poruszania robotem, wyślij komendę `wait`.

---

## Oznaczenia na mapie

| Symbol | Znaczenie                     |
| ------ | ----------------------------- |
| `P`    | Pozycja startowa robota       |
| `G`    | Cel — miejsce docelowe robota |
| `B`    | Bloki reaktora                |
| `.`    | Puste pole                    |

---

## Implementacja algorytmu

1. Na początku zawsze wysyłasz polecenie `start`.
2. Rozglądasz się, jak wygląda plansza, i podejmujesz decyzję, czy możesz wykonać krok do przodu.
3. Jeśli nie możesz wykonać kroku lub jest to zbyt niebezpieczne (np. zbliża się bloczek) — czekasz (`wait`).
4. Jeśli czekanie nie wchodzi w grę (bo w kolumnie, w której stoisz, też zbliża się bloczek) — uciekasz w lewo (`left`).
5. Wykonujesz odpowiednie kroki, za każdym razem podglądając mapę, tak długo, aż osiągniesz punkt docelowy.
