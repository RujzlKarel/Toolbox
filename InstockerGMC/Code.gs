/**
 * InstockerGMC — denní hlídka nových produktů v Google Merchant Center.
 *
 * Projde feed, vybere produkty přidané v daný den (creationDate), dobere detaily
 * (dostupnost, GTIN) a pošle přehledný HTML e-mail. Běží v Google Ads skriptu
 * i ve standalone Apps Scriptu — bez serveru a bez API klíčů.
 *
 * Nasazení a konfigurace: viz README.md ve stejné složce.
 * RUJZL.cz · MIT · https://github.com/RujzlKarel/Toolbox
 */

/***** KONFIG *****/
var VERSION = '2.0.0';   // Content API (ShoppingContent v2.1) + custombatch na detaily. POZOR: Content API sunset 18. 8. 2026.

// --- Vyplň před prvním spuštěním ---
var MC_ID   = '';                  // ID tvého Merchant Center účtu (číslo)
var EMAIL   = '';                  // příjemce reportu; více adres oddělíš čárkou: 'a@firma.cz,b@firma.cz'
var SUBJECT_PREFIX = 'Nové produkty GMC';
// -----------------------------------

// Časové pásmo pro určení "dne přidání" produktu (creationDate -> yyyy-MM-dd) i pro
// formátování dat v e-mailu. POZOR na off-by-one: produkt vytvořený těsně před půlnocí
// v UTC může spadnout do jiného kalendářního dne, než ve kterém ho vidíš v MC UI.
// Hodnotu drž shodnou s časovým pásmem, ve kterém uvažuješ o "včerejšku".
var TZ              = 'Europe/Prague';

var MAX_RUN_MINUTES = 25;          // vlastní pojistka (Ads skripty mají strop ~30 min)
var PAGE_SIZE       = 250;         // Content API max 250 na stránku
var BATCH_SIZE      = 250;         // custombatch: kolik detailů dobrat v jednom volání
var MAX_RETRIES     = 4;           // retry na tranzientní chyby – velké feedy jinak timeoutují
var MAX_LOOKBACK_DAYS = 7;         // jak daleko zpět dohánět zameškané dny (po výpadku běhů)
var MAX_EMAIL_ROWS  = 300;         // strop řádků v tabulce e-mailu (Gmail clipping); zbytek se shrne

// Buffer se ukládá chunkovaně do PropertiesService. Per-value limit je ~9 KB,
// proto chunk drž bezpečně pod ním. Celkový store má limit ~500 KB.
var BUFFER_CHUNK_BYTES = 8000;
var MAX_BUFFER_BYTES   = 450000;   // strop velikosti bufferu; po překročení se den uzavře dříve (s poznámkou)

// Branding (default RUJZL.cz). Logo v patičce e-mailu je externí obrázek z rujzl.cz –
// jeho načtení v klientovi může prozradit otevření e-mailu (tracking). Vypni přes SHOW_LOGO.
var BRANDING        = 'RUJZL.cz';
var LOGO_URL        = 'https://www.rujzl.cz/assets/logo/Rujzl_logopodklady_RGB-01_logo_black.png';
var SHOW_LOGO       = true;        // false = patička jen text, bez externího obrázku (žádný tracking pixel)

var MC_LINK_CHANNEL = '0';         // kanál v odkazu na detail v MC (0 = online, 1 = local)
var SEND_EMPTY_REPORT = true;      // poslat e-mail i ve dnech bez nových produktů

// --- Klíče stavu v PropertiesService (nesahat) ---
var TARGET_KEY       = 'TARGET_YMD';      // den, který se právě zpracovává (rozpracovaná práce)
var LAST_DONE_KEY    = 'LAST_DONE_YMD';   // poslední úspěšně dokončený (odeslaný) den
var TOKEN_KEY        = 'NEXT_PAGE_TOKEN';  // pokračovací token Content API
var PHASE_KEY        = 'PHASE';            // fáze rozpracovaného dne: 'scan' | 'report'
var TRUNCATED_KEY    = 'TRUNCATED';        // den uzavřen předčasně kvůli limitu bufferu
var BUFFER_PREFIX    = 'BUFFER_';          // chunky bufferu: BUFFER_0, BUFFER_1, ...
var BUFFER_COUNT_KEY = 'BUFFER_COUNT';     // počet chunků

/**
 * InstockerGMC – RUJZL.cz
 * Denní detekce nových produktů v Merchant Center přes Content API for Shopping (v2.1).
 * Logika vychází z ověřeného CRM skriptu instocker.py (scan feedu + filtr creationDate),
 * detaily (dostupnost, GTIN) se doberou hromadně přes custombatch – výrazně rychlejší.
 * Volá advanced service ShoppingContent (zapni: Advanced APIs → "Shopping content").
 * Funguje v Google Ads skriptu i ve standalone Apps Scriptu.
 *
 * Robustnost:
 *  - Doháněj zameškané dny (drží "poslední dokončený den", strop MAX_LOOKBACK_DAYS).
 *  - Rozpracovaný den se vždy nejdřív dojede a odešle, teprve pak začne nový (resume přes dny).
 *  - Stav (token + buffer) přežívá v PropertiesService, buffer chunkovaně.
 *  - Globální try/catch → při chybě jde failure e-mail (nelže, že report proběhl).
 *  - LockService přes feature-detect (Ads skripty ho nemají → graceful skip).
 */
function main() {
  // [ Zámek ] – feature-detect; standalone Apps Script ano, Google Ads skript ne.
  var lock = acquireLock_();
  if (lock === 'busy') {
    Logger.log('⏭️  Jiný běh drží zámek – končím bez akce.');
    return;
  }

  try {
    runMain_();
  } catch (err) {
    handleFatal_(err);   // pošle failure e-mail (pokud je EMAIL) a chybu znovu vyhodí
  } finally {
    releaseLock_(lock);
  }
}

function runMain_() {
  validateConfig_();   // fail-fast: prázdné MC_ID/EMAIL = srozumitelná chyba hned

  var props   = PropertiesService.getScriptProperties();
  var started = new Date().getTime();

  Logger.log('========================================');
  Logger.log('  InstockerGMC v' + VERSION + ' | ' + BRANDING);
  Logger.log('  MC účet: ' + MC_ID);
  Logger.log('  ' + new Date().toLocaleString());
  Logger.log('========================================');

  // [ Fáze 1/3 – Příprava ]
  Logger.log('[ Fáze 1/3 – Příprava ]');
  var accountName = getAccountName_();
  Logger.log('Účet: ' + accountName);
  Logger.log('Poslední dokončený den: ' + (props.getProperty(LAST_DONE_KEY) || 'žádný'));

  var processedDays = 0;

  // Zpracuj postupně všechny "dlužné" dny, dokud zbývá čas. Rozpracovaný den má přednost.
  while (true) {
    if (timeExceeded_(started)) {
      Logger.log('⏸️  Vyčerpán časový limit mezi dny – zbytek dohoní příští běh.');
      break;
    }

    var target = pickTarget_(props);
    if (!target) {
      Logger.log('✅ Žádný další den k zpracování.');
      break;
    }

    // Nový den nastartuj jen pokud není rozpracovaný (resume přes dny: starší den dojeď nejdřív).
    if (props.getProperty(TARGET_KEY) !== target) {
      initDayState_(props, target);
      Logger.log('▶️  Začínám nový den: ' + target);
    } else {
      Logger.log('↩️  Pokračuji v rozpracovaném dni: ' + target);
    }

    var result = processDay_(props, target, started, accountName);
    if (result === 'suspended') {
      Logger.log('⏸️  Den ' + target + ' není dokončen – stav uložen, příště navážu.');
      break;
    }
    processedDays++;
  }

  Logger.log('========================================');
  Logger.log('  Hotovo | dokončených dnů v tomto běhu: ' + processedDays);
  Logger.log('========================================');
}

/******** Výběr cílového dne (catch-up) ********/

// Vrátí den ke zpracování (yyyy-MM-dd) nebo null, když není co dělat.
// Rozpracovaný den (TARGET_KEY) má vždy přednost – nejdřív ho dojedeme.
function pickTarget_(props) {
  var current = props.getProperty(TARGET_KEY);
  if (current) return current;

  var yesterday = ymdOffset_(-1);
  var earliest  = ymdOffset_(-MAX_LOOKBACK_DAYS);
  var lastDone  = props.getProperty(LAST_DONE_KEY);

  var start;
  if (lastDone) {
    start = nextYmd_(lastDone);
    if (start < earliest) start = earliest;   // strop lookbacku – starší dny nedoháníme
  } else {
    start = yesterday;                          // první běh: jen včerejšek (žádný velký backfill)
  }

  if (start > yesterday) return null;           // vše do včerejška hotové
  return start;
}

/******** Zpracování jednoho dne ********/

// Vrátí 'completed' (den dojetý a report odeslán) nebo 'suspended' (čas/limit – stav uložen).
function processDay_(props, target, started, accountName) {
  var phase  = props.getProperty(PHASE_KEY) || 'scan';
  var buffer = readBuffer_(props);

  // [ Fáze 2/3 – Sken produktů ]
  if (phase === 'scan') {
    Logger.log('[ Fáze 2/3 – Sken produktů ] (den ' + target + ')');
    var scan = scanDay_(props, target, started, buffer);
    if (scan === 'suspended') return 'suspended';
    // Sken hotov – přepni do fáze report a zafixuj buffer.
    saveBuffer_(props, buffer);
    props.setProperty(PHASE_KEY, 'report');
  } else {
    Logger.log('[ Fáze 2/3 – přeskočeno ] Sken už proběhl, navazuji reportem (den ' + target + ').');
  }

  // [ Fáze 3/3 – Detaily + report ]
  Logger.log('[ Fáze 3/3 – Detaily (custombatch) + report ] (den ' + target + ')');
  buffer = readBuffer_(props);
  enrichBatch_(buffer);

  var truncated = props.getProperty(TRUNCATED_KEY) === 'true';
  Logger.log('Den ' + target + ' – nových produktů: ' + buffer.length + (truncated ? ' (sken oříznut na limitu bufferu)' : ''));
  sendEmail_(buffer, target, accountName, truncated);

  markDayDone_(props, target);
  Logger.log('✔️  Den ' + target + ' dokončen a odeslán.');
  return 'completed';
}

// Projde feed pro daný den. Buffer mutuje in-place, dedup podle restId.
// Stránku zpracuje VŽDY celou (token na další stránku se ukládá až po jejím dokončení),
// aby restart neztratil zbytek stránky. Vrací 'complete' nebo 'suspended'.
function scanDay_(props, target, started, buffer) {
  var nextPageToken = props.getProperty(TOKEN_KEY);
  var seen          = buildSeenSet_(buffer);   // dedup z minulých běhů
  var bufferBytes   = approxBytes_(buffer);    // inkrementální byte-counter (ne JSON.stringify v každém pushi)
  var totalFetched  = 0;

  Logger.log('Pokračuji od tokenu: ' + (nextPageToken || 'ZAČÁTEK') +
    (buffer.length ? (', nalezeno z minula: ' + buffer.length) : ''));

  while (true) {
    if (timeExceeded_(started)) {
      saveState_(props, nextPageToken, buffer);
      Logger.log('⚠️  Limit času (' + MAX_RUN_MINUTES + ' min) – stav uložen. Načteno: ' + totalFetched + ', nalezeno: ' + buffer.length);
      return 'suspended';
    }

    if (bufferBytes > MAX_BUFFER_BYTES) {
      // Stav je extrémní (tisíce nových produktů za den). Uzavři den s tím, co máme,
      // jinak by se buffer při dalším běhu znovu načetl plný a zacyklil se.
      props.setProperty(TRUNCATED_KEY, 'true');
      Logger.log('⚠️  Buffer u limitu (' + MAX_BUFFER_BYTES + ' B) – uzavírám den s ' + buffer.length + ' položkami.');
      return 'complete';
    }

    var resp      = listWithRetry_(nextPageToken);
    var resources = (resp && resp.resources) ? resp.resources : [];
    totalFetched += resources.length;
    Logger.log('→ Načteno ' + resources.length + ' produktů (celkem ' + totalFetched + ')');

    for (var i = 0; i < resources.length; i++) {
      var r = resources[i];
      if (!r.creationDate) continue;

      var created = new Date(r.creationDate);
      if (isNaN(created.getTime())) continue;   // Invalid Date – přeskoč, neshazuj sken

      var dateAdd = Utilities.formatDate(created, TZ, 'yyyy-MM-dd');
      if (dateAdd !== target) continue;

      var restId = String(r.productId || '');
      if (restId && seen[restId]) continue;     // dedup
      if (restId) seen[restId] = true;

      var item = parseStatus_(r);
      buffer.push(item);
      bufferBytes += JSON.stringify(item).length + 1;

      if (buffer.length % 50 === 0) {
        Logger.log('  [' + buffer.length + ' nalezeno z ' + totalFetched + ' načtených]');
      }
    }

    nextPageToken = (resp && resp.nextPageToken) ? resp.nextPageToken : null;
    if (!nextPageToken) break;                   // poslední stránka zpracována

    // Stránka je celá hotová → bezpečné uložit token na další stránku.
    saveState_(props, nextPageToken, buffer);
  }

  return 'complete';
}

/******** Content API ********/

// Productstatuses.list s retry na tranzientní chyby (timeout/5xx/429) – velké feedy
// jinak timeoutují a celý sken padne. Vzor převzat z CRM instocker.py.
function listWithRetry_(pageToken) {
  return withRetry_(function () {
    return ShoppingContent.Productstatuses.list(MC_ID, {
      includeInvalidInsertedItems: true,
      pageToken: pageToken,
      maxResults: PAGE_SIZE
    });
  }, 'Productstatuses.list');
}

// Hromadné dobrání dostupnosti + GTIN přes Products.custombatch (po dávkách).
// Místo N volání get za sebou = ceil(N/BATCH_SIZE) volání → výrazné zrychlení.
// Retry s backoffem i pro custombatch; kontrola per-entry chyb (en.errors);
// když se detail nenačte, NEoznačuj falešně GTIN jako NONE – odliš "detail se nenačetl".
function enrichBatch_(items) {
  if (!items || !items.length) return;
  var merchantId = Number(MC_ID);

  for (var start = 0; start < items.length; start += BATCH_SIZE) {
    var end     = Math.min(start + BATCH_SIZE, items.length);
    var entries = [];
    for (var k = start; k < end; k++) {
      entries.push({ batchId: k, merchantId: merchantId, method: 'get', productId: items[k].restId });
    }

    var resp = custombatchWithRetry_(entries, start, end);
    if (!resp) {
      // Celá dávka selhala natrvalo → items zůstávají s detailLoaded=false (žádné falešné NONE).
      continue;
    }

    var rEntries = (resp && resp.entries) ? resp.entries : [];
    var ok = 0;
    for (var m = 0; m < rEntries.length; m++) {
      var en  = rEntries[m];
      var idx = en.batchId;
      if (!items[idx]) continue;

      if (en.errors && en.errors.errors && en.errors.errors.length) {
        var firstErr = en.errors.errors[0];
        Logger.log('  ⚠️  custombatch položka ' + idx + ' chyba: ' + (firstErr && firstErr.message ? firstErr.message : 'neznámá'));
        continue;   // detailLoaded zůstává false
      }
      if (!en.product) continue;   // detail se nenačetl → detailLoaded false

      var p = en.product;
      items[idx].detailLoaded = true;
      items[idx].availability = p.availability ? String(p.availability) : '';
      if (p.title) items[idx].title = p.title;
      if (p.link)  items[idx].link  = p.link;
      var gt = p.gtin || '';
      items[idx].gtin = gt ? (Array.isArray(gt) ? gt.join(', ') : String(gt)) : '';
      ok++;
    }
    Logger.log('  custombatch: dobráno ' + ok + '/' + (end - start) + ' (celkem do ' + end + '/' + items.length + ')');
  }
}

function custombatchWithRetry_(entries, start, end) {
  try {
    return withRetry_(function () {
      return ShoppingContent.Products.custombatch({ entries: entries });
    }, 'Products.custombatch ' + start + '–' + end);
  } catch (e) {
    Logger.log('⚠️  custombatch selhal natrvalo (' + start + '–' + end + '): ' + (e && e.message ? e.message : e));
    return null;
  }
}

function getAccountName_() {
  try {
    var account = ShoppingContent.Accounts.get(MC_ID, MC_ID);
    return (account && account.name) ? account.name : MC_ID;
  } catch (e) {
    Logger.log('⚠️  Nepodařilo se načíst název účtu: ' + (e && e.message ? e.message : e));
    return MC_ID;
  }
}

/******** Retry helper (sdílený) ********/

function withRetry_(fn, label) {
  var lastErr;
  for (var attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      var msg = String(e && e.message ? e.message : e);
      if (attempt < MAX_RETRIES && isRetryable_(msg)) {
        var wait = backoffMs_(attempt);
        Logger.log('[retry ' + attempt + '/' + MAX_RETRIES + '] ' + label + ': ' + msg + ' (čekám ' + wait + ' ms)');
        Utilities.sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function isRetryable_(msg) {
  var retryable = /timed out|timeout|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|rate limit|too many|Service invoked too many times|Empty response|backend error|internal error|Unknown/i.test(msg);
  var credErr   = /invalid_grant|invalid_client|\b401\b|\b403\b|expired|revoked|PERMISSION_DENIED/i.test(msg);
  return retryable && !credErr;
}

// Exponenciální backoff s jitterem (1s, 2s, 4s, 8s + náhodný posun).
function backoffMs_(attempt) {
  var base   = 1000 * Math.pow(2, attempt - 1);
  var jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

/******** Parsování statusu (rychlé, bez get) ********/

function parseStatus_(r) {
  // Statusy destinací. Default 'pending' (čerstvý produkt bez destinationStatuses), ne 'n/a'.
  var pla = 'pending', gdn = 'pending', sag = 'pending';
  var ds = r.destinationStatuses || [];
  for (var j = 0; j < ds.length; j++) {
    var dest = ds[j].destination;
    var st   = statusOf_(ds[j]);
    if (dest === 'Shopping') pla = st;
    else if (dest === 'DisplayAds') gdn = st;
    else if (dest === 'SurfacesAcrossGoogle') sag = st;
  }

  var restId = String(r.productId || '');
  var ids    = parseRestId_(restId);

  var creationDate = r.creationDate
    ? formatCreation_(r.creationDate)
    : '';

  return {
    offerId: ids.offerId || (r.offerId || ''),
    title: r.title || '',     // doplní/přepíše custombatch
    link: r.link || '',       // doplní/přepíše custombatch
    availability: '',         // doplní custombatch
    gtin: '',                 // doplní custombatch
    detailLoaded: false,      // true až když custombatch vrátí produkt
    creationDate: creationDate,
    restId: restId,
    pla: pla,
    gdn: gdn,
    sag: sag
  };
}

// Status destinace napříč zeměmi: approved / partial / disapproved / pending.
// "partial" = aspoň jedna země approved a zároveň jiná disapproved/pending.
function statusOf_(d) {
  var hasApproved    = (d.approvedCountries || []).length > 0;
  var hasDisapproved = (d.disapprovedCountries || []).length > 0;
  var hasPending     = (d.pendingCountries || []).length > 0;

  if (hasApproved && (hasDisapproved || hasPending)) return 'partial';
  if (hasApproved)    return 'approved';
  if (hasDisapproved) return 'disapproved';
  if (hasPending)     return 'pending';
  if (d.status)       return String(d.status);
  return 'pending';
}

// restId formát: channel:language:country:offerId. offerId může obsahovat dvojtečky,
// proto dělíme jen na první 3 dvojtečky a zbytek je celé offerId.
function parseRestId_(restId) {
  var s = String(restId || '');
  var i1 = s.indexOf(':');
  var i2 = i1 >= 0 ? s.indexOf(':', i1 + 1) : -1;
  var i3 = i2 >= 0 ? s.indexOf(':', i2 + 1) : -1;
  if (i1 < 0 || i2 < 0 || i3 < 0) {
    return { channel: '', language: '', country: '', offerId: '' };
  }
  return {
    channel:  s.substring(0, i1),
    language: s.substring(i1 + 1, i2),
    country:  s.substring(i2 + 1, i3),
    offerId:  s.substring(i3 + 1)
  };
}

/******** Stav (PropertiesService) ********/

function initDayState_(props, target) {
  clearBufferChunks_(props);
  props.setProperty(TARGET_KEY, target);
  props.deleteProperty(TOKEN_KEY);
  props.deleteProperty(TRUNCATED_KEY);
  props.setProperty(PHASE_KEY, 'scan');
}

function markDayDone_(props, target) {
  props.setProperty(LAST_DONE_KEY, target);
  props.deleteProperty(TARGET_KEY);
  props.deleteProperty(TOKEN_KEY);
  props.deleteProperty(PHASE_KEY);
  props.deleteProperty(TRUNCATED_KEY);
  clearBufferChunks_(props);
}

function saveState_(props, token, buffer) {
  if (token != null) props.setProperty(TOKEN_KEY, token);
  else props.deleteProperty(TOKEN_KEY);
  saveBuffer_(props, buffer);
}

// Buffer se ukládá chunkovaně (per-value limit ~9 KB). Staré chunky se nejdřív smažou.
function saveBuffer_(props, buffer) {
  var json = JSON.stringify(buffer || []);
  clearBufferChunks_(props);

  var count = 0;
  for (var i = 0; i < json.length; i += BUFFER_CHUNK_BYTES) {
    props.setProperty(BUFFER_PREFIX + count, json.substring(i, i + BUFFER_CHUNK_BYTES));
    count++;
  }
  props.setProperty(BUFFER_COUNT_KEY, String(count));
}

function readBuffer_(props) {
  var countStr = props.getProperty(BUFFER_COUNT_KEY);
  if (!countStr) return [];
  var count = parseInt(countStr, 10);
  if (isNaN(count) || count <= 0) return [];

  var json = '';
  for (var i = 0; i < count; i++) {
    var part = props.getProperty(BUFFER_PREFIX + i);
    if (part == null) return [];   // poškozený stav – raději prázdné než garbage
    json += part;
  }
  try { return JSON.parse(json); } catch (e) { return []; }
}

function clearBufferChunks_(props) {
  var countStr = props.getProperty(BUFFER_COUNT_KEY);
  if (countStr) {
    var count = parseInt(countStr, 10);
    if (!isNaN(count)) {
      for (var i = 0; i < count; i++) props.deleteProperty(BUFFER_PREFIX + i);
    }
  }
  props.deleteProperty(BUFFER_COUNT_KEY);
}

function buildSeenSet_(buffer) {
  var seen = {};
  for (var i = 0; i < buffer.length; i++) {
    if (buffer[i] && buffer[i].restId) seen[buffer[i].restId] = true;
  }
  return seen;
}

function approxBytes_(buffer) {
  var n = 2; // '[' + ']'
  for (var i = 0; i < buffer.length; i++) {
    n += JSON.stringify(buffer[i]).length + 1;
  }
  return n;
}

/******** Zámek (feature-detect) ********/

// Vrací lock objekt (uvolnit later), null (zámky nedostupné – Ads skript), nebo 'busy'.
function acquireLock_() {
  if (typeof LockService === 'undefined') return null;
  try {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) return 'busy';
    return lock;
  } catch (e) {
    return null;   // graceful skip
  }
}

function releaseLock_(lock) {
  if (lock && lock !== 'busy' && typeof lock.releaseLock === 'function') {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/******** Konfigurace a chyby ********/

function validateConfig_() {
  var errs = [];
  if (!MC_ID) errs.push('MC_ID není vyplněné');
  if (!EMAIL) errs.push('EMAIL není vyplněný');
  if (errs.length) {
    throw new Error('Chybná konfigurace: ' + errs.join(', ') + '. Vyplň sekci KONFIG nahoře v Code.gs.');
  }
}

function handleFatal_(err) {
  var msg = String(err && err.message ? err.message : err);
  Logger.log('❌ FATÁLNÍ CHYBA: ' + msg);

  if (EMAIL) {
    try {
      MailApp.sendEmail({
        to: EMAIL,
        subject: SUBJECT_PREFIX + ' – ⚠️ CHYBA běhu',
        htmlBody: failureHtml_(msg)
      });
      Logger.log('📧  Odeslán chybový e-mail.');
    } catch (e) {
      Logger.log('Nepodařilo se odeslat chybový e-mail: ' + (e && e.message ? e.message : e));
    }
  }

  throw err;   // znovu vyhodit → platforma označí běh jako selhaný (alerting)
}

/******** Datum / čas ********/

function ymdOffset_(deltaDays) {
  var d = new Date();
  d.setDate(d.getDate() + deltaDays);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

// Den po zadaném yyyy-MM-dd. Počítáno v UTC poledne, ať DST/půlnoc neposunou výsledek.
function nextYmd_(ymd) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + 1);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function formatCzechDate_(ymd) {
  var parts = ymd.split('-');
  return parseInt(parts[2], 10) + '.' + parseInt(parts[1], 10) + '. ' + parts[0];
}

function formatCreation_(raw) {
  var d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, TZ, 'd. M. yyyy');
}

function timeExceeded_(startedMs) {
  return (new Date().getTime() - startedMs) > MAX_RUN_MINUTES * 60 * 1000;
}

/******** Email ********/

function sendEmail_(items, ymd, accountName, truncated) {
  var czDate  = formatCzechDate_(ymd);
  var count   = items ? items.length : 0;
  var subject = SUBJECT_PREFIX + ' ' + accountName + ' ' + czDate + ' (' + count + ')';

  if (!count) {
    if (!SEND_EMPTY_REPORT) {
      Logger.log('📭  Žádné nové produkty (' + czDate + ') – info e-mail vypnut (SEND_EMPTY_REPORT=false).');
      return;
    }
    MailApp.sendEmail({
      to: EMAIL,
      subject: subject,
      htmlBody: emptyHtml_(czDate)
    });
    Logger.log('📭  Info-e-mail: žádné nové produkty (' + czDate + ').');
    return;
  }

  MailApp.sendEmail({ to: EMAIL, subject: subject, htmlBody: buildEmailHtml_(items, ymd, truncated) });
  Logger.log('📧  E-mail odeslán – ' + count + ' produktů (' + czDate + ').');
}

function emptyHtml_(czDate) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#23065A;">' +
    '<p>Den ' + esc_(czDate) + ' – do Merchant Center nebyly přidány žádné nové produkty.</p>' +
    footerHtml_() + '</div>';
}

function failureHtml_(msg) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#23065A;">' +
    '<p><b>InstockerGMC selhal.</b> Report se NEodeslal kompletně.</p>' +
    '<p>Chyba:</p>' +
    '<pre style="background:#f4f4f4;padding:8px;border-radius:4px;white-space:pre-wrap;">' + esc_(msg) + '</pre>' +
    '<p>Zkontroluj prosím skript, oprávnění a přístup k Merchant Centru. Při příštím běhu se rozpracovaný den dohoní.</p>' +
    footerHtml_() + '</div>';
}

function buildEmailHtml_(items, ymd, truncated) {
  var DARK   = '#23065A';
  var CREAM  = '#FFFFFD';
  var GREEN  = '#E0F8BA';
  var RED_BG = '#ffb3b3';
  var OK_BG  = '#ACDF87';

  var czDate = formatCzechDate_(ymd);

  var out = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:' + DARK + ';">';
  out += '<p>Den <b>' + esc_(czDate) + '</b> – přibylo <b>' + items.length + '</b> nových produktů:</p>';

  out += '<table border="0" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;">';
  out += '<tr style="background:' + DARK + ';color:' + CREAM + ';">';
  out += '<th style="text-align:left">ID</th>';
  out += '<th style="text-align:left">Produkt</th>';
  out += '<th>Dostupnost</th>';
  out += '<th>PLA</th><th>GDN</th><th>Free</th>';
  out += '<th>GTIN</th><th>Přidáno</th></tr>';

  var shown = Math.min(items.length, MAX_EMAIL_ROWS);
  for (var i = 0; i < shown; i++) {
    out += buildRow_(items[i], i, CREAM, GREEN, OK_BG, RED_BG, DARK);
  }

  out += '</table>';

  if (items.length > MAX_EMAIL_ROWS) {
    out += '<p style="margin-top:8px;">…a dalších <b>' + (items.length - MAX_EMAIL_ROWS) +
      '</b> produktů. Tabulka je oříznutá na ' + MAX_EMAIL_ROWS +
      ' řádků kvůli limitu velikosti e-mailu (Gmail clipping). Strop lze zvýšit konstantou MAX_EMAIL_ROWS.</p>';
  }

  if (truncated) {
    out += '<p style="color:#a00;margin-top:8px;">⚠️ Sken byl pro tento den uzavřen předčasně na limitu bufferu – ' +
      'mohou chybět další nové produkty. Pro tak velké dny zvaž serverové řešení bez limitu.</p>';
  }

  out += footerHtml_();
  out += '</div>';
  return out;
}

function buildRow_(it, idx, CREAM, GREEN, OK_BG, RED_BG, DARK) {
  var rowBg = (idx % 2 === 0) ? CREAM : GREEN;

  var ids    = parseRestId_(it.restId);
  var mcLink = '';
  if (ids.offerId) {
    mcLink = 'https://merchants.google.com/mc/items/details?a=' + encodeURIComponent(MC_ID) +
      '&offerId='  + encodeURIComponent(ids.offerId) +
      '&country='  + encodeURIComponent(ids.country) +
      '&language=' + encodeURIComponent(ids.language) +
      '&channel='  + encodeURIComponent(MC_LINK_CHANNEL);
  }
  mcLink = safeHref_(mcLink);

  var idCell = mcLink
    ? '<a href="' + esc_(mcLink) + '" style="color:' + DARK + '">' + esc_(it.offerId) + '</a>'
    : esc_(it.offerId);

  var prodHref = safeHref_(it.link);
  var titleCell = prodHref
    ? '<a href="' + esc_(prodHref) + '" style="color:' + DARK + '">' + esc_(it.title) + '</a>'
    : esc_(it.title);

  var availCell;
  if (!it.detailLoaded) {
    availCell = '<span style="color:#999;">—</span>';
  } else if (it.availability && it.availability !== 'in stock') {
    availCell = '<strong>' + esc_(it.availability) + '</strong>';
  } else {
    availCell = esc_(it.availability);
  }

  var gtinCell;
  if (!it.detailLoaded) {
    gtinCell = '<span style="color:#999;">—</span>';        // detail se nenačetl, NEtvrdit NONE
  } else if (it.gtin) {
    gtinCell = esc_(it.gtin);
  } else {
    gtinCell = '<span style="color:red;font-weight:bold">NONE</span>';
  }

  var out = '<tr style="background:' + rowBg + '">';
  out += '<td>' + idCell + '</td>';
  out += '<td>' + titleCell + '</td>';
  out += '<td style="text-align:center">' + availCell + '</td>';
  out += '<td style="text-align:center;background:' + statusBg_(it.pla, OK_BG, RED_BG) + '">' + esc_(it.pla) + '</td>';
  out += '<td style="text-align:center;background:' + statusBg_(it.gdn, OK_BG, RED_BG) + '">' + esc_(it.gdn) + '</td>';
  out += '<td style="text-align:center;background:' + statusBg_(it.sag, OK_BG, RED_BG) + '">' + esc_(it.sag) + '</td>';
  out += '<td style="text-align:center">' + gtinCell + '</td>';
  out += '<td style="text-align:center">' + esc_(it.creationDate || '') + '</td>';
  out += '</tr>';
  return out;
}

function statusBg_(val, OK_BG, RED_BG) {
  if (val === 'approved') return OK_BG;
  if (val === 'partial' || val === 'pending') return '#FFE08A';   // jantarová – rozpracováno/částečně
  return RED_BG;   // disapproved a vše ostatní
}

function footerHtml_() {
  var label = 'InstockerGMC v' + VERSION + ' | ' + BRANDING;
  if (SHOW_LOGO) {
    return '<p style="color:#999;font-size:11px;margin-top:16px;">' +
      '<img src="' + esc_(LOGO_URL) + '" alt="' + esc_(BRANDING) + '" height="16" style="vertical-align:middle;margin-right:4px;">' +
      esc_(label) + '</p>';
  }
  return '<p style="color:#999;font-size:11px;margin-top:16px;">' + esc_(label) + '</p>';
}

function esc_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Vrátí URL jen pokud má http/https schéma, jinak '' (žádný odkaz).
function safeHref_(url) {
  var u = String(url || '');
  return /^https?:\/\//i.test(u) ? u : '';
}