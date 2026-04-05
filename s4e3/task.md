# Zadanie praktyczne — Domatowo

Twoim zadaniem jest odnalezienie partyzanta ukrywającego się w ruinach Domatowa i przeprowadzenie sprawnej akcji ewakuacyjnej. Do dyspozycji masz transportery oraz żołnierzy zwiadowczych. Musisz tak rozegrać tę operację, aby odnaleźć człowieka, którego szukamy, nie wyczerpać punktów akcji i zdążyć wezwać helikopter zanim sytuacja wymknie się spod kontroli.

Po mieście możesz poruszać się zarówno transporterami, jak i pieszo. Transportery potrafią jeździć tylko po ulicach. Zanim wyślesz kogokolwiek w teren, przeanalizuj bardzo dokładnie układ terenu. Gdy tylko któryś ze zwiadowców znajdzie człowieka, wezwij śmigłowiec ratunkowy tak szybko, jak to tylko możliwe.

- **Nazwa zadania:** `domatowo`
- **Endpoint:** `https://hub.ag3nts.org/verify`
- **Podgląd mapy:** [https://hub.ag3nts.org/domatowo_preview](https://hub.ag3nts.org/domatowo_preview)

---

## Przechwycony sygnał dźwiękowy

> „Przeżyłem. Bomby zniszczyły miasto. Żołnierze tu byli, szukali surowców, zabrali ropę. Teraz jest pusto. Mam broń, jestem ranny. Ukryłem się w jednym z najwyższych bloków. Nie mam jedzenia. Pomocy."

---

## Komunikacja z API

Z API komunikujesz się zawsze przez `https://hub.ag3nts.org/verify` i wysyłasz JSON z polami `apikey`, `task` oraz `answer`.

### Podstawowy format

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "domatowo",
  "answer": {
    "action": "..."
  }
}
```

### Pobranie opisu dostępnych akcji

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "domatowo",
  "answer": {
    "action": "help"
  }
}
```

---

## Zasoby do dyspozycji

| Zasób        | Limit                           |
| ------------ | ------------------------------- |
| Transportery | maks. 4                         |
| Zwiadowcy    | maks. 8                         |
| Punkty akcji | 300 na całą operację            |
| Mapa         | 11×11 pól z oznaczeniami terenu |

---

## Koszty akcji

| Akcja                                | Koszt                                                  |
| ------------------------------------ | ------------------------------------------------------ |
| Utworzenie zwiadowcy                 | 5 pkt                                                  |
| Utworzenie transportera              | 5 pkt (baza) + 5 pkt za każdego przewożonego zwiadowcę |
| Ruch zwiadowcy                       | 7 pkt za każde pole                                    |
| Ruch transportera                    | 1 pkt za każde pole                                    |
| Inspekcja pola                       | 1 pkt                                                  |
| Wysadzenie zwiadowców z transportera | 0 pkt                                                  |

---

## Rozpoznanie terenu

Pobierz całą mapę:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "domatowo",
  "answer": {
    "action": "getMap"
  }
}
```

Możesz także wyświetlić podgląd mapy uwzględniający tylko konkretne jej elementy, podając je w opcjonalnej tablicy `symbols`.

---

## Tworzenie jednostek

### Transporter z załogą zwiadowców

Przykład z 2-osobową załogą:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "domatowo",
  "answer": {
    "action": "create",
    "type": "transporter",
    "passengers": 2
  }
}
```

### Pojedynczy zwiadowca

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "domatowo",
  "answer": {
    "action": "create",
    "type": "scout"
  }
}
```

---

## Ewakuacja

Helikopter można wezwać dopiero wtedy, gdy któryś zwiadowca odnajdzie człowieka. Finalne zgłoszenie:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "domatowo",
  "answer": {
    "action": "callHelicopter",
    "destination": "F6"
  }
}
```

W polu `destination` podajesz współrzędne miejsca, na którym zwiadowca potwierdził obecność człowieka.

---

## Co musisz zrobić

1. Rozpoznaj mapę miasta i zaplanuj trasę tak, by nie przepalić punktów akcji.
2. Utwórz odpowiednie jednostki i rozlokuj je na planszy.
3. Wykorzystaj transportery do szybkiego dotarcia w kluczowe miejsca.
4. Wysadzaj zwiadowców tam, gdzie dalsze sprawdzanie terenu wymaga działania pieszo.
5. Przeszukuj kolejne pola akcją `inspect` i analizuj wyniki przez `getLogs`.
6. Gdy odnajdziesz partyzanta, wezwij helikopter akcją `callHelicopter`.

Jeśli poprawnie odnajdziesz ukrywającego się człowieka i zakończysz ewakuację, Centrala odeśle flagę.
