# Toolbox — pravidla pro Claude

**VEŘEJNÝ** repo — sbírka sdílených nástrojů RUJZL.cz (Google Ads / Apps Scripty). Vše je vidět navenek.

## Specifika

- **Žádné secrets, žádné reálné hodnoty** — konfigurace (MC ID, e-maily, ID účtů) vždy jako prázdné placeholdery s komentářem, nikdy živá data. Před přidáním/úpravou nástroje grepni, že nezůstaly reálné ID/e-maily.
- **`.clasp.json` se NEcommituje** (je v `.gitignore`) — váže se na konkrétní Apps Script projekt autora.
- **Každý nástroj ve vlastní složce** (PascalCase) s vlastním `README.md` (nasazení, konfigurace, výstup). Po přidání nástroje doplň odkaz do kořenového `README.md`.
- **Kódovací styl** (skript musí běžet v Google Ads skriptu i standalone Apps Scriptu):
  - čistý **ES5** — `var`, function deklarace; žádné `let`/`const`/arrow/template-literals.
  - **camelCase** funkce/proměnné; konstanty nahoře v sekci `KONFIG`.
  - **firemní barvy** v HTML e-mailech (`#23065A` tmavě fialová, `#FFFFFD` krémová, `#E0F8BA` světle zelená) + patička `<Nástroj> vX | RUJZL.cz`.
  - Google Ads skripty **nemají** `LockService` ani programatické triggery → používej je jen přes feature-detect.
  - žádné nové API/scope navíc (žádný `SpreadsheetApp`/`DriveApp`…), pokud to není nezbytné a zdokumentované.
- Licence: **MIT**.
