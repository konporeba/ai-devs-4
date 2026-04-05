# Zadanie praktyczne: SaveThem

## Opis

Twoim zadaniem jest zbudowanie agenta, który wytyczy optymalną trasę dla naszego posłańca, który podejmie negocjacje w mieście **Skolwin**. Niewiele wiemy na temat tego, jak wygląda teren, więc z pewnością na początku będziemy musieli zdobyć mapę.

Musimy też zdecydować się na konkretny pojazd, którym wyruszymy z bazy — jest ich do wyboru kilka. Każdy pojazd spala paliwo: im szybciej się porusza, tym więcej paliwa zużywa. Jednocześnie nasz wysłannik potrzebuje prowiantu — im dłużej trwa podróż, tym więcej będzie wymagał jedzenia. Trzeba więc odpowiednio rozplanować drogę tak, by poruszać się możliwie szybko, ale jednocześnie aby wystarczyło jedzenia i paliwa na dotarcie do celu.

**Podgląd trasy:** [https://hub.ag3nts.org/savethem_preview.html](https://hub.ag3nts.org/savethem_preview.html)

**Nazwa zadania:** `savethem`

---

## Wyszukiwarka narzędzi

Tym razem nie masz dostępu do konkretnych narzędzi — jedynie do wyszukiwarki, która pomoże Ci zdobyć informacje o pozostałych narzędziach.

> **Uwaga:** Wszystkie narzędzia porozumiewają się tylko w **języku angielskim**!

**Endpoint:** `https://hub.ag3nts.org/api/toolsearch`

```json
{
  "apikey": "tutaj-twoj-klucz",
  "query": "I need notes about movement rules and terrain"
}
```

Wszystkie znalezione narzędzia obsługuje się identycznie jak `toolsearch` — wysyłasz do nich parametr `query` oraz własny `apikey`.

---

## Odpowiedź

Dane wysyłasz do `/verify`:

```json
{
  "apikey": "tutaj-twoj-klucz",
  "task": "savethem",
  "answer": ["vehicle_name", "right", "right", "up", "down", "up", "..."]
}
```

---

## Wskazówki

### Co wiemy?

- Wysłannik musi dotrzeć do miasta **Skolwin**.
- Pozyskane mapy zawsze mają wymiary **10×10 pól** i zawierają rzeki, drzewa, kamienie itp.
- Masz do dyspozycji **10 porcji jedzenia** i **10 jednostek paliwa**.
- Każdy ruch spala paliwo (chyba że idziesz pieszo) oraz jedzenie. Każdy pojazd ma własne parametry spalania zasobów.
- Im szybciej się poruszasz, tym więcej spalasz paliwa — im wolniej idziesz, tym więcej konsumujesz prowiantu. Trzeba to dobrze rozplanować.
- W każdej chwili możesz wyjść z wybranego pojazdu i kontynuować podróż pieszo.
- Narzędzie `toolsearch` może przyjąć zarówno zapytanie w języku naturalnym, jak i słowa kluczowe.
- Wszystkie narzędzia zwracane przez `toolsearch` przyjmują parametr `"query"` i odpowiadają w formacie JSON, zwracając zawsze **3 najlepiej dopasowane** do zapytania wyniki (nie zwracają wszystkich wpisów!).
- Jeśli dotrzesz do pola końcowego, zdobędziesz flagę i zaliczysz zadanie — flaga pojawi się zarówno na podglądzie, w API, jak i w debugu do zadań.
