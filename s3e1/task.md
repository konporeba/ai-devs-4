# Zadanie: Wykrywanie Anomalii w Odczytach Sensorów

## Opis

Twoim zadaniem jest znalezienie anomalii w odczytach sensorów.

Czujniki w naszej elektrowni potrafią mierzyć różne wartości. Czasami są to odczyty temperatury, ciśnienia, napięcia i kilka innych. Czujniki bywają jedno- albo wielozadaniowe. Wszystkie jednak zwracają dane w dokładnie takim samym formacie, co oznacza, że jeśli sprawdzasz dane z czujnika temperatury, to znajdziesz tam poza temperaturą także np. zapis napięcia, ale będzie on równy zero, ponieważ nie jest to wartość, którą ten czujnik powinien zwracać. Przy czujnikach zintegrowanych (2–3 zadaniowe), sensor może zwracać wszystkie pola definiowane przez sensory składowe.

Każdy odczyt czujnika jest też skomentowany przez operatora — czasami jednym słowem, a czasami jakąś dłuższą wypowiedzią. Niestety nie zawsze te notatki są poprawnie wpisywane. Pojawia się niekiedy błąd ludzki, a czasami to nierzetelność operatora.

Musisz zgłosić nam wszelkie anomalie. Prześlij nam identyfikatory plików, które zawierają przekłamane dane z czujników lub niepoprawną notatkę operatora.

**Nazwa zadania:** `evaluation`

---

## Odpowiedź

Odpowiedź wysyłasz do Centrali do `/verify` w formacie jak poniżej:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "evaluation",
  "answer": {
    "recheck": ["0001", "0002", "0003", "..."]
  }
}
```

Dane z sensorów pobierzesz tutaj: [https://hub.ag3nts.org/dane/sensors.zip](https://hub.ag3nts.org/dane/sensors.zip)

Dane wysyłasz do centrali jako tablicę JSON zawierającą identyfikatory.

### Akceptowane formaty danych

- Stringi z identyfikatorem liczbowym — `["0001", "0002", "4321"]`
- Liczby bez zera wiodącego — `[1, 2, 987]`
- Nazwy plików z błędami (pełne z zerami) — `["0001.json", "0002.json", "4321.json"]`
- Dane mieszane — `["0001.json", 2, "4321"]`

---

## Format danych sensora

Każdy czujnik zwraca dane w poniższym formacie:

```json
{
  "sensor_type": "temperature/voltage",
  "timestamp": 1774064280,
  "temperature_K": 612,
  "pressure_bar": 0,
  "water_level_meters": 0,
  "voltage_supply_v": 230.4,
  "humidity_percent": 0,
  "operator_notes": "Readings look stable and within expected range."
}
```

### Opis pól

| Pole                 | Opis                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sensor_type`        | Nazwa aktywnego sensora lub zestawu sensorów rozdzielonych znakiem `/`, np. `temperature`, `water`, `voltage/temperature` |
| `timestamp`          | Unixowy znacznik czasu                                                                                                    |
| `temperature_K`      | Odczyt temperatury w Kelwinach                                                                                            |
| `pressure_bar`       | Odczyt ciśnienia w barach                                                                                                 |
| `water_level_meters` | Odczyt poziomu wody w metrach                                                                                             |
| `voltage_supply_v`   | Odczyt napięcia zasilania w V                                                                                             |
| `humidity_percent`   | Odczyt wilgotności w procentach                                                                                           |
| `operator_notes`     | Notatka operatora po angielsku                                                                                            |

> W każdym pliku obecne są wszystkie pola pomiarowe. Dla sensorów nieaktywnych wartość powinna być ustawiona na `0`.

---

## Zakres poprawnych wartości

| Sensor      | Pole                 | Min     | Max     |
| ----------- | -------------------- | ------- | ------- |
| Temperatura | `temperature_K`      | 553 K   | 873 K   |
| Ciśnienie   | `pressure_bar`       | 60 bar  | 160 bar |
| Poziom wody | `water_level_meters` | 5.0 m   | 15.0 m  |
| Napięcie    | `voltage_supply_v`   | 229.0 V | 231.0 V |
| Wilgotność  | `humidity_percent`   | 40.0 %  | 80.0 %  |

---

## Definicja anomalii

Zadanie zostaje zaliczone, gdy prześlesz w jednym zapytaniu identyfikatory wszystkich plików zawierających anomalie. Jako anomalie definiujemy:

- Dane pomiarowe nie mieszczą się w normach
- Operator twierdzi, że wszystko jest OK, ale dane są niepoprawne
- Operator twierdzi, że znalazł błędy, ale dane są OK
- Czujnik zwraca dane, których nie powinien zwracać (np. czujnik poziomu wody zwraca napięcie prądu)

---

## Wskazówki

> Tam jest **10 000 plików JSON** do analizy. Próba wrzucenia tego do LLM-a będzie DROGA. W tych danych mnóstwo informacji się powtarza.

**Podpowiedź (spoiler w Base64):**

```
RHdpZSBwb2Rwb3dpZWR6aToKMSkgTExNLXkgbWFqxIUgc3fDs2ogY2FjaGUsIGFsZSBUeSB0YWvFvGUg
bW/FvGVzeiBjYWNob3dhxIcgb2Rwb3dpZWR6aSBtb2RlbHUgcG8gc3dvamVqIHN0cm9uaWUuIEN6eSBu
aWVrdMOzcmUgZGFuZSBuaWUgc8SFIHpkdXBsaWtvd2FuZT8KMikgQ3p5IHByemVwcm93YWR6ZW5pZSBr
bGFzeWZpa2Fjamkgd3N6eXN0a2ljaCBkYW55Y2ggcHJ6ZXogbW9kZWwgasSZenlrb3d5IGLEmWR6aWUg
b3B0eW1hbG5lIGtvc3p0b3dvPyBCecSHIG1vxbxlIGN6xJnFm8SHIGRhbnljaCBkYSBzacSZIG9kcnp1
Y2nEhyBwcm9ncmFtaXN0eWN6bmllPw==
```

**Przemyślenia optymalizacyjne:**

1. Zastanów się, którą część zadania powinien wykonać model językowy, aby nie przepalać zbytecznie tokenów i jak możesz taką weryfikację zoptymalizować pod względem kosztów. Które rodzaje anomalii powinny być wykrywane przez model językowy, a które przez programistyczne podejście?

2. Kiedy dojdziesz do anomalii, które wymagają analizy przez LLM: czy musisz wysyłać do analizy każdy plik osobno? Przypomnij sobie też cenniki modeli — płaci się więcej za output niż za input. W jaki sposób możesz zminimalizować to, co zwraca model, mimo że wysyłasz do niego dużo danych?

3. Przyjrzyj się plikom z danymi — technicy czasem są leniwi, i niektóre notatki są bardzo podobne do siebie. Możesz wykorzystać to do zoptymalizowania kosztów.
