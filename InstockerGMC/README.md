# InstockerGMC

**Denní hlídka nových produktů v Google Merchant Center.** Každé ráno ti přijde e-mail se seznamem produktů, které včera přibyly do feedu – pěkně v tabulce.

<br>

## 🎯 K čemu to je

- ✅ Hned vidíš, že nové produkty **naběhly do Shoppingu** (a nejsou zamítnuté)
- ✅ Upozorní na produkty **bez GTIN** nebo **„mimo skladem"**
- ✅ U každého produktu status pro **PLA / GDN / Free listings**
- ✅ Běží samo – **bez serveru a bez API klíčů**, stačí Google účet

<br>

## ⚙️ Jak to funguje

1. **Projde feed** a vybere produkty s datem vytvoření = *včera* (a doháněj i zameškané dny zpět, viz níže)
2. **Hromadně dobere detaily** (dostupnost, GTIN) přes `custombatch` – jedno volání na 250 produktů místo stovek dotazů za sebou
3. **Pošle HTML e-mail** s tabulkou na zadané adresy (jeden e-mail za každý dokončený den)

> 🔁 **Dohánění zameškaných dnů (catch-up):** skript si drží *poslední úspěšně dokončený den*. Když nějaký běh vypadne, příští běh dožene všechny dlužné dny (strop **7 dní zpět**, viz `MAX_LOOKBACK_DAYS`) a za každý pošle samostatný report. Rozpracovaný den se vždy nejdřív dojede a odešle, teprve pak se začne nový – takže se neztratí ani rozdělaný sken, ani neodeslaný report.

> ⏱️ **Velké feedy:** pro feedy s desítkami tisíc SKU, kde se same-day sken nemusí stihnout v jednom běhu, nastav **častější trigger (např. hodinový)** – běhy na sebe navazují (stav v `PropertiesService`) a den se dojede dřív.

> ⚠️ **Sunset:** běží na **Content API for Shopping**, které Google ukončuje **18. 8. 2026** (nahrazuje ho Merchant API). Verze funguje hned a spolehlivě; před srpnem 2026 ji bude potřeba přemigrovat na Merchant API.

<br>

## 🚀 Nasazení

### A) Google Ads skript *(doporučeno)*

1. Google Ads → **Nástroje → Hromadné akce → Skripty** → **+ Nový skript**
2. Vlož obsah `Code.gs`
3. Nahoře **Advanced APIs** → zaškrtni **Shopping content** → **Uložit**
4. Vyplň `MC_ID` a `EMAIL` (sekce `KONFIG` nahoře v kódu)
5. **Spustit** `main` → odsouhlas oprávnění
6. Nastav **Frekvenci: denně** (např. 6:00–7:00)

> Účet, pod kterým skript běží, musí mít přístup k danému Merchant Centru.

> ⏳ **Nelekni se, když první běh chvíli trvá.** U velkých feedů (tisíce SKU) může skenování zabrat **i několik minut** – je to normální, nech ho doběhnout. Logy se v Ads skriptech navíc často ukážou **až na konci** běhu, takže „nic se neděje" ≠ chyba.

### B) Standalone Apps Script

1. [script.google.com](https://script.google.com) → **Nový projekt** → vlož `Code.gs`
2. Vlevo **Služby (+)** → přidej **Shopping Content API** (`ShoppingContent`, v2.1)
3. Vyplň `MC_ID` + `EMAIL` → spusť `main` → odsouhlas oprávnění → nastav denní trigger

<br>

## 🔧 Konfigurace

Nahoře v `Code.gs`, sekce `KONFIG`:

```javascript
var MC_ID = '';   // ID tvého Merchant Center účtu (číslo)
var EMAIL = '';   // příjemce reportu; víc adres oddělíš čárkou
```

| Konstanta | Výchozí | Popis |
|---|---|---|
| `MC_ID` | – | **povinné** – ID Merchant Center účtu |
| `EMAIL` | – | **povinné** – příjemci reportu (CSV) |
| `SUBJECT_PREFIX` | `Nové produkty GMC` | předmět e-mailu (doplní se účet, datum a počet) |
| `TZ` | `Europe/Prague` | časové pásmo pro určení dne přidání produktu i formát dat (pozor na off-by-one u půlnoci) |
| `MAX_RUN_MINUTES` | `25` | časový limit jednoho běhu |
| `MAX_LOOKBACK_DAYS` | `7` | jak daleko zpět dohánět zameškané dny po výpadku |
| `MAX_EMAIL_ROWS` | `300` | strop řádků v tabulce (zbytek se shrne jako „…a dalších N") – chrání před Gmail clippingem |
| `PAGE_SIZE` | `250` | produktů na stránku (Content API max 250) |
| `MAX_BUFFER_BYTES` | `450000` | strop bufferu; po překročení se den uzavře dříve (s poznámkou v e-mailu) |
| `BUFFER_CHUNK_BYTES` | `8000` | velikost chunku bufferu (per-value limit PropertiesService je ~9 KB) |
| `MAX_RETRIES` | `4` | počet pokusů při tranzientní chybě (timeout/5xx/429) – exponenciální backoff s jitterem |
| `SHOW_LOGO` | `true` | zobrazit logo v patičce (externí obrázek z rujzl.cz – při `true` může prozradit otevření e-mailu) |
| `SEND_EMPTY_REPORT` | `true` | poslat info e-mail i ve dnech bez nových produktů |
| `MC_LINK_CHANNEL` | `0` | kanál v odkazu na detail v MC (0 = online, 1 = local) |
| `BRANDING` | `RUJZL.cz` | text značky v patičce |

<br>

## 📧 Výstup

E-mail s tabulkou nových produktů:

| ID | Produkt | Dostupnost | PLA | GDN | Free | GTIN | Přidáno |
|---|---|---|---|---|---|---|---|
| ABC123 | Název produktu | in stock | approved | approved | approved | 1234567890 | 24. 6. 2026 |

- **ID** → odkaz přímo na detail produktu v Merchant Center
- **PLA / GDN / Free** → zelená (`#ACDF87`) = `approved`, jantarová (`#FFE08A`) = `partial`/`pending`, červená (`#ffb3b3`) = `disapproved`; stav je vždy i jako text v buňce
- **GTIN** → červené `NONE`, pokud chybí; `detail nenačten`, pokud se detail produktu nepodařilo dobrat
- **Předmět** obsahuje název účtu, datum a počet nových produktů
- Tabulka je oříznutá na `MAX_EMAIL_ROWS` (300) řádků; zbytek se shrne jako „…a dalších N produktů" (ochrana před Gmail clippingem)

<br>

## 📝 Poznámky

- **Rychlost:** detaily produktů se doberou dávkově (`custombatch`), takže i den s hodně novými produkty je rychlý. Samotné procházení feedu je ale úměrné jeho velikosti – u velmi velkých feedů (desítky tisíc SKU) může sken trvat minuty.
- **Robustnost:** API volání (list i `custombatch`) se při timeoutu / 5xx / 429 opakují až 4× s exponenciálním backoffem a jitterem. Když se detail produktu nenačte, GTIN se **neoznačí falešně jako `NONE`** – v tabulce je `—` (detail nedostupný).
- **Stavy destinací:** `approved` / `partial` (část zemí schválena, část ne) / `disapproved` / `pending` (čerstvý produkt bez statusů). Barevně: zelená = approved, jantarová = partial/pending, červená = disapproved; přesný stav je vždy i textem v buňce.
- **Souběžné běhy:** ve standalone Apps Scriptu chrání stav `LockService` (feature-detect). Google Ads skripty `LockService` nemají → skript ho slušně přeskočí.
- **Limit běhu:** Google Ads skripty mají strop ~30 min. Skript má vlastní pojistku na 25 min – při dosažení uloží stav (`PropertiesService`, buffer chunkovaně) a další běh naváže tam, kde skončil (i přes více dnů). Pro extrémně velké feedy (desítky tisíc SKU) je vhodný **hodinový trigger** nebo serverové řešení bez limitu.
- **Chybový e-mail:** když běh spadne, přijde na `EMAIL` failure e-mail se stručným popisem chyby – report se v takovém případě netváří jako úspěšný.
- **Soukromí:** skript jen **čte** Merchant Center a posílá report na tvůj `EMAIL`. Pozor: e-mail ve výchozím stavu obsahuje **externí logo z rujzl.cz**, jehož načtení v poštovním klientovi může prozradit otevření e-mailu. Logo lze vypnout konstantou `SHOW_LOGO = false` (patička pak bude jen text).
