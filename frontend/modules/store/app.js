/* ═══════════════════════════════════════════════════════════════════════
   ONE App — Store Auditing scanner (clean rebuild v7.0)
   ONE scan loop, ONE status system, proven cloud-first OCR + parser.
   ═══════════════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);

/* ─── AUTH: attach the login token the SAME way the rest of ONE App does ───
   The app stores a JWT in localStorage/sessionStorage as 'nav_token' and sends
   it in the Authorization header (see shared/common.js apiRequest). Plain fetch
   with cookies does NOT carry it → 401. This helper adds the header so the store
   module's save/list/delete/lookup are authenticated like every other module. */
function storeToken(){ return localStorage.getItem('nav_token') || sessionStorage.getItem('nav_token'); }
function storeCompany(){ return sessionStorage.getItem('nav_company') || 'COMPANYA'; }

/* ── Role detection (drives which tabs/modules this login sees) ──────────────
   Decode the JWT payload to read the user's role + name. The token is the same
   'nav_token' used for auth. We only READ it client-side for UI gating; the
   backend still enforces real access on every endpoint. */
function decodeToken(){
  try{
    const t = storeToken(); if(!t) return {};
    const payload = t.split('.')[1];
    const json = decodeURIComponent(atob(payload.replace(/-/g,'+').replace(/_/g,'/'))
      .split('').map(c=>'%'+('00'+c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json) || {};
  }catch(e){ return {}; }
}
function userRole(){ return (decodeToken().role || '').toLowerCase().trim(); }
function userDisplayName(){ const d=decodeToken(); return d.name || d.username || d.email || ''; }
const ROLE = { isAuditor:false, isStore:false, isDelivery:false, isAdmin:false };
function computeRole(){
  const r = userRole();
  ROLE.isAuditor  = (r === 'retailer auditor');
  ROLE.isDelivery = (r === 'retailer delivery');
  ROLE.isStore    = (r === 'store electrical' || r === 'store head' || r === 'mis store');
  ROLE.isAdmin    = (r === 'admin' || r === 'super admin' || /\bhead\b/.test(r));
  return ROLE;
}

/* EXACTLY matches common.js apiRequest (the proven working pattern from the shared
   code): token under 'nav_token' in the Authorization header (NO Bearer prefix,
   NO cookie), plus ?company= on the URL and an X-Company header. */
async function storeApiFetch(url, options){
  options = options || {};
  const token = storeToken();
  const company = storeCompany();
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = url + sep + 'company=' + encodeURIComponent(company);
  return fetch(fullUrl, {
    method: options.method || 'GET',
    headers: Object.assign({
      'Content-Type': 'application/json',
      'X-Company': company,
    }, (token ? { Authorization: token } : {}), options.headers || {}),
    body: options.body
  });
}
/* ─────────── PROVEN PARSER (verbatim from tested v6.x) ─────────── */
function fixD(s){return parseInt(String(s).replace(/[OoQ]/g,'0').replace(/[Il]/g,'1').replace(/[Aa]/g,'4'),10);}
const EXCL=/\b(mrp|price|incl|tax|tel|e-?mail|www|http|address|manufactur|[am]?h?ufactur|marketed|imported|voltage|volts|warranty|customer|consumer|complaint|made\s*in|district|dist|distt|tehsil|village|khasra|maharashtra|pradesh|himachal|haryana|gujarat|state|nagar|nadu|kerala|punjab|phase|floor|road|street|limited|limite[do]|ltd|pvt|[i1l]ndustr|electr[i1l]?[ck]a?l|techn[o0]l[o0]g|certif|month|batch|mfd|exp|wholesale|package|declared|individual|contents|specification|weight|colour|dimensions|carton|registered|office|searching|reading|label|capture|live\s*camera|auto\s*scan|sample)\b/i;
/* Extra guard: lines that are clearly a manufacturer/marketer/contact credit, even with OCR
   misreads ("MANUFACTURED BY", "MARKETED BY", "CONTACT RETAILER ELECTRICALS LIMITED" misread as
   "LONTACT BAJAI ELECTRILALS LIMITEO"). C↔L, D↔O, I↔1 are common OCR slips.
   Also rejects promotional/legal banners ("NOT INTENDED FOR SALE DIRECT TO A SINGLE CONSUMER",
   "WHOLESALE PACKAGE") even when OCR fuses the words ("NOTINTENDED", "SALEDIRECT"). */
const CREDIT_LINE=/\b([am]\w*ufactur\w*|marketed|imported)\b.*\bby\b|by\s*:\s*m\W?s\b|\b[i1l]ndustr|[cl][o0]ntact|electr[i1l]?[ck]a?l|limite[do]|electricals?\s*limit|not\s*intend|intended\s*for|sale\s*direct|saledirect|notintend|wholesale|single\s*c[o0]nsumer|for\s*sale\s*direct/i;
const CONTENT_LINE=/ASSEMBL|CARD\b|MANUAL|BLADE|WARRANT|INSTRUCTION|CONTENT|PER\s*U|MAX\b/i;
/* Generic commodity categories — these are NOT model names. If the parser only finds
   one of these, it's reading the COMMODITY line, not the MODEL line. Reject as item name. */
const COMMODITY_CATEGORIES=/^(MIXER\s*GRINDER|GRINDER|CEILING\s*FAN|TABLE\s*FAN|WALL\s*FAN|PEDESTAL\s*FAN|EXHAUST\s*FAN|FAN|DRY\s*IRON|STEAM\s*IRON|IRON|STORAGE\s*WATER\s*HEATER|WATER\s*HEATER|GEYSER|HEATER|TOASTER|KETTLE|BLENDER|JUICER|JUICER\s*MIXER\s*GRINDER|JMG|FOOD\s*PROCESSOR|INDUCTION\s*COOKTOP|INDUCTION|COOKTOP|RICE\s*COOKER|COOKER|OTG|OVEN|MICROWAVE|HAIR\s*DRYER|DRYER|TRIMMER|SHAVER|EPILATOR|HAIR\s*STRAIGHTENER|CHIMNEY|AIR\s*FRYER|AIR\s*COOLER|COOLER|GRINDER\s*MIXER|HAND\s*BLENDER|WET\s*GRINDER)$/i;
function isCommodityCategory(v){
  /* strip leading bullets/punctuation/colons so "• DRY IRON" or ": DRY IRON" is still caught */
  const cleaned=(v||'').replace(/^[\s•\-*:.,#·●○»>]+/,'').trim();
  return COMMODITY_CATEGORIES.test(cleaned);
}
/* ═══════════ MASTER VOCABULARY DICTIONARY ═══════════════════════════
   Based on Indian Legal Metrology Packaged Commodities Rules, 2011 — every
   carton must declare commodity-name + net-quantity + manufacturer + MRP.
   Brands choose between a small set of synonyms; we know them all. Priority
   ordered: stronger signals first, fallback chain below.
═══════════════════════════════════════════════════════════════════════ */

/* === MODEL/NAME field labels (priority ranked) === */
const MODEL_LABELS = [
  /* rank 5 — strongest, used by Retailer/BPL/LG/Samsung/Whirlpool/Voltas */
  { re: /\bM[O0]D[E3]L(?:\s*N[O0]\.?|\s*NUMBER|\s*NAME)?\b[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*(.*)$/i, rank: 5 },
  /* rank 4 — Panasonic/Sony often use DESCRIPTION; Reliance uses ITEM DESCRIPTION */
  { re: /\b(?:[I1]TEM\s+)?DESCR[I1]PT[I1][O0]N\b[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*(.*)$/i, rank: 4 },
  /* rank 4 — Philips/Havells sometimes */
  { re: /\bPR[O0]DUCT(?:\s*NAME)?\b[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*(.*)$/i, rank: 4 },
  /* rank 3 — Crompton/Usha/generic stickers */
  { re: /\b[I1]TEM(?:\s*NAME)?\b(?!\s*C[O0]DE)[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*(.*)$/i, rank: 3 },
  /* rank 3 — Reliance Retail uses ARTICLE */
  { re: /\bART[I1]CLE(?:\s*(?:NAME|DESCR[I1]PT[I1][O0]N))?\b[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*(.*)$/i, rank: 3 },
  /* rank 2 — Korean/Japanese brands occasionally */
  { re: /\bTYPE(?:\s*N[O0]\.?)?\b[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*(.*)$/i, rank: 2 },
  /* rank 2 — smaller brands meeting only LM minimum */
  { re: /\b(?:NAME\s*[O0]F\s*)?C[O0]MM[O0]?D[I1l]?T\w*\b[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*(.*)$/i, rank: 2 },
];
/* Legacy alias for any older code paths */
const ITEM_K = MODEL_LABELS.map(x => x.re);

/* === QTY field patterns (priority ranked) === */
/* Rank 3 = strong evidence (named keyword + number+unit). Rank 2 = keyword present. Rank 1 = last resort. */
const QTY_PATTERNS = [
  /* rank 3 — strongest: "NUMBER OF COMMODITY : 6U" Retailer-style.
     Made forgiving: the trailing unit letter (U/N) is now OPTIONAL and a space
     between number and unit is allowed, so "1U", "1 U", "1", "IU", "6 N" all read. */
  { re: /(?:[NR]UMBER|N[O0][.,]?)\s*[O0]F\s*C[O0]MM[O0]?D[I1l]?T\w*[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,6}\s*([0-9OoIlAaSsBb]{1,3})\s*[UuNn0Oo]?(?=\W|$)/i, rank: 3 },
  /* rank 3 — "Net Quantity : 1U" Reliance/Philips */
  { re: /\bNET\s*(?:QU?ANT(?:ITY)?|QTY)\.?\s*[.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*([0-9OoIlAa]{1,3})\s*[UuNn]?\b/i, rank: 3 },
  /* rank 3 — bare "QUANTITY: 6" / "QTY 6" */
  { re: /\b(?:QU?ANT(?:ITY)?|QTY)\.?\s*[.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*([0-9OoIlAa]{1,3})\s*[UuNn]?\b/i, rank: 3 },
  /* rank 3 — "PACK SIZE : 4" / "PACK OF 6" / "PACK QTY 8" */
  { re: /\bPACK(?:\s*(?:SIZE|QTY|[O0]F))?\.?\s*[.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*([0-9OoIlAa]{1,3})\s*[UuNn]?\b/i, rank: 3 },
  /* rank 2 — "6 PCS" / "6 NOS" / "6 PIECES" / "6 NUMBERS" / "6 EACH" */
  { re: /\b([0-9OoIlAa]{1,3})\s*(?:P[CG]S|P[I1]ECES|N[O0]S|NUMBERS|EACH)\b/i, rank: 2 },
  /* rank 2 — "PCS: 6" / "NOS: 6" prefix form */
  { re: /\b(?:P[CG]S|P[I1]ECES|N[O0]S|UN[I1]TS?|EACH)\.?\s*[.:#=+\u00a9\u00ae\u00b0,~\-]{0,5}\s*([0-9OoIlAa]{1,3})\b/i, rank: 2 },
  /* rank 2 — just "COMMODITY ... 1U" even without the NUMBER OF prefix (OCR often
     drops the prefix). Unit optional, space allowed. */
  { re: /C[O0]MM[O0]?D[I1l]?T\w*[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,6}\s*([0-9OoIlAaSsBb]{1,3})\s*[UuNn0Oo]?(?=\W|$)/i, rank: 2 },
  /* rank 2 — "SET OF 4" / "BUNDLE OF 6" / "MULTIPACK 8" */
  { re: /\b(?:SET|BUNDLE)\s*[O0]F[\s.:#=]{0,3}\s*([0-9OoIlAa]{1,3})\b/i, rank: 2 },
  { re: /\bMULT[I1]PACK[\s.:#=]{0,3}\s*([0-9OoIlAa]{1,3})\b/i, rank: 2 },
];

/* "COMMODITY" alone (no NUMBER OF prefix) — usually a content-type label, only rank 2 */
const Q_STRICT = QTY_PATTERNS[0].re;
const Q_GENERIC = QTY_PATTERNS[1].re;
const Q_COMMOD = /\bC[O0]MM[O0]?D[I1l]?T\w*[\s.:#=+\u00a9\u00ae\u00b0,~\-]{0,4}([0-9OoIlAa]{1,3}?)\s*[UuNn]\b/i;
const RE_NUMOF = /(?:[NR]UMBER|N[O0][.,]?)\s*[O0]F\b/i;
const RE_COMMOD = /C[O0]MM[O0]?D[I1l]?T/i;
const RE_QTYKW = /\b(?:NET\s*)?(?:QU?ANT(?:ITY)?|QTY|P[CG]S|N[O0]S|UN[I1]TS?|P[I1]ECES|EACH|NUMBERS|PACK)\b/i;
const Q_LONE = /^\s*[:.]?\s*([0-9OoIlAa]{1,3})\s*[UuNn]\s*$/;

/* === BRAND DETECTOR — for diagnostics + future per-brand tuning === */
const KNOWN_BRANDS = ['RETAILER','PANASONIC','BPL','LG','SAMSUNG','WHIRLPOOL','PHILIPS','HAVELLS','CROMPTON','USHA','ORIENT','SYSKA','VOLTAS','BLUE STAR','RELIANCE','WIPRO','ANCHOR','KENT','EUREKA','MORPHY','PRESTIGE','SOWBHAGYA','BUTTERFLY','SUMEET','PIGEON','MILTON','SONY','GODREJ','SUNFLAME','GLEN','IFB','BOSCH','SIEMENS','HITACHI','DAIKIN','CARRIER','LLOYD','ONIDA','VIDEOCON','MICROMAX','INTEX','AMBRANE','MI','XIAOMI','REALME','NOKIA','OPPO','VIVO'];
function detectBrand(text) {
  const up = (text || '').toUpperCase();
  for (const b of KNOWN_BRANDS) if (up.indexOf(b) !== -1) return b;
  return null;
}

function codeOf(t){
  const tx=(t||'');
  /* "ITEM CODE : 252080" / "252006EE" on one line. The trailing letter suffix
     (EE etc.) is now CAPTURED (inside the group) and kept — some NAV item codes
     genuinely have a letter suffix, and dropping it pointed at the wrong item. */
  let m=tx.match(/\b(?:[I1l]?TEM|[TVN]EM|[I1l]TE[MN])\s*C[O0][DO0]E[R]?[\s.:#=;+~\-]{0,25}([0-9OoIlSsBb]{4,12}[A-Z]{0,3})\b/i);
  if(m)return cleanCode(m[1]);
  /* TWO-COLUMN labels: "ITEM CODE" on the left, the value far to the RIGHT after a
     wide gap / colon (as on Retailer water-heater cartons: MODEL/ITEM CODE/WATTAGE in a
     left column, values in a right column). Allow a WIDE gap (many spaces, a colon)
     between the words and the number, but still on the SAME line. */
  m=tx.match(/\b(?:[I1l]?TEM|[TVN]EM|[I1l]TE[MN])\s*C[O0][DO0]E\b[^0-9\n]{0,90}?([0-9OoIlSsBb]{5,8}[A-Z]{0,3})\b/i);
  if(m)return cleanCode(m[1]);
  /* MODEL line with the code in PARENTHESES, e.g. "MODEL : RETAILER SWX 6 (270112)".
     The code lives inside ( ) at the end of the model name. Accept a 5-8 digit
     number (optionally +letter suffix) inside brackets on a MODEL line. */
  {
    const lines=tx.split(/\r?\n/);
    for(const ln of lines){
      if(/M[O0]DE[L1I]/i.test(ln)){
        const mm=ln.match(/[\(\[\{]\s*([0-9OoIlSsBb]{5,8}[A-Z]{0,3})\s*[\)\]\}]/);
        if(mm)return cleanCode(mm[1]);
      }
    }
    /* also a bare "(270112)" anywhere if it's a clean 6-digit bracketed number */
    const mp=tx.match(/[\(\[]\s*([0-9OoIlSsBb]{6}[A-Z]{0,3})\s*[\)\]]/);
    if(mp)return cleanCode(mp[1]);
  }
  /* also "CODE : 252080" or "ART CODE"/"VENDOR CODE : ..." */
  m=tx.match(/\b(?:ART|VEND[O0]R|PR[O0]D(?:UCT)?)?\s*C[O0][DO0]E[R]?[\s.:#=;+~\-]{0,5}([0-9OoIlSsBb]{5,12}[A-Z]{0,3})\b/i);
  if(m)return cleanCode(m[1]);
  /* keyword on one line, the number on the same or next 2 lines (handles a blank
     "ITEM CODE:" line followed by the digits, as seen on real Retailer cartons) */
  if(/(?:[I1l]?TEM|[TVN]EM)?\s*C[O0][DO0]E/i.test(tx)){
    const lines=tx.split(/\r?\n/);
    for(let i=0;i<lines.length;i++){
      if(/C[O0][DO0]E/i.test(lines[i])){
        for(let j=i;j<=Math.min(i+3,lines.length-1);j++){
          const m2=lines[j].match(/\b([0-9OoIlSsBb]{5,8}[A-Z]{0,3})\b/);
          if(m2)return cleanCode(m2[1]);
        }
      }
    }
  }
  /* FALLBACK for printed Retailer cartons where OCR mangles the words "ITEM CODE"
     (e.g. "ITFM C0DF") but the label is clearly a real product label. If we see
     enough Retailer-label markers AND a clean 5-8 digit number (optionally +letter
     suffix), accept that number as the code. This rescues "everything looks perfect
     but it says point at label" cases. */
  {
    const markers = (tx.match(/\b(MODEL|MRP|COMMODITY|VOLTAGE|MANUFACTURED|WARRANTY|RETAILER|RATED|CONTENTS|ASSEMBLY|SPECIFICATION|WEIGHT|CAPACITY|COLOUR|COLOR|DIMENSIONS|CONSUMER|ELECTRICALS|WATTAGE|MASTER\s*CARTON|NET\s*WEIGHT|GROSS)\b/gi)||[]).length;
    if(markers>=2){
      /* prefer a number that has the EE-style letter suffix (very Retailer), else a
         standalone 6-digit number that isn't a year/price/phone. */
      let m3 = tx.match(/\b([0-9OoIlSsBb]{5,8}[A-Z]{2,3})\b/);   // e.g. 261641EE
      if(m3) return cleanCode(m3[1]);
      /* collect 6-digit candidates, skip obvious non-codes (years 19xx/20xx, 8-digit barcodes) */
      const cands = (tx.match(/\b[0-9OoIlSsBb]{6}\b/g)||[])
        .map(cleanCode)
        .filter(n=>/^[0-9]{6}$/.test(n) && !/^(19|20)\d{4}$/.test(n));
      if(cands.length===1) return cands[0];   // exactly one clean 6-digit → confident
    }
  }
  return null;
}
/* normalise common OCR letter→digit swaps inside a numeric code */
/* Clean an item code while PRESERVING a trailing letter suffix (e.g. 252006EE).
   The numeric part gets OCR-misread correction (O→0, I/L→1, S→5, B→8); the
   trailing letters (a real part of some codes) are kept as-is. We do NOT strip
   letters globally any more — that was turning 252006EE into 252006 and pointing
   at the WRONG NAV item. */
function cleanCode(s){
  let x = (s||'').toUpperCase().trim();
  /* split into leading digits-ish part + trailing letter suffix */
  const m = x.match(/^([0-9OILSB]+)([A-Z]{0,3})$/);
  if(m){
    const num = m[1].replace(/O/g,'0').replace(/[IL]/g,'1').replace(/S/g,'5').replace(/B/g,'8').replace(/[^0-9]/g,'');
    const suffix = m[2] || '';
    return num + suffix;
  }
  /* fallback: fix digit misreads but keep any letters that remain */
  return x.replace(/O/g,'0').replace(/[IL]/g,'1').replace(/S/g,'5').replace(/B/g,'8').replace(/[^0-9A-Z]/g,'');
}

function cleanItemValue(v) {
  v = v.replace(/[|]/g, 'I').replace(/^[.:#=+\u00a9\u00ae\u00b0,~\-\s]+/, '').trim();
  /* strip leading qty fragment like "6U\t" or "1U " that bled in from tab-merged columns */
  v = v.replace(/^[0-9]{1,3}\s*[UuNn]\b[\s\t:.,\-]*/i, '').trim();
  v = v.split(/\s{3,}/)[0];
  /* if a tab appears mid-value, take the LONGEST segment (most likely the real model name) */
  if (v.indexOf('\t') !== -1) {
    const segs = v.split(/\t+/).map(x => x.trim()).filter(Boolean);
    v = segs.reduce((a, b) => itemScore(b) > itemScore(a) ? b : a, segs[0] || '');
  }
  /* If the value still contains its OWN label name (cloud concatenation), keep what follows the LAST label hit */
  const labRe = /\b(?:MODEL|DESCRIPTION|PRODUCT(?:\s*NAME)?|ITEM(?:\s*NAME)?|ARTICLE(?:\s*NAME)?|TYPE(?:\s*N[O0])?)\b\s*[.:#=+\u00a9\u00ae\u00b0,~\-]{0,3}/gi;
  let lastMatch = null, mm;
  while ((mm = labRe.exec(v)) !== null) lastMatch = mm;
  if (lastMatch) v = v.slice(lastMatch.index + lastMatch[0].length).trim();
  /* now strip any trailing follow-on field labels */
  v = v.replace(/\b(?:item\s*c[o0]de|c[o0]de|description|product|article|type|specification|net\s*weight|gross\s*weight|colour|color|dimensions|wattage|voltage|capacity|mounting|inner\s*tank|made\s*in|c[o0]mm[o0]dity|number\s*[o0]f|q[t7][yv]|quantity|mrp|rated|unit\s*sale|manufactured|contents)\b.*$/i, '').trim();
  v = v.replace(/[.:#=\-\s]+$/, '').replace(/\s{2,}/g, ' ');
  v = v.slice(0, 60);

  /* ── LIGHT cleanup only: keep the FULL model name, remove only OCR noise ── */
  /* strip a trailing tab-fragment that bled from the neighbouring column (e.g. "\t19:4280") */
  v = v.split('\t')[0].trim();
  /* strip stray trailing punctuation/symbols, but keep words, numbers, parentheses, hyphens */
  v = v.replace(/[\s.:;,#=~_]+$/, '').trim();
  v = v.replace(/\s{2,}/g, ' ').trim();

  const capsWords = (v.match(/\b[A-Z][A-Z0-9]{2,}\b/g) || []).length;
  const titleWords = (v.match(/\b[A-Z][a-z]{2,}\b/g) || []).length;
  const hasUnit = /\b\d{2,4}\s*(?:MM|CM|L|W|KG|G)\b/i.test(v);
  /* a known brand OR a model-code pattern (MX 16, DX14, NEO, 500W) means it IS a real product
     name — never blank those out, even if short. */
  const hasBrand = (typeof detectBrand==='function') ? !!detectBrand(v) : false;
  const hasModelCode = /\b[A-Z]{1,4}\s?\d{1,4}[A-Z]?\b/.test(v) || /\b\d{2,4}\s?W\b/i.test(v);
  if (hasBrand || hasModelCode || hasUnit) return v;
  /* otherwise require it to look like a real multi-word name */
  if (capsWords < 2 && !(capsWords >= 1 && titleWords >= 2) && titleWords < 3) return '';
  return v;
}

function looksLikeGibberish(v){
  /* Conservative guard against scrambled / wrong-rotation OCR (e.g. "ES LOY ANCD SIN IAWOD
     HIWNSNOD 3SVO"). ML Kit (primary engine) rarely produces this; this catches the rare case.
     We only reject when text is OVERWHELMINGLY unpronounceable AND has no brand/unit anchor,
     so real names like "TURBO 400MM FIJI BLUE" or "MAXIMA 6EE 600MM" are never rejected. */
  const hasUnit = /\b\d{2,4}\s*(?:MM|CM|W|KG|G|L|ML|RPM|V|EE|CF)\b/i.test(v) || /\d{2,4}(MM|W|L)/i.test(v);
  const hasBrand = (typeof detectBrand==='function') ? !!detectBrand(v) : false;
  if(hasBrand || hasUnit) return false;   // anchored by a real brand or unit → trust it

  /* strip pure-number tokens (they don't indicate gibberish either way) */
  const words = v.split(/\s+/).filter(w=>/[A-Za-z]/.test(w) && w.replace(/[^A-Za-z]/g,'').length>=2);
  if(words.length<3) return false;        // too short to judge; don't reject

  let bad=0;
  for(const w of words){
    const lw=w.toLowerCase().replace(/[^a-z]/g,'');
    if(lw.length<2) continue;
    const vowels=(lw.match(/[aeiou]/g)||[]).length;
    const vowelRatio=vowels/lw.length;
    const longConsonantRun=/[bcdfghjklmnpqrstvwxz]{4,}/.test(lw);
    const oddPairs=/(wn|nw|vo|wd|hw|sv|kx|qz|jx|3s|ncd|iaw)/.test(lw);
    if(vowelRatio<0.22 || longConsonantRun || oddPairs) bad++;
  }
  /* reject only when the clear majority of words are unpronounceable */
  return (bad/words.length) >= 0.55;
}
function saneItem(v) {
  /* a known brand or model-code pattern → definitely a real product name */
  const hasBrand = (typeof detectBrand==='function') ? !!detectBrand(v) : false;
  const hasModelCode = /\b[A-Z]{1,4}\s?\d{1,4}[A-Z]?\b/.test(v) || /\b\d{2,4}\s?W\b/i.test(v);
  if (hasBrand || hasModelCode) {
    if (looksLikeGibberish(v)) return false;
    return true;
  }
  const t = v.split(/\s+/);
  const l = t.filter(x => x.length >= 3).length;
  if (!(t.some(x => x.length >= 4 && /[A-Za-z]/.test(x)) && l >= t.length * 0.4)) return false;
  if (looksLikeGibberish(v)) return false;
  return true;
}

function itemScore(t) {
  const a = ((t || '').match(/[A-Z0-9]/g) || []).length;
  return a * a / Math.max((t || '').length, 1);
}

function qtyCandidates(rawLines) {            /* scan ALL QTY_PATTERNS — splits tab-columns first */
  const out = [];
  /* CLOUD OCR puts adjacent columns on one line separated by tabs. Split them. */
  const lines = [];
  for (const l of rawLines) {
    if (l.indexOf('\t') !== -1) for (const seg of l.split(/\t+/)) { if (seg.trim()) lines.push(seg.trim()); }
    else lines.push(l);
  }
  for (const l of lines) {
    /* skip price/MRP/date lines — they have numbers but never carton qty */
    if (/\b(MRP|R[Ss]\.?|\u20b9|INCL|TAX|MANUFACTURED|MFD|EXP)\b/i.test(l)) continue;
    let matched = false;
    for (const qp of QTY_PATTERNS) {
      const m = l.match(qp.re);
      if (!m) continue;
      const q = fixD(m[1]);
      if (q <= 0 || q >= 1000) continue;
      /* sanity: make sure this match isn't inside a contents phrase (e.g. "WARRANTY CARD 1N") */
      const start = Math.max(0, m.index - 25);
      const ctx = l.slice(start, m.index + m[0].length + 5);
      if (CONTENT_LINE.test(ctx)) continue;
      out.push({ q, rank: qp.rank });
      matched = true;
      break;
    }
    if (matched) continue;
    const m = l.match(Q_COMMOD);
    if (m) {
      const start = Math.max(0, m.index - 25);
      const ctx = l.slice(start, m.index + m[0].length + 5);
      if (CONTENT_LINE.test(ctx)) continue;
      const q = fixD(m[1]); if (q > 0 && q < 1000) out.push({ q, rank: 2 });
    }
  }
  /* last resort: lone "1U" line */
  if (!out.some(c => c.rank >= 2)) {
    for (const l of lines) {
      if (CONTENT_LINE.test(l)) continue;
      if (RE_NUMOF.test(l) || RE_COMMOD.test(l) || RE_QTYKW.test(l)) continue;
      const m = l.match(Q_LONE);
      if (m) { const q = fixD(m[1]); if (q > 0 && q < 1000) out.push({ q, rank: 1 }); }
    }
  }
  return out;
}

function parseP(text,lineObjs){
  const rawLines=(lineObjs&&lineObjs.length)?lineObjs.map(L=>L.text.trim()).filter(Boolean)
    :String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  /* TWO views of the text:
       - rawLines: original lines (preserves "MODEL\t: RETAILER NOTCH 500W" as one line for label matching)
       - lines: tab-split (each column becomes its own line, helps two-column / qty patterns) */
  const lines=[];
  for (const l of rawLines) {
    /* keep the original line, AND also push tab-split segments */
    lines.push(l);
    if (l.indexOf('\t') !== -1) for (const seg of l.split(/\t+/)) { if (seg.trim() && seg.trim() !== l) lines.push(seg.trim()); }
  }
  let itemName=null,itemRank=0,itemKwSeen=false;

  /* Two-column layout: labels stack, then values stack (cloud OCR reads this way).
     Detect any run of label-only lines followed by ":value" lines, pair them in order. */
  const LBL_MODEL=/^\s*M[O0]D[E3]L\s*:?\s*$/i;
  const LBL_COMM=/^\s*C[O0]MM[O0]?D[I1l]?T\w*\s*:?\s*$/i;
  const LBL_CODE=/^\s*[I1]TEM\s*C[O0][DO0]E\s*:?\s*$/i;
  const LBL_NUMOF=/^\s*NUMBER\s*[O0]F\s*$/i;
  const VAL_LINE=/^\s*:\s*(.+)$/;
  function whichLabel(l){
    if(LBL_MODEL.test(l))return 'MODEL';
    if(LBL_COMM.test(l))return 'COMMODITY';
    if(LBL_CODE.test(l))return 'CODE';
    if(LBL_NUMOF.test(l))return 'NUMOF';
    return null;
  }
  for(let i=0;i<lines.length-1;i++){
    /* require this line to be a label AND we haven't already paired it */
    if(!whichLabel(lines[i]))continue;
    let labelCount=0,j=i;
    const labelKinds=[];
    while(j<lines.length){
      const k=whichLabel(lines[j]);
      if(!k)break;
      labelKinds.push(k);labelCount++;j++;
    }
    if(labelCount<2){i=j-1;continue;}    /* single label is a normal case, skip */
    /* now collect the matching ":value" stack */
    const values=[];
    while(j<lines.length){
      const m=lines[j].match(VAL_LINE);
      if(!m)break;
      values.push(m[1].trim());j++;
    }
    /* pair labels to values in order */
    if(labelCount>=2&&values.length>=2){
      for(let k=0;k<labelCount&&k<values.length;k++){
        if(labelKinds[k]==='MODEL'){
          const v=cleanItemValue(values[k]);
          if(v.length>=2&&!EXCL.test(v)&&!CREDIT_LINE.test(v)&&saneItem(v)&&!isCommodityCategory(v)){itemName=v;itemRank=2;itemKwSeen=true;}
        }
      }
    }
  }

  /* Standard "LABEL: value" parse — MODEL keyword is king. Take its full value verbatim. */
  for(let i=0;i<lines.length;i++){
    for(const ml of MODEL_LABELS){
      const m=lines[i].match(ml.re);
      if(!m)continue;
      const captured=(m[1]||'').trim();
      if(!captured)continue;   /* label-only — two-column branch above handles it */
      itemKwSeen=true;
      let v=cleanItemValue(captured);
      if(v.length<2&&lines[i+1])v=cleanItemValue(lines[i+1]);
      if(v.length<2||EXCL.test(v)||CREDIT_LINE.test(v)||!saneItem(v))continue;
      if(isCommodityCategory(v))continue;
      /* MODEL/DESCRIPTION/PRODUCT (rank>=4) are the REAL model line — give them top priority
         so they always beat a weaker label or any fallback. */
      const newRank = ml.rank>=4 ? 3 : Math.min(2,ml.rank);
      if(newRank>itemRank||(newRank===itemRank&&itemScore(v)>itemScore(itemName||''))){
        itemName=v;itemRank=newRank;
      }
    }
  }
  /* FONT-SIZE FALLBACK — only when NO label keyword was found at all, and ONLY for text that
     clearly looks like a product (has a known brand OR a model-code/size). NEVER address/maker. */
  if(itemRank<2 && !itemKwSeen && lineObjs && lineObjs.length){
    let best=null,bs=0;
    for(const L of lineObjs){const t=L.text.trim();
      if(t.length<6||t.length>60)continue;
      if(EXCL.test(t)||CREDIT_LINE.test(t)||RE_NUMOF.test(t))continue;
      if(isCommodityCategory(t))continue;
      if(!saneItem(t))continue;
      /* must look like a product: a known brand, or a model-code / size token */
      const hasBrand=!!detectBrand(t);
      const hasModelCode=/\b[A-Z]{1,4}\s?\d{1,4}[A-Z]?\b/.test(t)||/\b\d{2,4}\s*(?:MM|W|L)\b/i.test(t);
      if(!hasBrand && !hasModelCode) continue;   /* skip anything that isn't clearly a product */
      const sc=(L.h||10)*(Math.max(L.conf,10)/100)*(1+Math.min(t.length,30)/60);
      if(sc>bs){bs=sc;best=t;}}
    if(best){
      const v=cleanItemValue(best);
      if(v){ itemName=v; itemRank=2; itemKwSeen=true; }
    }
  }
  return {itemName,itemRank,itemKwSeen,qcands:qtyCandidates(lines)};
}

/* consensus: clear weighted lead, or lone uncontradicted value */
function qtyDecide(votes,passes,isFinal){
  const e=[...votes.entries()].sort((a,b)=>b[1].w-a[1].w||b[1].rank-a[1].rank);
  if(!e.length)return null;
  const top=e[0],sec=e[1];
  if(e.length===1&&top[1].rank>=3&&top[1].w>=2)return top[0];   /* one clean strict read → instant */
  if(top[1].w>=3&&(!sec||top[1].w-sec[1].w>=2)&&top[1].rank>=2)return top[0];
  if(top[1].rank===1&&top[1].w>=4&&(!sec||top[1].w-sec[1].w>=3))return top[0];  /* lone-line qty: need stronger consensus */
  if(e.length===1&&top[1].w>=2&&passes>=3)return top[0];
  if(isFinal&&e.length===1&&top[1].w>=2)return top[0];
  return null;
}

function mapLines(d){return (d.lines||[]).map(L=>({text:L.text||'',conf:L.confidence||0,h:L.bbox?(L.bbox.y1-L.bbox.y0):0,bbox:L.bbox||null})).filter(L=>L.text.trim()&&L.conf>=20);}

/* single-pass compatibility wrapper (sample-label buttons etc.) */
function parseOcr(text,lines){
  const r=parseP(text,lines);
  const v=new Map();
  for(const c of r.qcands){const e=v.get(c.q)||{w:0,rank:0};e.w+=2;e.rank=Math.max(e.rank,c.rank);v.set(c.q,e);}
  const qty=qtyDecide(v,4,true);
  return {itemName:r.itemName,qty,green:!!r.itemName&&qty!==null};
}


/* ─────────── end parser ─────────── */

/* ═══ Memory / voting (matches parser expectations) ═══ */
function newMem(){return {item:null,itemRank:0,code:null,votes:new Map(),passes:0,lastText:'',thumb:null};}
function absorb(mem,r,code,variant){
  mem.passes++;
  if(r.itemName && (r.itemRank>mem.itemRank || (r.itemRank===mem.itemRank && itemScore(r.itemName)>itemScore(mem.item||'')))){
    mem.item=r.itemName; mem.itemRank=r.itemRank;
  }
  if(code && !mem.code) mem.code=code;
  for(const c of (r.qcands||[])){
    const w=(variant==='gray')?2:1;
    const ex=mem.votes.get(c.q)||{w:0,rank:0};
    mem.votes.set(c.q,{w:ex.w+w, rank:Math.max(ex.rank,c.rank)});
  }
}
function topVote(mem){let b=null;for(const [q,v] of mem.votes)if(!b||v.w>b.w)b={q,w:v.w};return b?b.q:null;}
function memQty(mem){
  if(!mem||!mem.votes.size)return null;
  let best=null;
  for(const [q,v] of mem.votes){ if(!best||v.w>best.w||(v.w===best.w&&v.rank>best.rank)) best={q,w:v.w,rank:v.rank}; }
  return best?best.q:null;
}
function memItem(mem){
  if(!mem)return null;
  if(mem.item && mem.itemRank>=2 && mem.item.length>=4) return mem.item;
  return null;
}
function memItemAny(mem){
  if(!mem)return null;
  if(mem.item)return mem.item;
  return mem.code?('ITEM-'+mem.code):null;
}
function memConfidence(mem){
  if(!mem)return 'RED';
  const it=memItem(mem), q=memQty(mem);
  /* GREEN if we have BOTH a confident item code and a qty. */
  if(it && q!==null){
    const qRank=Math.max(0,...[...mem.votes.values()].map(v=>v.rank||0));
    if(qRank>=2) return 'GREEN';
    return 'GREEN';   /* a code + any qty is good enough — don't over-require qRank */
  }
  /* If we have a confident item code but no qty yet, still allow capture —
     qty defaults to 1 (most cartons are 1 unit) and the name comes from NAV.
     This matches the more forgiving behaviour that worked before. */
  if(it) return 'GREEN';
  if(memItemAny(mem)||q!==null) return 'YELLOW';
  return 'RED';
}
function mapLines(d){return (d.lines||[]).map(L=>({text:L.text||'',conf:L.confidence||0,h:L.bbox?(L.bbox.y1-L.bbox.y0):0,bbox:L.bbox||null})).filter(L=>L.text.trim()&&L.conf>=20);}
function fakeLines(t){return String(t||'').split(/\r?\n/).filter(l=>l.trim()).map(l=>({text:l,conf:80,h:20,bbox:null}));}

/* ═══ SELF-LEARNING product memory ═══
   Every confirmed scan is remembered. Future reads are fuzzy-matched against this
   list; a close match is SILENTLY corrected to the clean remembered name. This makes
   repeat scans of the same product robust even when OCR varies slightly. */
const LEARN_KEY='companya_known_products_v1';
let knownProducts=[];        // [{name, code, count, lastSeen}]
function loadKnown(){
  try{ const raw=localStorage.getItem(LEARN_KEY); if(raw){ const a=JSON.parse(raw); if(Array.isArray(a)) knownProducts=a; } }catch(e){}
}
function saveKnown(){
  try{ localStorage.setItem(LEARN_KEY, JSON.stringify(knownProducts.slice(0,500))); }catch(e){}
}
function learnProduct(name, code){
  const n=(name||'').trim(); if(n.length<3) return;
  const norm=normName(n);
  let hit=knownProducts.find(p=>normName(p.name)===norm);
  if(hit){ hit.count=(hit.count||1)+1; hit.lastSeen=Date.now(); if(code&&!hit.code)hit.code=code; }
  else knownProducts.unshift({name:n, code:code||null, count:1, lastSeen:Date.now()});
  saveKnown();
}
function normName(s){
  /* normalise for comparison: uppercase, collapse spaces, drop punctuation, common OCR swaps */
  return (s||'').toUpperCase()
    .replace(/[()\[\]{}.,:;#@*~_\-]/g,' ')
    .replace(/0/g,'O').replace(/1/g,'I').replace(/5/g,'S').replace(/8/g,'B')
    .replace(/\s+/g,' ').trim();
}
/* token-overlap similarity 0..1 between two normalised names */
function simScore(a,b){
  const ta=normName(a).split(' ').filter(x=>x.length>=2);
  const tb=normName(b).split(' ').filter(x=>x.length>=2);
  if(!ta.length||!tb.length) return 0;
  let match=0;
  for(const t of ta){ if(tb.includes(t)) match++; }
  return match/Math.max(ta.length,tb.length);
}
/* Auto-correct only when the scan is a near-exact match to exactly ONE known product.
   Variants (DUETTO NEO 500W vs 750W) must never be collapsed: if the scan matches two
   known products almost equally, it's ambiguous → don't correct. */
function matchKnown(name){
  const n=(name||'').trim(); if(n.length<3||!knownProducts.length) return null;
  const scored=knownProducts.map(p=>({p, s:simScore(n,p.name)}))
                            .sort((a,b)=>b.s-a.s);
  const top=scored[0];
  if(!top || top.s < 0.85) return null;          // must be a very strong match

  /* ambiguity check: a different known product scores almost as high → unsafe to pick one */
  const second=scored[1];
  if(second && second.s >= top.s - 0.12) return null;

  return top.p;
}

/* ═══ Cloud OCR (OCR.space) ═══ */
const OCR_KEY_DEFAULT='K83901332088957';
function cloudKey(){return (localStorage.getItem('companya_ocr_key')||'').replace(/[\"\'\s]/g,'')||OCR_KEY_DEFAULT;}
async function cloudOcr(canvas){
  const max=2200, sc=Math.min(1,max/Math.max(canvas.width,canvas.height));
  const t=document.createElement('canvas');
  t.width=Math.round(canvas.width*sc); t.height=Math.round(canvas.height*sc);
  t.getContext('2d').drawImage(canvas,0,0,t.width,t.height);
  const b64=t.toDataURL('image/jpeg',0.85);
  const p=new URLSearchParams();
  p.append('apikey',cloudKey()); p.append('language','eng');
  p.append('OCREngine','2'); p.append('scale','true'); p.append('isTable','true');
  p.append('base64Image',b64);
  try{
    const res=await fetch('https://api.ocr.space/parse/image',{method:'POST',body:p});
    const j=await res.json();
    if(j.IsErroredOnProcessing) return {err:(j.ErrorMessage||'cloud error')+''};
    return {text:(j.ParsedResults&&j.ParsedResults[0]&&j.ParsedResults[0].ParsedText)||''};
  }catch(e){return {err:e.message||'network'};}
}

/* ═══ ML Kit (Google on-device, accurate + unlimited + free) ═══ */
function mlkitPlugin(){
  try{
    const C = window.Capacitor;
    if(!C) return null;
    /* Method 1: direct on Capacitor.Plugins (most common) */
    if(C.Plugins && C.Plugins.CapacitorPluginMlKitTextRecognition)
      return C.Plugins.CapacitorPluginMlKitTextRecognition;
    /* Method 2: some Capacitor versions expose registerPlugin — use it to get a proxy
       to the natively-registered plugin even when loading from a remote URL. */
    if(typeof C.registerPlugin === 'function'){
      try{
        const p = C.registerPlugin('CapacitorPluginMlKitTextRecognition');
        if(p) return p;
      }catch(e){}
    }
  }catch(e){}
  return null;
}
/* Expose a one-line diagnostic of what Capacitor actually sees on this device,
   so we can tell whether the native plugin is reachable from the web layer. */
function mlkitDiag(){
  try{
    const C = window.Capacitor;
    if(!C) return 'no-Capacitor (running in plain browser?)';
    const isNative = (C.isNativePlatform && C.isNativePlatform()) ? 'native' : 'web';
    const names = (C.Plugins ? Object.keys(C.Plugins) : []).join(',') || '(none)';
    const hasReg = (typeof C.registerPlugin === 'function') ? 'registerPlugin:yes' : 'registerPlugin:no';
    return isNative+' | plugins=['+names+'] | '+hasReg;
  }catch(e){ return 'diag-err:'+e.message; }
}
/* ── device tier: weak phones (≤4GB RAM or ≤4 cores — e.g. Vivo Y28 5G) get a
   lighter scan path. The full-res JPEG encode done every frame for OCR is what
   pins their CPU and freezes the UI ("phone hangs / won't scan"). Strong phones
   are left exactly as they were. */
let _lowEnd = null;
function lowEndDevice(){
  if(_lowEnd!==null) return _lowEnd;
  try{
    const mem   = (typeof navigator.deviceMemory==='number')       ? navigator.deviceMemory       : null;
    const cores = (typeof navigator.hardwareConcurrency==='number') ? navigator.hardwareConcurrency : null;
    _lowEnd = ((mem!=null && mem<=4) || (cores!=null && cores<=4));
  }catch(e){ _lowEnd=false; }
  return _lowEnd;
}
/* On weak phones, hand OCR a DOWNSCALED copy of the frame — a carton code reads
   fine well below full resolution, and the JPEG encode gets far cheaper. Reused
   canvas; strong phones get the frame untouched. */
let _ocrSmall=null;
function ocrFrameFor(canvas){
  if(!lowEndDevice() || !canvas || !canvas.width) return canvas;
  const maxW = 900;
  if(canvas.width <= maxW) return canvas;
  const scale = maxW / canvas.width;
  const w = Math.round(canvas.width*scale), h = Math.round(canvas.height*scale);
  const c = _ocrSmall || (_ocrSmall=document.createElement('canvas'));
  if(c.width!==w)  c.width  = w;
  if(c.height!==h) c.height = h;
  c.getContext('2d').drawImage(canvas, 0,0, w,h);
  return c;
}

let mlkitAvailable=false, mlkitLastErr='';
async function mlkitRead(canvas, rot, mem){
  const plug = mlkitPlugin();
  if(!plug) return {text:'', avail:false};
  /* The ML Kit plugin expects RAW base64 (no "data:image/...;base64," prefix). */
  const dataUrl = ocrFrameFor(canvas).toDataURL('image/jpeg', 0.92);
  const rawB64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
  try{
    const res = await Promise.race([
      plug.detectText({ base64Image: rawB64, rotation: rot||0 }),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('mlkit-timeout')), 2500))
    ]);
    const text = (res && res.text) || '';
    mlkitLastErr='';
    window._mlkitStalls = 0;   // a real response (even empty) → not wedged
    if(mem && text){
      const pr = parseP(text, fakeLines(text));
      absorb(mem, pr, codeOf(text), 'gray');
      absorb(mem, pr, codeOf(text), 'bin');
    }
    const pr2 = text ? parseP(text, fakeLines(text)) : {itemKwSeen:false,qcands:[]};
    return {text, avail:true, kw:(text && (pr2.itemKwSeen || pr2.qcands.length>0))};
  }catch(e){
    mlkitLastErr = (e&&(e.message||e.errorMessage))||'mlkit error';
    if(/timeout/i.test(mlkitLastErr)) window._mlkitStalls = (window._mlkitStalls||0) + 1;  // wedge → watchdog recovers
    return {text:'', avail:true, err:mlkitLastErr};
  }
}

/* Tesseract removed — engine is ML Kit (primary) + Cloud (fallback). */
let engineReady=false;   // kept as a harmless flag; no on-phone Tesseract anymore
function savedRot(){const r=parseInt(localStorage.getItem('companya_rot')||'',10);return [0,90,270,180].includes(r)?r:0;}
function rememberRot(r){try{localStorage.setItem('companya_rot',String(r));}catch(e){}}

/* ═══ Camera ═══ */
let stream=null, facing='environment', torchOn=false;
let zoomTrack=null, zoomCaps=null, curZoom=1, cssZoom=1;
async function refreshScreen(){
  setStatus('scan','🔄 Refreshing camera…');
  scanning=false; paused=false; ocrBusy=false;
  closeSavePopup();
  $('rescanBar').classList.add('hidden');
  try{ if(stream)stream.getTracks().forEach(t=>t.stop()); }catch(e){}
  const ok=await startCamera();
  if(ok){ startScan(); toast('Screen refreshed'); }
  else { setStatus('red','Camera blocked — allow permission & refresh'); }
}
async function startCamera(){
  try{
    if(stream)stream.getTracks().forEach(t=>t.stop());
    /* Request a SHARP feed for OCR: full-HD with continuous autofocus.
       1920x1080 gives ML Kit much more detail on small/glossy label text than 720p,
       without the heat/drain of 4K. continuous focus keeps the label crisp as the
       phone moves. We try the rich constraints first, then fall back if unsupported. */
    /* Strong phones keep full-HD for maximum label detail. Weak phones (≤4GB /
       ≤4 cores) drop to 720p @ 20fps so the feed + per-frame OCR encode don't
       pin the CPU and freeze scanning. */
    const _low = lowEndDevice();
    const _W = _low ? 1280 : 1920, _H = _low ? 720 : 1080, _FPS = _low ? 20 : 30;
    const rich = {
      facingMode: facing,
      width:  { ideal: _W },
      height: { ideal: _H },
      frameRate: { ideal: _FPS },
      focusMode: 'continuous',
      advanced: [
        { focusMode: 'continuous' },
        { focusDistance: 0 }          // bias toward near focus (labels are close)
      ]
    };
    try{
      stream = await navigator.mediaDevices.getUserMedia({ video: rich });
    }catch(e){
      /* Fallback: not all phones accept focusMode in constraints — retry plainly,
         then apply focus afterwards via applyConstraints. */
      stream = await navigator.mediaDevices.getUserMedia({
        video:{ facingMode:facing, width:{ideal:_W}, height:{ideal:_H} }
      });
    }
    $('video').srcObject=stream;
    await $('video').play();
    setupZoom();
    /* After the track is live, force continuous autofocus if the device supports it
       (many Androids ignore focusMode in getUserMedia but honour applyConstraints). */
    try{
      const tr = stream.getVideoTracks()[0];
      const caps = tr.getCapabilities ? tr.getCapabilities() : {};
      const adv = [];
      if(caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode:'continuous' });
      /* If torch helps on dark/glossy labels it's user-toggled separately. */
      if(adv.length) await tr.applyConstraints({ advanced: adv });
    }catch(e){}
    return true;
  }catch(e){
    setStatus('red','Camera blocked — allow camera permission'); return false;
  }
}
function setupZoom(){
  zoomTrack = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
  zoomCaps = (zoomTrack && zoomTrack.getCapabilities) ? zoomTrack.getCapabilities() : null;
  cssZoom = 1; curZoom = 1;
  $('video').style.transform = '';
  $('video').style.transformOrigin = 'center center';
  const bar = $('zoomBar');
  if (zoomCaps && zoomCaps.zoom) {
    /* hardware zoom available — use the slider over the real zoom range */
    const z = zoomCaps.zoom;
    $('zoomSlider').min = z.min; $('zoomSlider').max = z.max;
    $('zoomSlider').step = z.step || ((z.max - z.min) / 20);
    curZoom = (zoomTrack.getSettings && zoomTrack.getSettings().zoom) || z.min;
    $('zoomSlider').value = curZoom;
    bar.classList.remove('hidden');
    $('zoomMode').textContent = 'HW';
  } else {
    /* no hardware zoom — fall back to CSS digital zoom 1x–4x */
    $('zoomSlider').min = 1; $('zoomSlider').max = 4; $('zoomSlider').step = 0.1;
    $('zoomSlider').value = 1;
    bar.classList.remove('hidden');
    $('zoomMode').textContent = 'digital';
  }
  updateZoomLabel();
}
async function applyZoom(v){
  if (zoomCaps && zoomCaps.zoom) {
    curZoom = v;
    try { await zoomTrack.applyConstraints({ advanced: [{ zoom: v }] }); } catch(e){}
  } else {
    cssZoom = v;
    $('video').style.transform = 'scale(' + v + ')';
  }
  updateZoomLabel();
}
function updateZoomLabel(){
  const v = (zoomCaps && zoomCaps.zoom) ? curZoom : cssZoom;
  $('zoomLabel').textContent = (Math.round(v*10)/10) + '×';
}
/* Reuse ONE canvas for every frame grab. Creating a new canvas per frame (many
   times/second) leaked GPU/memory and made scanning die after ~10-12 scans
   ("Point at the label" forever). A single reused canvas fixes that. */
let _frameCanvas=null;
function grabFrame(){
  const v=$('video');
  if(!v.videoWidth)return null;
  const c = _frameCanvas || (_frameCanvas=document.createElement('canvas'));
  /* If digital (CSS) zoom is active, crop the centre to match what the user sees.
     Hardware zoom already affects the video stream, so no crop needed there. */
  const useCss = !(zoomCaps && zoomCaps.zoom) && cssZoom>1.01;
  if(useCss){
    const cw=v.videoWidth/cssZoom, ch=v.videoHeight/cssZoom;
    const sx=(v.videoWidth-cw)/2, sy=(v.videoHeight-ch)/2;
    c.width=Math.round(cw); c.height=Math.round(ch);
    c.getContext('2d').drawImage(v, sx,sy,cw,ch, 0,0,c.width,c.height);
  }else{
    c.width=v.videoWidth; c.height=v.videoHeight;
    c.getContext('2d').drawImage(v,0,0);
  }
  return c;
}
/* Enhance a frame for OCR on blurry / glossy / low-contrast labels:
   1) grayscale + contrast stretch (makes faint text darker, washed-out glare lighter)
   2) a light unsharp-mask (sharpening) to recover edge definition lost to blur.
   Returns a NEW canvas (pooled) so the original frame is untouched. */
let _enhCanvas=null;
function enhanceForOcr(src){
  if(!src) return src;
  try{
    const w=src.width, h=src.height;
    const c = _enhCanvas || (_enhCanvas=document.createElement('canvas'));
    c.width=w; c.height=h;
    const ctx=c.getContext('2d', {willReadFrequently:true});
    ctx.drawImage(src,0,0);
    const img=ctx.getImageData(0,0,w,h);
    const d=img.data;
    /* pass 1: grayscale + contrast stretch */
    let min=255,max=0;
    const gray=new Uint8ClampedArray(w*h);
    for(let i=0,p=0;i<d.length;i+=4,p++){
      const g=(d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114)|0;
      gray[p]=g; if(g<min)min=g; if(g>max)max=g;
    }
    const range=(max-min)||1;
    /* contrast-stretch + slight gamma to lift mid-tones (helps glare-washed text) */
    const lut=new Uint8ClampedArray(256);
    for(let g=0;g<256;g++){
      let n=(g-min)/range; if(n<0)n=0; if(n>1)n=1;
      n=Math.pow(n,0.85);                 // gentle gamma
      lut[g]=(n*255)|0;
    }
    for(let p=0;p<gray.length;p++) gray[p]=lut[gray[p]];
    /* pass 2: unsharp mask — sharpen edges (recovers blur) */
    const out=new Uint8ClampedArray(gray.length);
    const amt=0.6;                         // sharpening strength
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const idx=y*w+x;
        if(x===0||y===0||x===w-1||y===h-1){ out[idx]=gray[idx]; continue; }
        /* 3x3 blur average of neighbours */
        const blur=(gray[idx-w-1]+gray[idx-w]+gray[idx-w+1]
                   +gray[idx-1]  +gray[idx]  +gray[idx+1]
                   +gray[idx+w-1]+gray[idx+w]+gray[idx+w+1])/9;
        out[idx]=gray[idx] + (gray[idx]-blur)*amt;   // unsharp
      }
    }
    for(let i=0,p=0;i<d.length;i+=4,p++){
      d[i]=d[i+1]=d[i+2]=out[p]; d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
    return c;
  }catch(e){ return src; }   // if anything fails, fall back to the raw frame
}
/* ── HIGH-VOLUME CANVAS POOL ────────────────────────────────────────────────
   For 10-20k+ scans, creating a new canvas in each of these helpers (called
   several times per captured scan) accumulates and eventually exhausts memory,
   wedging the scanner. They now all reuse ONE shared work-canvas. Each call sets
   its size and draws fresh, so reuse is safe (no stale pixels leak between calls).*/
let _workCanvas=null;
function _work(w,h){
  const c = _workCanvas || (_workCanvas=document.createElement('canvas'));
  c.width=Math.round(w); c.height=Math.round(h);
  return c;
}
function toThumb(canvas,w){
  const sc=Math.min(1,w/canvas.width);
  const c=_work(canvas.width*sc, canvas.height*sc);
  c.getContext('2d').drawImage(canvas,0,0,c.width,c.height);
  return c.toDataURL('image/jpeg',0.82);
}
/* Photo for the table/zoom — 720p at moderate quality keeps files small (less memory
   and storage) while staying readable. */
function toPhoto(canvas,w){
  const sc=Math.min(1,w/canvas.width);
  const c=_work(canvas.width*sc, canvas.height*sc);
  c.getContext('2d').drawImage(canvas,0,0,c.width,c.height);
  return c.toDataURL('image/jpeg',0.65);
}
/* CROPPED photo — central region, kept SMALL so the save upload is fast over
   mobile data / the tunnel (large photos were making saves time out). 560px wide,
   strong compression. Still readable as proof, but a fraction of the size. */
function toCropPhoto(canvas, outW){
  outW = outW || 560;
  const cropW = Math.round(canvas.width  * 0.92);
  const cropH = Math.round(canvas.height * 0.86);
  const sx = Math.round((canvas.width  - cropW) / 2);
  const sy = Math.round((canvas.height - cropH) / 2);
  const sc = Math.min(1, outW / cropW);
  const c = _work(cropW * sc, cropH * sc);
  c.getContext('2d').drawImage(canvas, sx, sy, cropW, cropH, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.5);
}
/* Compact version for STORAGE — much smaller file for the database/disk.
   ~720px wide at 0.6 quality keeps the label readable as proof, at a fraction of the size. */
function toStorePhoto(canvas){
  const w=Math.min(720, canvas.width);
  const sc=w/canvas.width;
  const c=_work(canvas.width*sc, canvas.height*sc);
  c.getContext('2d').drawImage(canvas,0,0,c.width,c.height);
  return c.toDataURL('image/jpeg',0.6);
}

/* ═══ UI state ═══ */
let view='inward';            // inward | outward | total
let rows=[];                  // {id,direction,model,qty,status,thumb,at}


let seq=0;
let lastSavedKey='', lastSavedAt=0;

function setStatus(kind,text){
  const s=$('status');
  /* map scanYellow → amber visuals */
  const cls = kind==='scanYellow' ? 'scan' : kind;
  s.className='status '+cls; $('statusText').textContent=text;
  const cam=$('cam');
  cam.className='cam '+(kind==='green'?'green':kind==='red'?'red':(kind==='scan'||kind==='scanYellow')?'scan':'');
}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800);}
function setField(which,val){ /* form fields removed in v7.1 — no-op */ }

/* ═══ Continuous scan control (no countdown — smooth live light) ═══ */
let ocrBusy=false, paused=false, scanning=false;

function startScan(){
  if(scanning)return;
  scanning=true; paused=false; ocrBusy=false;
  setStatus('red','🔴 Point at the label');
  window._lastFrameAt = Date.now();   // watchdog heartbeat
  startScanWatchdog();
  ocrLoop();
}
function stopScan(){
  scanning=false;
  stopScanWatchdog();
}
function stopCamLoopUI(){
  /* called when a GREEN result fires the popup — keep last frame visible */
}

/* ── WAREHOUSE SAFETY NET ──────────────────────────────────────────────────
   A watchdog that auto-recovers if scanning freezes. If frames stop being
   processed for ~6 seconds while we're supposed to be scanning (e.g. a memory
   hiccup, the camera stream stalling, or ML Kit wedging), it rebuilds the camera
   and restarts the loop by itself — so you NEVER get permanently stuck on
   "Point at the label" mid-audit with no way to redeploy. */
let _watchdogTimer=null, _recovering=false;
function startScanWatchdog(){
  stopScanWatchdog();
  _watchdogTimer = setInterval(async ()=>{
    if(!scanning || paused || _recovering) return;
    const since = Date.now() - (window._lastFrameAt || 0);
    const mlkitWedged = (window._mlkitStalls||0) >= 4;   // ML Kit timed out 4+ times in a row

    /* If ML Kit has wedged (repeated timeouts), a camera restart won't fix it —
       the NATIVE plugin is stuck and only a full page reload resets it. Reload
       once; the app reopens to the same screen and ML Kit comes back fresh. */
    if(mlkitWedged){
      _recovering = true;
      try{
        setStatus('scan','🔄 Resetting scanner…');
        /* remember we auto-reloaded so we don't loop forever */
        try{ sessionStorage.setItem('store_autoreload', String(Date.now())); }catch(e){}
        setTimeout(()=>{ try{ location.reload(); }catch(e){} }, 400);
      }catch(e){ _recovering=false; }
      return;
    }

    if(since > 6000){
      /* frames stalled but ML Kit isn't wedged → a camera restart should fix it */
      _recovering = true;
      try{
        setStatus('scan','🔄 Auto-recovering camera…');
        try{ _frameCanvas=null; }catch(e){}
        try{ if(stream) stream.getTracks().forEach(t=>t.stop()); }catch(e){}
        scanning=false; ocrBusy=false; paused=false;
        const ok = await startCamera();
        window._lastFrameAt = Date.now();
        if(ok){ startScan(); }
        else { setStatus('red','🔴 Tap “Scan next” to resume'); }
      }catch(e){
        setStatus('red','🔴 Tap “Scan next” to resume');
      }finally{
        _recovering = false;
      }
    }
  }, 2000);
}
function stopScanWatchdog(){
  if(_watchdogTimer){ clearInterval(_watchdogTimer); _watchdogTimer=null; }
}

/* Smoothing: a candidate light must persist for STABLE_MS before it's shown,
   so a single bad frame never flickers the light. */
const STABLE_MS=1000;
let liveMem=null;             // rolling memory for the live (continuous) scan
let candState='', candSince=0, shownState='';

let lastCloudAt=0, cloudCooldownUntil=0;
const CLOUD_MIN_GAP=2500;     // at most ~1 cloud call / 2.5s → safe under 180/hour
async function ocrLoop(){
  liveMem=newMem(); candState=''; candSince=0; shownState='';
  window._lastScanCode = null;   // clear any code from a previous scan
  let lastThumbLocal=null;
  while(scanning && !paused){
    window._lastFrameAt = Date.now();   // watchdog heartbeat — proves the loop is alive
    if(!$('video').videoWidth){await sleep(80);continue;}
    if(ocrBusy){await sleep(40);continue;}
    ocrBusy=true;
    try{
      const frame=grabFrame();
      if(frame){
        let src='?', engineErr='';

        /* ML KIT — single fast read per frame at the saved rotation (cartons sit upright).
           No per-frame rotation probing here — that made the live light laggy. The
           deliberate Capture button does the careful multi-rotation read instead. */
        /* ML Kit read. If ML Kit has WEDGED earlier this session (it tends to stop
           responding after a batch of scans — a known native-plugin limit), skip it
           entirely and go straight to cloud, so we don't waste time on a dead engine. */
        let ml;
        if(window._mlkitDead){
          ml = { avail:false, text:'' };   // pretend unavailable → cloud path drives scanning
        }else{
          ml = await mlkitRead(frame,savedRot(),liveMem);
          /* Track wedging: ML Kit "available" but returning empty/no-text repeatedly
             means it has stalled. After ~8 empty reads in a row, mark it dead and
             switch to cloud for the rest of the session. */
          if(ml.avail && !ml.text){
            window._mlEmpty = (window._mlEmpty||0) + 1;
            /* Do NOT permanently kill ML Kit — empty reads on a glossy/angled
               label are normal, and cloud already backs up per frame. Keeping ML
               Kit primary means the status stays on-device instead of flipping to
               [cloud]. A genuinely wedged plugin is handled by mlkitRead's timeout
               + the watchdog (which reloads after repeated stalls). */
          }else if(ml.text){
            window._mlEmpty = 0;
          }
        }
        window._ocrDebug = { engine: window._mlkitDead ? 'cloud' : (ml.avail ? 'mlkit' : 'mlkit-OFF'), err: ml.err||'', read: (ml.text||'').slice(0,15) };
        if(ml.avail){
          src='mlkit';
          if(ml.err) engineErr='mlkit:'+ml.err;
          if(ml.text){
            window._mlGoodAt = performance.now();   // ML Kit is producing reads — keep cloud away
            liveMem.lastText=ml.text;
            /* For high volume: do NOT build thumb/photo on every text frame.
               The image is built ONCE when GREEN fires (at capture below). This
               avoids thousands of needless canvas encodes over a long session. */
          }
        }else{
          engineErr='mlkit-unavailable';
        }

        /* CLOUD OCR — primary engine when ML Kit is OFF (native plugin missing),
           fallback otherwise. When ML Kit is unavailable we rely on cloud entirely,
           so run it whenever we don't yet have a code (throttled to respect the
           rate limit). When ML Kit works, cloud stays a rare fallback. */
        const now0=performance.now();
        const mlkitOff = !ml.avail;
        /* When ML Kit is ON, it is the primary engine. Cloud is only a QUIET backup
           used if ML Kit hasn't produced a confident read for a little while — and we
           do NOT flip the status to "cloud", so the user keeps seeing the on-device
           state. When ML Kit is OFF, cloud drives scanning and we show its status. */
        const needCloud = mlkitOff
            ? (!window._lastScanCode)                       // ML Kit off → cloud drives scanning
            : (memConfidence(liveMem)==='RED' && (now0-(window._mlGoodAt||0))>1500); // ML Kit on → only if it's been struggling >1.5s
        if(navigator.onLine && needCloud
           && now0-lastCloudAt>=CLOUD_MIN_GAP && now0>=cloudCooldownUntil){
          lastCloudAt=now0;
          /* only show the cloud message when ML Kit is actually OFF — otherwise stay quiet */
          if(mlkitOff && !window._lastScanCode) setStatus('scan','🔄 Reading label (cloud)…');
          const cr=await Promise.race([cloudOcr(frame),new Promise(r=>setTimeout(()=>r({err:'timeout'}),8000))]);
          if(cr.err){
            if(/rate limit|E553/i.test(cr.err)) cloudCooldownUntil=performance.now()+125000;
            /* Only surface a cloud error when ML Kit is OFF and it's a real rate-limit
               (not a harmless timeout). When ML Kit is ON, cloud is just a quiet backup —
               a slow/timed-out cloud call should NEVER show an error or stop scanning. */
            if(mlkitOff && !window._lastScanCode && /rate limit|E553/i.test(cr.err)){
              try{ setStatus('red','🔴 Cloud limit reached — point at label, on-device still works'); }catch(e){}
            }
          }else if(cr.text){
            src=(src==='mlkit')?'mlkit→cloud':'cloud';
            window._lastScanSource='cloud';
            const pr=parseP(cr.text,fakeLines(cr.text));
            absorb(liveMem,pr,codeOf(cr.text),'bin');
            absorb(liveMem,pr,codeOf(cr.text),'gray');
            liveMem.lastText=cr.text;
          }
        }

        /* ITEM-CODE-DRIVEN: read the item code + qty. The product NAME comes from NAV. */
        const code = codeOf(liveMem.lastText||'');
        if(code) window._lastScanCode = code;
        let q=memQty(liveMem)??topVote(liveMem);
        /* ready when we have the item code. Qty defaults to 1 if not read
           (most cartons are 1 unit; the user can edit on the save popup).
           Requiring qty too was making it never capture. */
        const haveCode = !!(window._lastScanCode);
        let desired = haveCode ? 'green' : (q!==null) ? 'yellow' : 'red';

        const now=performance.now();
        if(desired!==candState){ candState=desired; candSince=now; }
        const needed = (candState==='green') ? 600 : STABLE_MS;
        if(now-candSince>=needed && shownState!==candState){
          shownState=candState;
          applyLight(shownState, haveCode?('Code '+window._lastScanCode):null, q);
        }
        if(shownState==='green' && haveCode){
          if(q===null) q=1;   /* default qty to 1 when not detected */
          /* Code detected — but DO NOT auto-open the save popup. Nothing is captured
             or saved until the auditor taps "Capture" (which opens the popup) and then
             "Save". This prevents any accidental save. Keep scanning meanwhile. */
          ocrBusy=false;
          return;
        }
      }
    }catch(e){/* status hidden */;}
    ocrBusy=false;
    /* Pace the loop so the phone doesn't overheat or choke after many scans.
       Weak phones get a longer gap to keep the main thread responsive. */
    await sleep(lowEndDevice() ? 600 : 400);
  }
}

/* paint the smoothed light onto the camera + status text */
function applyLight(state,it,q){
  /* DIAGNOSTIC: show what the OCR engine is doing, so we can see why it's not
     reading. Shows the engine source and a snippet of what it last read. */
  const dbg = window._ocrDebug || {};
  const engineInfo = dbg.engine ? (' ['+dbg.engine+(dbg.err?' err:'+dbg.err:'')+']') : '';
  if(state==='green'){
    setStatus('green','🟢 Item code + Qty captured');
  }else if(state==='yellow'){
    /* 'it' carries the code label when present */
    const haveCode = it && /code/i.test(it);
    const have = haveCode ? 'Item code ✓ — need Qty (NUMBER OF COMMODITY)'
               : (q!==null ? 'Qty ✓ — need ITEM CODE' : 'Reading…');
    setStatus('scanYellow','🟡 '+have+engineInfo);
  }else{
    setStatus('red','🔴 Point at the label'+engineInfo);
  }
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

/* ═══ SAVE POPUP — "Save to Inward/Outward? Yes / No" ═══ */
let lastThumb=null, lastPhoto=null;
let pendingSave=null;     // {model, qtyPerBox, thumb, photo}

/* Item-code-driven popup: resolve the real name + inventory from NAV, then show it. */
function openSavePopupByCode(code, qty, thumb, photo){
  /* FAST PATH: no NAV lookup here. Just show the item code + qty so the popup
     appears instantly. The product name + inventory are fetched by the BACKEND
     when the scan is saved (and shown later in Total Audit). */
  try{ showTypeCodeButton(false); }catch(e){}   // a code was found → hide manual button
  window._lastScanCode = code;
  openSavePopup(code, qty, thumb, photo, code);
}

function openSavePopup(model,qty,thumb,photo,itemCode,inventory,found){
  const code = itemCode || window._lastScanCode || '';
  pendingSave={ model:model, itemCode:code, qtyPerBox:qty,
                thumb:thumb||lastThumb, photo:photo||lastPhoto||thumb||lastThumb };
  const dir = view==='outward' ? 'Outward' : 'Inward';
  $('popTitle').textContent='Save to '+dir+'?';
  /* Show the ITEM CODE prominently. The product name + inventory are looked up by
     the system when saved, then shown in Total Audit. */
  $('popModel').innerHTML = code
    ? '<span style="color:var(--brand);font-weight:800;font-size:20px;">Item code: '+esc(code)+'</span>'
      + '<div style="color:var(--muted);font-size:12px;margin-top:3px;">Product name &amp; inventory are added from the system on save</div>'
    : esc(model||'');
  $('popQtyInput').value = qty;
  $('popBoxesInput').value = 1;
  updatePopTotal();
  const pimg=$('popImg');
  if(pendingSave.photo){
    pimg.src=pendingSave.photo; pimg.classList.remove('hidden');
    pimg.style.cursor='zoom-in';
    pimg.onclick=()=>{ $('lightboxImg').src=pendingSave.photo; $('lightbox').classList.add('show'); };
  } else pimg.classList.add('hidden');
  $('savePopup').classList.add('show');
  /* Arm the Save button briefly: the popup appears right where the auditor is
     tapping, so a stray tap could land on "Save" and confirm instantly. Disable
     it for a moment so nothing saves without a deliberate tap. */
  try{ const _y=$('popYes'); if(_y){ _y.disabled=true; _y.style.opacity='0.5';
    setTimeout(()=>{ _y.disabled=false; _y.style.opacity=''; }, 700); } }catch(e){}
}
function updatePopTotal(){
  const q=parseInt($('popQtyInput').value,10)||0;
  const b=parseInt($('popBoxesInput').value,10)||0;
  const dir = view==='outward' ? 'Outward' : 'Inward';
  $('popTotal').textContent='Total: '+(q*b)+' units'+(dir==='Outward'?'  (stored as −'+(q*b)+')':'');
}
function closeSavePopup(){ $('savePopup').classList.remove('show'); }

function confirmSaveYes(){
  if(!pendingSave)return;
  const dir = view==='outward' ? 'OUT' : 'IN';
  const qtyPerBox=parseInt($('popQtyInput').value,10);
  const boxes=parseInt($('popBoxesInput').value,10);
  if(!Number.isInteger(qtyPerBox)||qtyPerBox<=0){toast('Enter a valid qty');return;}
  if(!Number.isInteger(boxes)||boxes<=0){toast('Enter number of boxes');return;}
  saveRow(dir, pendingSave.model, qtyPerBox, boxes, 'GREEN', pendingSave.thumb, pendingSave.photo, pendingSave.itemCode);
  pendingSave=null;
  /* clear the scan state so the next scan starts fresh */
  window._lastScanCode=null; window._lastScanName=null; window._lastScanInventory=null;
  closeSavePopup();
  setStatus('idle','Saved ✓ — tap “Scan next” when ready');
  $('rescanBar').classList.remove('hidden');
}
function confirmSaveNo(){
  pendingSave=null;
  window._lastScanCode=null; window._lastScanName=null; window._lastScanInventory=null;
  closeSavePopup();
  startScan();
}

async function saveRow(dir,model,qtyPerBox,boxes,status,thumb,photo,itemCode){
  const code = itemCode || window._lastScanCode || null;
  const total = Math.abs(qtyPerBox)*Math.abs(boxes);
  const signedTotal = dir==='OUT' ? -total : total;
  const localId = ++seq;
  const row = { id:localId, direction:dir, model, itemCode:code,
    qtyPerBox:Math.abs(qtyPerBox), boxes:Math.abs(boxes),
    qty:signedTotal, status, thumb:thumb||lastThumb, photo:photo||lastPhoto||thumb||lastThumb, at:new Date() };
  rows.unshift(row);
  /* MEMORY GUARD: the full photo is saved on the SERVER, so we don't need to keep
     every high-res photo in phone memory. Keep the full photo for only the most
     recent few rows; older rows fall back to their small thumbnail. This prevents
     the phone slowing down / not reading after many scans (memory was filling up). */
  let fullKept=0;
  for(const r of rows){
    if(r.photo && r.photo!==r.thumb){
      fullKept++;
      if(fullKept>6){ r.photo=r.thumb; }
    }
  }
  renderList();
  try{
    /* Use storeApiFetch — EXACTLY the working apiRequest pattern (token header,
       ?company=, X-Company). This is how every working module saves. */
    const resp = await storeApiFetch('/api/store/scan', {
      method:'POST',
      body: JSON.stringify({
        modelName: model,
        qty: Math.abs(qtyPerBox),
        boxes: Math.abs(boxes),
        direction: dir,
        itemCode: code,
        brand:(typeof detectBrand==='function'? detectBrand(model):null),
        scanStatus: status||'GREEN',
        ocrSource:(window._lastScanSource||'mlkit'),
        ocrRawText:(window._lastScanRaw||null),
        photoData:(photo||thumb||null),
        capturedAt: new Date().toISOString(),
      }),
    });
    if(!resp.ok){
      /* surface the REAL reason so we can fix it, instead of a generic message */
      let detail='';
      try{ const j=await resp.json(); detail=j.error||''; }catch(_){ try{ detail=(await resp.text()).slice(0,80); }catch(__){} }
      const why = resp.status===401 ? 'not logged in (401)'
                : resp.status===403 ? 'no permission for this role (403)'
                : resp.status===404 ? 'route not found (404) — server.js mount missing?'
                : resp.status===500 ? ('server error (500)'+(detail?': '+detail:'')+' — table created?')
                : ('HTTP '+resp.status+(detail?': '+detail:''));
      throw new Error(why);
    }
    const saved = await resp.json();
    if(saved&&saved.id) row.serverId=saved.id;
    /* the backend looked up the real product NAME + INVENTORY from the system —
       fill them into the row automatically (no refresh needed) */
    if(saved){
      if(saved.modelName) row.model=saved.modelName;
      if(saved.inventoryQty!=null) row.inventoryQty=saved.inventoryQty;
      renderList();
    }
    toast('✔ Saved to '+(dir==='IN'?'Inward':'Outward')+' ('+total+' units)');
  }catch(e){
    row.unsynced=true; renderList();
    /* show the actual reason in the toast AND keep it on the debug line */
    const msg=(e&&e.message)||'network error';
    toast('⚠ NOT saved to DB — '+msg);
    if($('debug')) $('debug').textContent='save failed: '+msg;
    console.error('[store save failed]', e);
  }
}

/* ═══ Manual capture (single shot, cloud-first) — opens popup if both found ═══ */
async function manualCapture(){
  const frame=grabFrame();
  if(!frame){toast('Camera not ready');return;}
  scanning=false; paused=true;
  setStatus('scan','📸 reading carefully…');
  const thumb=toThumb(frame,520); lastThumb=thumb;
  const photo=toCropPhoto(frame,560); lastPhoto=photo;   // cropped to scan box — smaller
  const mem=newMem();

  /* STRONG read: ML Kit at several rotations (white stickers / printed cartons are often
     photographed at an angle). Take the best. Then cloud as an extra confirm. */
  if(mlkitPlugin()){
    for(const r of [0,90,270,180]){
      const ml=await mlkitRead(frame,r,mem);
      if(ml.text){mem.lastText=ml.text;mem.thumb=thumb;}
      if(memConfidence(mem)==='GREEN'){rememberRot(r);break;}   // got it — stop early
      if(r===0 && memItemAny(mem)) {rememberRot(0);}            // 0° worked enough
    }
    /* If the raw frame didn't reach GREEN, retry on the ENHANCED (sharpened,
       contrast-stretched) image — this is what rescues blurry / glossy / glare
       labels that the raw frame can't read. */
    if(memConfidence(mem)!=='GREEN'){
      const enh=enhanceForOcr(frame);
      if(enh){
        for(const r of [0,90,270]){
          const ml=await mlkitRead(enh,r,mem);
          if(ml.text){mem.lastText=ml.text;}
          if(memConfidence(mem)==='GREEN'){rememberRot(r);break;}
        }
      }
    }
  }
  /* cloud confirm if still not GREEN — try enhanced image for cloud too */
  if(navigator.onLine && memConfidence(mem)!=='GREEN'){
    const cr=await cloudOcr(frame);
    if(!cr.err&&cr.text){const pr=parseP(cr.text,fakeLines(cr.text));absorb(mem,pr,codeOf(cr.text),'bin');absorb(mem,pr,codeOf(cr.text),'gray');mem.lastText=cr.text;mem.thumb=thumb;}
    if(memConfidence(mem)!=='GREEN'){
      const enh=enhanceForOcr(frame);
      const cr2=enh?await cloudOcr(enh):{err:'no-enh'};
      if(!cr2.err&&cr2.text){const pr=parseP(cr2.text,fakeLines(cr2.text));absorb(mem,pr,codeOf(cr2.text),'bin');absorb(mem,pr,codeOf(cr2.text),'gray');mem.lastText=cr2.text;}
    }
  }

  /* ITEM-CODE-DRIVEN: Capture looks for the item CODE (qty defaults to 1 if not
     read). The product name comes from NAV on save. */
  const code = codeOf(mem.lastText||'') || window._lastScanCode;
  if(code) window._lastScanCode = code;
  let qty = memQty(mem) ?? topVote(mem);
  if(code){
    if(qty===null) qty=1;   /* default qty to 1 when not detected */
    window._lastScanRaw = mem.lastText||null;
    openSavePopupByCode(code, qty, thumb, photo);
  }else{
    /* OCR couldn't extract a code. Do NOT force a type-in dialog (it interrupts fast
       scanning). Instead show a gentle status with a tap-to-type option, and resume
       live scanning so pointing again / moving closer can still auto-read. */
    window._lastScanRaw = mem.lastText||null;
    window._pendingManualThumb = thumb;
    window._pendingManualPhoto = photo;
    window._pendingManualQty = (qty===null?1:qty);
    if(qty!==null){
      setStatus('scanYellow','🟡 Qty ✓ — point at the ITEM CODE (or tap “Type code”)');
    }else{
      setStatus('red','🔴 Couldn’t read — move closer/steadier (or tap “Type code”)');
    }
    showTypeCodeButton(true);
    startScan();   // keep scanning — a better angle may auto-read
  }
}

/* Show / hide a small "Type code" button so manual entry is OPT-IN (no interrupting
   popup). Tapping it opens the type-in prompt only when the user chooses to. */
function showTypeCodeButton(show){
  /* Manual typing disabled — auto-scan only (per requirement). Never create the
     button or prompt; remove any leftover so it can't linger over the Inward or
     Pickout camera (the Pickout wrap also has class .camera-wrap). */
  const btn = document.getElementById('typeCodeBtn');
  if(btn) btn.remove();
}

/* ═══ Lists — proper data table matching the original ═══ */
function renderList(){
  const dir = view==='outward'?'OUT':'IN';
  let list=rows.filter(r=>r.direction===dir);
  /* sort by capture date — direction toggled by clicking the column header */
  const dsc = (window._listDateAsc !== true);   // default: newest first (desc)
  list.sort((a,b)=> dsc ? (new Date(b.at)-new Date(a.at)) : (new Date(a.at)-new Date(b.at)));
  /* apply the inward/outward search box (item name OR item code) */
  const lq = ($('listSearch') && $('listSearch').value || '').trim().toLowerCase();
  if(lq){
    list = list.filter(r =>
      (r.model||'').toLowerCase().includes(lq) ||
      (r.itemCode||'').toLowerCase().includes(lq)
    );
  }
  /* Inward date filter (from/to as YYYY-MM-DD) — set by the date bar in the Inward tab */
  if(window._inFrom || window._inTo){
    const dOf = d => { const x=new Date(d); return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); };
    list = list.filter(r => { const d=dOf(r.at); return (!window._inFrom || d>=window._inFrom) && (!window._inTo || d<=window._inTo); });
  }
  $('listCount').textContent=list.length+' item'+(list.length===1?'':'s');
  $('listEmpty').classList.toggle('hidden', list.length>0);
  const isOut = dir==='OUT';
  $('listBody').innerHTML=list.map((r,i)=>{
    const qpb = r.qtyPerBox!=null ? r.qtyPerBox : Math.abs(r.qty);
    const boxes = r.boxes!=null ? r.boxes : 1;
    const total = r.qty;   // signed grand total
    /* In Outward, qty/box is editable (partial outwards) → shows an edit pencil */
    const qtyCell = isOut
      ? `<td class="num big"><span class="editqty" data-edit="${r.id}">${qpb} ✏️</span></td>`
      : `<td class="num big">${qpb}</td>`;
    return `<tr>
      <td>${i+1}</td>
      <td><b>${esc(r.itemCode||'—')}</b></td>
      <td>${esc(r.model)}</td>
      ${qtyCell}
      <td class="num big">${boxes}</td>
      <td class="num big ${total<0?'neg':'pos'}"><b>${total}</b></td>
      <td>${fmtDateTime(r.at)}</td>
      <td><span class="sdot ${r.status==='GREEN'?'green':'red'}" title="${r.status==='GREEN'?'Auto-read':'Confirmed'}"></span></td>
      <td>${r.thumb?`<img class="thumb" src="${r.thumb}" data-zoom="${r.id}" alt="scan">`:'—'}</td>
      <td><button class="delbtn" data-del="${r.id}">✕</button></td>
    </tr>`;
  }).join('');
  $('listBody').querySelectorAll('[data-del]').forEach(b=>b.onclick=async ()=>{
    const r=rows.find(x=>x.id==b.dataset.del); if(!r)return;
    /* remove from screen immediately */
    rows=rows.filter(x=>x.id!=b.dataset.del); renderList();
    /* delete from the database (soft-delete) using the server id */
    if(r.serverId){
      try{
        const resp=await storeApiFetch('/api/store/scan/'+r.serverId,{method:'DELETE'});
        if(!resp.ok) throw new Error('HTTP '+resp.status);
        toast('Deleted');
      }catch(e){ toast('⚠ Removed on screen but not in database — check connection'); }
    }
  });
  $('listBody').querySelectorAll('[data-zoom]').forEach(img=>img.onclick=()=>{
    const r=rows.find(x=>x.id==img.dataset.zoom);
    $('lightboxImg').src=(r&&r.photo)?r.photo:img.src;   // open HIGH-RES photo, not the tiny thumb
    $('lightbox').classList.add('show');
  });
  /* Outward qty edit — partial outwards → updates the database */
  $('listBody').querySelectorAll('[data-edit]').forEach(el=>el.onclick=async ()=>{
    const r=rows.find(x=>x.id==el.dataset.edit); if(!r)return;
    const cur=r.qtyPerBox!=null?r.qtyPerBox:Math.abs(r.qty);
    const v=prompt('Edit quantity per box (for partial outward):',cur);
    if(v===null)return;
    const nq=parseInt(v,10);
    if(!Number.isInteger(nq)||nq<=0){toast('Invalid qty');return;}
    const boxes=r.boxes!=null?r.boxes:1;
    r.qtyPerBox=nq;
    r.qty = -(nq*boxes);   // outward stays negative
    renderList();
    /* persist the edit to the database */
    if(r.serverId){
      try{
        const resp=await storeApiFetch('/api/store/scan/'+r.serverId,{
          method:'PUT',
          body: JSON.stringify({ qty:nq, boxes:boxes }),
        });
        if(!resp.ok) throw new Error('HTTP '+resp.status);
        toast('Updated to '+nq+'/box × '+boxes+' = '+(nq*boxes));
      }catch(e){ toast('⚠ Changed on screen but not in database — check connection'); }
    }else{
      toast('Updated to '+nq+'/box × '+boxes+' = '+(nq*boxes));
    }
  });
}
async function renderTotal(){
  /* Pull the totals from the DATABASE with the active search + date filters, so the
     numbers reflect all saved scans (not just what's loaded on this screen). */
  const q = ($('taSearch') && $('taSearch').value || '').trim();
  const mode = ($('taDateMode') && $('taDateMode').value) || 'all';
  const params = new URLSearchParams();
  if(q) params.set('q', q);
  if(mode==='single' && $('taDate').value) params.set('date', $('taDate').value);
  if(mode==='range'){ if($('taFrom').value) params.set('from', $('taFrom').value); if($('taTo').value) params.set('to', $('taTo').value); }

  let list=null;
  try{
    const resp = await storeApiFetch('/api/store/scan/total'+(params.toString()?('?'+params.toString()):''), {});
    if(resp.ok){
      const data = await resp.json();
      if(Array.isArray(data)){
        list = data.map(d=>({itemCode:d.ItemCode||'', model:d.ModelName,
          inventoryQty:(d.InventoryQty!=null?Math.round(d.InventoryQty):null),
          inwardQty:Math.round(d.InwardQty||0), outwardQty:Math.round(d.OutwardQty||0), totalQty:Math.round(d.NetQty||0),
          lastAt:(d.LastScan||null)}));
      }
    }
  }catch(e){ /* offline → fall back to local rows below */ }

  if(list===null){
    /* fallback: compute from rows loaded on screen, applying the same filters locally */
    const m=new Map();
    for(const r of rows){
      if(q && !((r.model||'').toLowerCase().includes(q.toLowerCase()) || (r.itemCode||'').toLowerCase().includes(q.toLowerCase()))) continue;
      const d=new Date(r.at);
      if(mode==='single' && $('taDate').value){ if(d.toISOString().slice(0,10)!==$('taDate').value) continue; }
      if(mode==='range'){
        if($('taFrom').value && d.toISOString().slice(0,10) < $('taFrom').value) continue;
        if($('taTo').value && d.toISOString().slice(0,10) > $('taTo').value) continue;
      }
      const key=r.itemCode||r.model;
      const t=m.get(key)||{itemCode:r.itemCode||'',model:r.model,inventoryQty:null,inwardQty:0,outwardQty:0,totalQty:0,lastAt:null};
      if(r.direction==='IN')t.inwardQty+=r.qty; else t.outwardQty+=r.qty;
      t.totalQty+=r.qty;
      if(!t.lastAt || new Date(r.at) > new Date(t.lastAt)) t.lastAt = r.at;   // keep latest capture
      m.set(key,t);
    }
    list=[...m.values()];
  }
  /* sort: by capture date if the user clicked the date header, else by model name */
  if(window._totalSortByDate){
    const dsc = (window._totalDateAsc !== true);   // default newest first
    list.sort((a,b)=> dsc ? (new Date(b.lastAt||0)-new Date(a.lastAt||0)) : (new Date(a.lastAt||0)-new Date(b.lastAt||0)));
  }else{
    list.sort((a,b)=>(a.model||'').localeCompare(b.model||''));
  }

  $('totalCount').textContent=list.length+' model'+(list.length===1?'':'s');
  $('totalEmpty').classList.toggle('hidden', list.length>0);
  window._lastTotalList = list;   /* keep for Excel export */
  $('totalBody').innerHTML=list.map((r,i)=>{
    /* Colour-code the inward qty against inventory:
       green  = inward equals inventory
       yellow = inward is less than inventory
       red    = inward exceeds inventory  */
    let inwardCls='num big';
    if(r.inventoryQty!=null){
      if(r.inwardQty===r.inventoryQty) inwardCls='num big qtymatch';
      else if(r.inwardQty < r.inventoryQty) inwardCls='num big qtyunder';
      else inwardCls='num big qtyover';
    }
    return `
    <tr>
      <td>${i+1}</td>
      <td><b>${esc(r.itemCode||'—')}</b></td>
      <td>${esc(r.model)}</td>
      <td class="num big" style="color:var(--brand);">${r.inventoryQty!=null?r.inventoryQty:'—'}</td>
      <td class="${inwardCls}">${r.inwardQty}</td>
      <td class="num big neg">${r.outwardQty}</td>
      <td class="num big"><b>${r.totalQty}</b></td>
      <td>${r.lastAt?fmtDateTime(r.lastAt):'—'}</td>
      <td>${r.totalQty===0?'<span class="badge ok">Balanced</span>'
          :`<span class="badge warn">${r.totalQty>0?'In stock':'Short!'}</span>`}</td>
    </tr>`;}).join('');
}
function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

/* Download the Total Audit as a real .xlsx — generated by the BACKEND (reliable,
   no CDN). We fetch the file with auth, then save/share it (APK) or download (browser)
   using the same proven pattern as other ONE App modules. */
async function exportTotalToExcel(){
  const list = window._lastTotalList || [];
  if(!list.length){ if(typeof toast==='function') toast('Nothing to export yet'); return; }
  if(typeof toast==='function') toast('Preparing Excel…');

  /* mirror the current Total Audit filters onto the request */
  const q = ($('taSearch') && $('taSearch').value || '').trim();
  const mode = ($('taDateMode') && $('taDateMode').value) || 'all';
  const params = new URLSearchParams();
  if(q) params.set('q', q);
  if(mode==='single' && $('taDate') && $('taDate').value) params.set('date', $('taDate').value);
  if(mode==='range'){ if($('taFrom')&&$('taFrom').value) params.set('from',$('taFrom').value); if($('taTo')&&$('taTo').value) params.set('to',$('taTo').value); }

  try{
    /* use the same storeApiFetch helper as every other call (handles token+company) */
    const path = '/api/store/scan/total-excel' + (params.toString() ? ('?'+params.toString()) : '');
    const resp = await storeApiFetch(path, {});
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const blob = await resp.blob();
    const fname = 'Total_Audit_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.xlsx';
    await storeSaveAndShare(blob, fname, { title:'Total Audit', dialogTitle:'Share Total Audit via…' });
    if(typeof toast==='function') toast('Excel ready: '+fname);
  }catch(e){
    if(typeof toast==='function') toast('Excel failed: '+(e.message||e));
  }
}

/* Save & share — APK: write to Cache + native Share Sheet. Browser: <a download>.
   Inlined copy of common.js nativeSaveAndShare so it works on this page regardless. */
async function storeSaveAndShare(blob, filename, opts){
  opts = opts || {};
  const inCap = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if(inCap){
    try{
      const Filesystem = window.Capacitor.Plugins.Filesystem;
      const Share      = window.Capacitor.Plugins.Share;
      const base64 = await new Promise((resolve,reject)=>{
        const r=new FileReader();
        r.onload=()=>resolve(String(r.result).split(',')[1]||'');
        r.onerror=()=>reject(r.error);
        r.readAsDataURL(blob);
      });
      const w = await Filesystem.writeFile({ path:filename, data:base64, directory:'CACHE', recursive:true });
      await Share.share({ title:opts.title||filename, text:opts.text||filename, url:w.uri,
                          dialogTitle:opts.dialogTitle||'Share file via…' });
      return { ok:true, native:true };
    }catch(err){
      const msg=String(err && err.message || err);
      if(/cancel/i.test(msg)) return { ok:false, cancelled:true };
    }
  }
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},1000);
  return { ok:true, native:false };
}
function fmtTime(d){return new Date(d).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function fmtDateTime(d){const x=new Date(d);return x.toLocaleDateString([],{day:'2-digit',month:'short'})+' '+x.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}

/* ═══ Tabs ═══ */
function switchView(v){
  view=v;
  $('tabIn').className='tab in'+(v==='inward'?' active':'');
  $('tabOut').className='tab out'+(v==='outward'?' active':'');
  $('tabTotal').className='tab'+(v==='total'?' active':'');
  closeSavePopup();
  if(v==='total'){
    document.body.classList.remove('io-layout');
    $('scanCard').classList.add('hidden'); $('listCard').classList.add('hidden'); $('totalCard').classList.remove('hidden');
    renderTotal();
    stopScan();
  }else{
    document.body.classList.add('io-layout');
    $('scanCard').classList.remove('hidden'); $('listCard').classList.remove('hidden'); $('totalCard').classList.add('hidden');
    $('scanTitle').textContent='Scan box — '+(v==='inward'?'Inward':'Outward');
    $('listTitle').textContent=(v==='inward'?'Inward':'Outward')+' entries';
    renderList();
    $('rescanBar').classList.add('hidden');
    startScan();
  }
}

/* ═══ Wire events ═══ */
$('tabIn').onclick=()=>switchView('inward');
$('tabOut').onclick=()=>switchView('outward');
$('tabTotal').onclick=()=>switchView('total');

/* ═══ Hamburger navigation drawer ═══ */
function openDrawer(){ $('navDrawer').classList.add('show'); $('navOverlay').classList.add('show'); }
function closeDrawer(){ $('navDrawer').classList.remove('show'); $('navOverlay').classList.remove('show'); }
(function wireDrawer(){
  const ham=$('hamBtn'), ov=$('navOverlay'), cl=$('navClose');
  if(ham) ham.onclick=openDrawer;
  if(ov)  ov.onclick=closeDrawer;
  if(cl)  cl.onclick=closeDrawer;
  const retailer=$('navRetailer'); if(retailer) retailer.onclick=()=>{ closeDrawer(); switchView('inward'); };
  /* Sign out — clear the token like the rest of ONE App and go to login */
  const so=$('navSignout'); if(so) so.onclick=()=>{
    try{ localStorage.removeItem('nav_token'); localStorage.removeItem('nav_user');
         sessionStorage.removeItem('nav_token'); sessionStorage.removeItem('nav_user');
         sessionStorage.removeItem('nav_company'); }catch(e){}
    window.location.href='/index.html';
  };
  const si=$('navSignin'); if(si) si.onclick=()=>{ window.location.href='/index.html'; };
  /* Show Sign in only when logged out; Sign out only when logged in */
  const hasToken = !!(localStorage.getItem('nav_token')||sessionStorage.getItem('nav_token'));
  if(hasToken){ $('navSignout')&&$('navSignout').classList.remove('hidden'); $('navSignin')&&$('navSignin').classList.add('hidden'); }
  else        { $('navSignout')&&$('navSignout').classList.add('hidden');    $('navSignin')&&$('navSignin').classList.remove('hidden'); }

  /* Cross-module links: the store drawer only lists "Store Retailer Auditing" +
     "Sign out". Users who have OTHER modules (Rupali 'mis store', admins, heads)
     land here from the shared sidebar and would be stranded with no way back to
     Budget/HRMS. Inject links to their other modules — pure store/auditor/delivery
     users (e.g. a colleague 'store electrical') are NOT multi-module, so their drawer is
     unchanged. Injected in JS so the store home.html stays untouched. */
  (function addCrossLinks(){
    if(!hasToken) return;
    const r = userRole();
    const multi = /\bmis\b/.test(r) || r==='admin' || r==='operation head' || r==='director' || /\bhead\b/.test(r);
    if(!multi) return;
    const anchor = $('navSignout');
    const nav = anchor && anchor.parentNode;
    if(!nav) return;
    const links = [
      { ico:'📊', label:'Budget vs Actual', href:'/modules/sales/budget-actual.html' },
      { ico:'🏠', label:'ONE App (HRMS)',   href:'/modules/hr/home.html' },
      { ico:'🔁', label:'Switch Company',    href:'/select-company.html' },
    ];
    links.forEach(l=>{
      const a=document.createElement('a');
      a.className='nav-link';
      a.innerHTML='<span class="nav-ico">'+l.ico+'</span> '+l.label;
      a.onclick=()=>{ closeDrawer(); window.location.href=l.href; };
      nav.insertBefore(a, anchor);
    });
  })();
})();

/* ═══ Pull-to-refresh (swipe down at top to refresh) ═══ */
(function wirePTR(){
  const ind=$('ptrIndicator'), txt=$('ptrText');
  if(!ind) return;
  let startY=0, pulling=false, dist=0;
  const THRESH=70;
  window.addEventListener('touchstart',(e)=>{
    if(window.scrollY<=0 && e.touches.length===1){ startY=e.touches[0].clientY; pulling=true; dist=0; }
    else pulling=false;
  },{passive:true});
  window.addEventListener('touchmove',(e)=>{
    if(!pulling) return;
    dist=e.touches[0].clientY-startY;
    if(dist>0 && window.scrollY<=0){
      ind.classList.add('show');
      txt.textContent = dist>THRESH ? '↑ Release to refresh' : '↓ Pull to refresh';
    }
  },{passive:true});
  window.addEventListener('touchend',()=>{
    if(!pulling){ return; }
    pulling=false;
    if(dist>THRESH){
      ind.classList.add('spin'); txt.textContent='↻ Refreshing…';
      doRefresh().finally(()=>{ ind.classList.remove('spin'); ind.classList.remove('show'); });
    } else {
      ind.classList.remove('show');
    }
    dist=0;
  });
})();
/* Refresh = reload data from the DB for the current view (no full page reload).
   Capped at 8 seconds so a slow connection can't make it spin for minutes. */
async function doRefresh(){
  try{
    const timeout = new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')), 8000));
    await Promise.race([loadFromDB(), timeout]);
    if(view==='total') renderTotal(); else renderList();
    toast('Refreshed');
  }catch(e){ toast('Connection slow — try again'); }
}

$('captureBtn').onclick=manualCapture;
/* TAP-TO-FOCUS: tapping the camera view nudges the lens to refocus on that spot.
   Helps when the preview is blurry — tap the label to sharpen it. Not all phones
   support point-of-interest focus, so we also re-assert continuous autofocus. */
(function(){
  const v=$('video'); if(!v) return;
  v.addEventListener('click', async (ev)=>{
    try{
      const tr = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
      if(!tr || !tr.getCapabilities) return;
      const caps = tr.getCapabilities();
      const adv = [];
      /* point-of-interest focus if supported */
      if(caps.pointsOfInterest){
        const rect = v.getBoundingClientRect();
        const px = (ev.clientX-rect.left)/rect.width;
        const py = (ev.clientY-rect.top)/rect.height;
        adv.push({ pointsOfInterest:[{x:Math.max(0,Math.min(1,px)), y:Math.max(0,Math.min(1,py))}] });
      }
      /* re-trigger autofocus: flip to single then back to continuous */
      if(caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode:'continuous' });
      if(adv.length){ await tr.applyConstraints({ advanced: adv }); if(typeof toast==='function') toast('Focusing…'); }
    }catch(e){}
  });
})();
$('refreshBtn').onclick=refreshScreen;
$('flipBtn').onclick=async()=>{facing=facing==='environment'?'user':'environment';await startCamera();};

/* zoom slider + buttons */
$('zoomSlider').oninput=e=>applyZoom(parseFloat(e.target.value));
$('zoomIn').onclick=()=>{const s=$('zoomSlider');const v=Math.min(parseFloat(s.max),parseFloat(s.value)+(parseFloat(s.step)||0.2)*2);s.value=v;applyZoom(v);};
$('zoomOut').onclick=()=>{const s=$('zoomSlider');const v=Math.max(parseFloat(s.min),parseFloat(s.value)-(parseFloat(s.step)||0.2)*2);s.value=v;applyZoom(v);};

/* pinch-to-zoom on the camera */
(function(){
  let pinchStart=0, zoomStart=1;
  const cam=$('cam');
  cam.addEventListener('touchstart',ev=>{
    if(ev.touches.length===2){
      pinchStart=Math.hypot(ev.touches[0].clientX-ev.touches[1].clientX, ev.touches[0].clientY-ev.touches[1].clientY);
      zoomStart=parseFloat($('zoomSlider').value);
    }
  },{passive:true});
  cam.addEventListener('touchmove',ev=>{
    if(ev.touches.length===2 && pinchStart){
      const d=Math.hypot(ev.touches[0].clientX-ev.touches[1].clientX, ev.touches[0].clientY-ev.touches[1].clientY);
      const s=$('zoomSlider');
      const range=parseFloat(s.max)-parseFloat(s.min);
      let v=zoomStart + (d/pinchStart - 1)*range*0.6;
      v=Math.max(parseFloat(s.min),Math.min(parseFloat(s.max),v));
      s.value=v; applyZoom(v);
      ev.preventDefault();
    }
  },{passive:false});
  cam.addEventListener('touchend',()=>{pinchStart=0;});
})();
$('torchBtn').onclick=async()=>{
  try{const tr=stream&&stream.getVideoTracks()[0];if(tr&&tr.getCapabilities&&tr.getCapabilities().torch){torchOn=!torchOn;await tr.applyConstraints({advanced:[{torch:torchOn}]});}else toast('Torch not available');}catch(e){toast('Torch not available');}
};

/* Save popup Yes / No */
$('popYes').onclick=confirmSaveYes;
$('popNo').onclick=confirmSaveNo;
$('popQtyInput').oninput=updatePopTotal;
$('popBoxesInput').oninput=updatePopTotal;

/* "Scan next" bar (shown after a Yes-save; user manually starts next) */
$('rescanBtn').onclick=()=>{
  $('rescanBar').classList.add('hidden');
  startScan();
};

/* cloud settings */
/* settings modal removed from UI */

/* auto-recover when returning from background / screen unlock */
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){
    const v=$('video');
    if(!stream || !v.videoWidth || (v.srcObject && v.srcObject.getVideoTracks && !v.srcObject.getVideoTracks()[0].enabled)){
      refreshScreen();
    }
  }
});

/* lightbox: tap image to zoom in/out, X or background to close */
$('lightboxImg').onclick=(e)=>{ e.stopPropagation(); $('lightboxImg').classList.toggle('zoomed'); };
$('lbClose').onclick=()=>{ $('lightbox').classList.remove('show'); $('lightboxImg').classList.remove('zoomed'); };
$('lightbox').onclick=()=>{ $('lightbox').classList.remove('show'); $('lightboxImg').classList.remove('zoomed'); };

/* ═══ Boot ═══ */
async function loadFromDB(){
  try{
    const resp = await storeApiFetch('/api/store/scan/list', {});
    if(!resp.ok){
      if(typeof toast==='function') toast('Could not load saved scans (server '+resp.status+')');
      return;   // keep whatever is on screen; don't wipe it
    }
    const data = await resp.json();
    if(Array.isArray(data)){
      rows = data.map(d=>({ id:d.Id||(++seq), serverId:d.Id, direction:d.Direction, model:d.ModelName, itemCode:d.ItemCode||null,
        inventoryQty:(d.InventoryQty!=null?Math.round(d.InventoryQty):null),
        qtyPerBox: d.QtyPerBox!=null?d.QtyPerBox:Math.abs(d.Qty), boxes: d.Boxes!=null?d.Boxes:1,
        qty:d.Qty, status:d.ScanStatus||'GREEN',
        thumb: d.ImagePath ? ('/'+String(d.ImagePath).replace(/^\/+/,'')) : null,
        photo: d.ImagePath ? ('/'+String(d.ImagePath).replace(/^\/+/,'')) : null,
        at: d.CapturedAt?new Date(d.CapturedAt):new Date(d.CreatedAt||Date.now()) }));
      renderList();
    }
  }catch(e){
    /* network/timeout — DON'T wipe the screen; tell the user to retry */
    if(typeof toast==='function') toast('Connection slow — pull down to refresh');
  }
}

(async function boot(){
  loadKnown();                // restore the learned-products memory

  /* ── Total Audit search + date filter controls ── */
  if($('taDateMode')){
    $('taDateMode').onchange=()=>{
      const mode=$('taDateMode').value;
      $('taDate').classList.toggle('hidden', mode!=='single');
      $('taRangeWrap').classList.toggle('hidden', mode!=='range');
    };
    $('taApply').onclick=()=>renderTotal();
    $('taClear').onclick=()=>{
      $('taSearch').value=''; $('taDateMode').value='all';
      $('taDate').value=''; $('taFrom').value=''; $('taTo').value='';
      $('taDate').classList.add('hidden'); $('taRangeWrap').classList.add('hidden');
      renderTotal();
    };
    /* live search as you type (debounced) */
    let st=null;
    $('taSearch').oninput=()=>{ clearTimeout(st); st=setTimeout(()=>renderTotal(), 300); };
    /* Download the current Total Audit view to Excel (CSV that Excel opens natively). */
    if($('taExcel')) $('taExcel').onclick=()=>exportTotalToExcel();
  }
  /* Inward/Outward search box — filter the list as you type (debounced). */
  if($('listSearch')){
    let lst=null;
    $('listSearch').oninput=()=>{ clearTimeout(lst); lst=setTimeout(()=>renderList(), 200); };
  }
  /* Click the "Capture date & time" header to toggle newest-first / oldest-first. */
  if($('listDateSort')){
    $('listDateSort').onclick=()=>{
      window._listDateAsc = !window._listDateAsc;   // toggle
      const ar=$('listSortArrow'); if(ar) ar.textContent = window._listDateAsc ? '▲' : '▼';
      renderList();
    };
  }
  /* Click the "Last capture date & time" header in Total Audit to sort by date. */
  if($('totalDateSort')){
    $('totalDateSort').onclick=()=>{
      if(!window._totalSortByDate){ window._totalSortByDate=true; window._totalDateAsc=false; }
      else { window._totalDateAsc = !window._totalDateAsc; }
      const ar=$('totalSortArrow'); if(ar) ar.textContent = window._totalDateAsc ? '▲' : '▼';
      renderTotal();
    };
  }
  /* Start the camera IMMEDIATELY — do not wait for the database. A slow DB fetch
     was blocking startup for 1-2 minutes. Camera first, data loads in background. */
  const mlk = mlkitPlugin();
  if(mlk){
    mlkitAvailable=true;
    $('engineStatus').textContent='✅ Ready — ON-DEVICE OCR active';
  }else{
    /* Show WHY ML Kit isn't available, so we can diagnose the APK plugin bridge. */
    mlkitAvailable=false;
    $('engineStatus').textContent='⚠ Cloud OCR mode — '+mlkitDiag();
  }

  /* App starts on the Inward view → enable the desktop side-by-side layout class. */
  document.body.classList.add('io-layout');

  /* Kick off camera right away */
  startCamera().then(ok => { if(ok) startScan(); });

  /* Load saved scans in the BACKGROUND — don't block the camera/UI on it.
     If the connection is slow, the camera still works; data appears when ready. */
  loadFromDB().catch(()=>{});
})();
