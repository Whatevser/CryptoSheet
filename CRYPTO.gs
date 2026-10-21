/**
 * Crypto portfolio for Google Sheets — Binance, KuCoin.
 * Everything goes through your relay (Deno Deploy -> your proxy -> exchange).
 *
 * SETUP (full guide: https://github.com/Whatevser/CryptoSheet#readme)
 *   1. Paste this file into Extensions -> Apps Script, save, reload the sheet.
 *   2. Menu Crypto -> Settings: relay URL + token, exchange API keys (read-only), Save.
 *      Nothing secret lives in this file — everything is stored in your Google user properties.
 *
 * FORMULAS (French locale: ; as separator)
 *   =BINANCE("portfolio")  =KUCOIN("portfolio")
 *        -> Asset | Total | Price USDT | Value USDT   (all wallets summed, sorted by value)
 *   =BINANCE("balances")   -> Asset | Total
 *   =BINANCE("prices")     -> Symbol | Price (ADAUSDT format)
 *   2nd argument "headers: false" drops the header row.
 *
 *   =UAH("USD")    NBU official rate (fiat: USD, EUR, PLN...; daily, via relay)
 *   =UAH("USDT")   WhiteBIT live USDT/UAH (any crypto listed against UAH on WhiteBIT)
 *
 *   =BINANCE_P2P("BUY"; "Monobank"; 20000)     best 20 P2P ads where YOU BUY USDT for UAH (cheapest first)
 *   =BINANCE_P2P("SELL"; "Monobank, PrivatBank"; 20000; "merchant: true, minorders: 100, minrate: 97")
 *        -> Price | Available | Min | Max | Payment | Advertiser | Orders 30d | Completion %
 *        payment: "" = any; names from =BINANCE_P2P_METHODS()
 *        amount:  your trade size in UAH — only ads whose limits accept it (0 = any)
 *        options: fiat (UAH), asset (USDT), rows (20), merchant, minorders, minrate, headers
 *   =BINANCE_P2P_METHODS()                      payment-method names you can filter by
 */

// ============================== SETTINGS ==============================
// All values are edited in Crypto -> Settings and stored in UserProperties. Defaults below.
const SETTINGS = {
  RELAY_URL:       { def: "" },
  RELAY_TOKEN:     { def: "", secret: true },
  MIN_VALUE:       { def: "0" },   // hide coins worth less than this (USDT) in "portfolio"
  REFRESH_MINUTES: { def: "5" },   // 1, 5, 10, 15 or 30
};

function setting_(name) {
  const v = PropertiesService.getUserProperties().getProperty(name);
  return v === null || v === "" ? SETTINGS[name].def : v;
}

// ============================== FORMULAS ==============================

/**
 * Binance: "portfolio", "balances" or "prices".
 * @param {string} operation "portfolio", "balances" or "prices"
 * @param {string} opts Optional, e.g. "headers: false"
 * @customfunction
 */
function BINANCE(operation, opts) { return table_(EX.binance, operation, opts); }

/**
 * KuCoin: "portfolio", "balances" or "prices".
 * @param {string} operation "portfolio", "balances" or "prices"
 * @param {string} opts Optional, e.g. "headers: false"
 * @customfunction
 */
function KUCOIN(operation, opts) { return table_(EX.kucoin, operation, opts); }

/**
 * Price of 1 unit in UAH. Fiat (USD, EUR...) = NBU official rate; crypto (USDT, BTC...) = WhiteBIT live.
 * @param {string} code e.g. "USD", "EUR", "USDT"
 * @customfunction
 */
function UAH(code) {
  const c = String(code || "USD").trim().toUpperCase();
  const nbu = nbuRates_();
  if (nbu[c]) return nbu[c];
  return whitebitUah_(c);
}

/**
 * Binance P2P ads, most profitable first.
 * @param {string} side "BUY" (you buy crypto) or "SELL" (you sell crypto)
 * @param {string} payMethods Comma list like "Monobank, PrivatBank", a range, or "" for any
 * @param {number} amount Your trade size in fiat; only ads that accept it (0 = any)
 * @param {string} opts e.g. "merchant: true, minorders: 100, minrate: 97, rows: 20, fiat: UAH, asset: USDT"
 * @customfunction
 */
function BINANCE_P2P(side, payMethods, amount, opts) { return p2pTable_(side, payMethods, amount, opts); }

/**
 * Payment-method names usable in BINANCE_P2P, for a fiat (default UAH).
 * @param {string} fiat e.g. "UAH"
 * @customfunction
 */
function BINANCE_P2P_METHODS(fiat) { return p2pMethods_(fiat); }

// Refresh twins (the auto-refresh toggles NAME( <-> NAMER( to force recalculation). Don't use directly.
function BINANCER(o, p) { return BINANCE(o, p); }
function KUCOINR(o, p) { return KUCOIN(o, p); }
function UAHR(c) { return UAH(c); }
function BINANCE_P2PR(a, b, c, d) { return BINANCE_P2P(a, b, c, d); }

// ============================== EXCHANGES ==============================

const EX = {
  // ---------- Binance ----------
  binance: {
    name: "Binance",
    keys: [["API Key", "BIN_API_KEY"], ["API Secret", "BIN_API_SECRET"]],

    request(host, path, params, signed, method) {
      let qs = params || "";
      const headers = {};
      if (signed) {
        const [key, secret] = keys_(this);
        qs += (qs ? "&" : "") + "timestamp=" + Date.now() + "&recvWindow=30000";
        qs += "&signature=" + hex_(Utilities.computeHmacSha256Signature(qs, secret));
        headers["X-MBX-APIKEY"] = key;
      }
      const body = fetch_(this.name, host, path + (qs ? "?" + qs : ""), headers, method);
      if (body && body.code && body.code < 0) throw new Error("Binance error " + body.code + ": " + body.msg);
      return body;
    },

    balances() {
      const t = {};
      const H = "api.binance.com";
      for (const b of this.request(H, "/api/v3/account", "omitZeroBalances=true", true).balances || []) add_(t, b.asset, +b.free + +b.locked);
      optional_(this.name, "funding", () => {
        for (const b of this.request(H, "/sapi/v1/asset/get-funding-asset", "", true, "post")) add_(t, b.asset, +b.free + +b.locked + +b.freeze + +b.withdrawing);
      });
      optional_(this.name, "earn flexible", () => {
        for (const r of this.request(H, "/sapi/v1/simple-earn/flexible/position", "size=100", true).rows || []) add_(t, r.asset, +r.totalAmount);
      });
      optional_(this.name, "earn locked", () => {
        for (const r of this.request(H, "/sapi/v1/simple-earn/locked/position", "size=100", true).rows || []) add_(t, r.asset, +r.amount);
      });
      optional_(this.name, "cross margin", () => {
        for (const a of this.request(H, "/sapi/v1/margin/account", "", true).userAssets || []) add_(t, a.asset, +a.netAsset);
      });
      optional_(this.name, "futures", () => {
        for (const a of this.request("fapi.binance.com", "/fapi/v2/account", "", true).assets || []) add_(t, a.asset, +a.walletBalance);
      });
      return rows_(t);
    },

    prices() {
      const p = {};
      for (const x of this.request("api.binance.com", "/api/v3/ticker/price", "", false)) {
        const v = parseFloat(x.price);
        if (v) p[x.symbol] = v;
      }
      return p;
    },
  },

  // ---------- KuCoin ----------
  kucoin: {
    name: "KuCoin",
    keys: [["API Key", "KC_API_KEY"], ["API Secret", "KC_API_SECRET"], ["API Passphrase", "KC_API_PASSPHRASE"]],

    request(path, signed) {
      const headers = {};
      if (signed) {
        const [key, secret, pass] = keys_(this);
        const ts = String(Date.now());
        headers["KC-API-KEY"] = key;
        headers["KC-API-TIMESTAMP"] = ts;
        headers["KC-API-SIGN"] = Utilities.base64Encode(Utilities.computeHmacSha256Signature(ts + "GET" + path, secret));
        headers["KC-API-PASSPHRASE"] = Utilities.base64Encode(Utilities.computeHmacSha256Signature(pass, secret));
        headers["KC-API-KEY-VERSION"] = "2";
      }
      const body = fetch_(this.name, "api.kucoin.com", path, headers);
      if (body.code !== "200000") throw new Error("KuCoin error " + body.code + ": " + (body.msg || ""));
      return body.data;
    },

    balances() {
      const t = {};
      for (const a of this.request("/api/v1/accounts", true)) add_(t, a.currency, +a.balance); // main, trade, trade_hf, margin
      return rows_(t);
    },

    prices() {
      const p = {};
      for (const x of this.request("/api/v1/market/allTickers", false).ticker || []) {
        const v = parseFloat(x.last);
        if (v) p[x.symbol.replace("-", "")] = v;
      }
      return p;
    },
  },
};

// ============================== UAH RATES ==============================

function nbuRates_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("NBU");
  if (hit) return JSON.parse(hit);
  const list = fetch_("NBU", "bank.gov.ua", "/NBUStatService/v1/statdirectory/exchange?json");
  if (!Array.isArray(list)) throw new Error("NBU: unexpected response");
  const rates = {};
  list.forEach((x) => { rates[x.cc] = x.rate; });
  cache.put("NBU", JSON.stringify(rates), 3600); // official rate changes once a day
  return rates;
}

function whitebitUah_(c) {
  const cache = CacheService.getScriptCache();
  const key = "WB_" + c;
  const hit = cache.get(key);
  if (hit) return Number(hit);
  const res = UrlFetchApp.fetch("https://whitebit.com/api/v1/public/ticker?market=" + c + "_UAH", { muteHttpExceptions: true });
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { /* handled below */ }
  const last = body.success && body.result ? parseFloat(body.result.last) : NaN;
  if (!last) throw new Error(c + ": not an NBU currency and no " + c + "_UAH market on WhiteBIT.");
  cache.put(key, String(last), 55);
  return last;
}

// ============================== BINANCE P2P ==============================

const P2P_HOST = "p2p.binance.com";

function p2pOpts_(opts) {
  const o = {};
  String(opts || "").split(",").forEach((kv) => {
    const m = kv.split(":");
    if (m.length === 2) o[m[0].trim().toLowerCase()] = m[1].trim();
  });
  return o;
}

function p2pSearch_(body) {
  const res = fetch_("Binance P2P", P2P_HOST, "/bapi/c2c/v2/friendly/c2c/adv/search", {}, "post", body);
  if (!res || res.code !== "000000" || !Array.isArray(res.data)) {
    throw new Error("Binance P2P: " + ((res && (res.message || res.messageDetail)) || "unexpected response"));
  }
  return res.data;
}

function p2pTable_(side, payMethods, amount, opts) {
  const o = p2pOpts_(opts);
  const tradeType = String(side || "BUY").trim().toUpperCase();
  if (tradeType !== "BUY" && tradeType !== "SELL") throw new Error('Side must be "BUY" or "SELL".');
  const fiat = (o.fiat || "UAH").toUpperCase();
  const asset = (o.asset || "USDT").toUpperCase();
  const want = Math.min(Math.max(parseInt(o.rows, 10) || 20, 1), 100);
  const merchant = /^(true|yes|1)$/i.test(o.merchant || "");
  const minOrders = parseFloat(o.minorders) || 0;
  const minRate = parseFloat(o.minrate) || 0; // percent
  const headers = !/^false$/i.test(o.headers || "");
  const methods = (Array.isArray(payMethods) ? payMethods.flat() : String(payMethods || "").split(","))
    .map((x) => String(x).trim()).filter(Boolean);
  const amt = parseFloat(amount) || 0;

  const cacheKey = "P2P_" + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
    JSON.stringify([tradeType, fiat, asset, want, merchant, minOrders, minRate, methods, amt])));
  const cache = CacheService.getScriptCache();
  const hit = cache.get(cacheKey);
  let rows = hit ? JSON.parse(hit) : null;

  if (!rows) {
    rows = [];
    const seen = {};
    for (let page = 1; page <= 10 && rows.length < want; page++) {
      const body = {
        fiat: fiat, asset: asset, tradeType: tradeType, page: page, rows: 20,
        payTypes: methods, publisherType: merchant ? "merchant" : null, countries: [],
        proMerchantAds: false, shieldMerchantAds: false,
      };
      if (amt) body.transAmount = amt;
      const data = p2pSearch_(body);
      for (const d of data) {
        const a = d.adv || {}, u = d.advertiser || {};
        if (seen[a.advNo]) continue;
        seen[a.advNo] = true;
        const orders = +u.monthOrderCount || 0;
        const rate = (+u.monthFinishRate || 0) * 100;
        if (orders < minOrders || rate < minRate) continue;
        rows.push([
          +a.price, +a.surplusAmount || +a.tradableQuantity || 0,
          +a.minSingleTransAmount || 0, +a.maxSingleTransAmount || 0,
          (a.tradeMethods || []).map((m) => m.tradeMethodName || m.identifier).join(", "),
          u.nickName || "", orders, Math.round(rate * 10) / 10,
        ]);
        if (rows.length >= want) break;
      }
      if (data.length < 20) break; // no more pages
    }
    // Most profitable first: buying -> lowest price, selling -> highest price
    rows.sort((x, y) => (tradeType === "BUY" ? x[0] - y[0] : y[0] - x[0]));
    try { cache.put(cacheKey, JSON.stringify(rows), 60); } catch (e) { /* fine */ }
  }

  if (!rows.length) return [["No ads match these filters"]];
  const head = ["Price " + fiat, "Available " + asset, "Min " + fiat, "Max " + fiat, "Payment", "Advertiser", "Orders 30d", "Completion %"];
  return headers ? [head, ...rows] : rows;
}

function p2pMethods_(fiat) {
  fiat = String(fiat || "UAH").trim().toUpperCase();
  const cache = CacheService.getScriptCache();
  const hit = cache.get("P2PM_" + fiat);
  if (hit) return JSON.parse(hit);

  const found = {};
  try {
    const res = fetch_("Binance P2P", P2P_HOST, "/bapi/c2c/v2/public/c2c/adv/filter-conditions", {}, "post", { fiat: fiat });
    ((res && res.data && res.data.tradeMethods) || []).forEach((m) => { if (m.identifier) found[m.identifier] = m.tradeMethodName || m.identifier; });
  } catch (e) { Logger.log("filter-conditions failed: " + e); }

  if (!Object.keys(found).length) { // fallback: collect from live ads
    for (const tradeType of ["BUY", "SELL"]) {
      for (let page = 1; page <= 5; page++) {
        const data = p2pSearch_({ fiat: fiat, asset: "USDT", tradeType: tradeType, page: page, rows: 20, payTypes: [], publisherType: null, countries: [] });
        data.forEach((d) => ((d.adv || {}).tradeMethods || []).forEach((m) => { if (m.identifier) found[m.identifier] = m.tradeMethodName || m.identifier; }));
        if (data.length < 20) break;
      }
    }
  }

  const rows = [["Use in BINANCE_P2P", "Name"], ...Object.keys(found).sort().map((k) => [k, found[k]])];
  try { cache.put("P2PM_" + fiat, JSON.stringify(rows), 6 * 3600); } catch (e) { /* fine */ }
  return rows;
}

// ============================== SHARED ==============================

function table_(ex, operation, opts) {
  const headers = !/headers\s*:\s*false/i.test(String(opts || ""));
  const op = String(operation || "").toLowerCase();
  if (op === "balances") {
    const b = ex.balances();
    return headers ? [["Asset", "Total"], ...b] : b;
  }
  if (op === "prices") {
    const p = cachedPrices_(ex);
    const r = Object.keys(p).sort().map((s) => [s, p[s]]);
    return headers ? [["Symbol", "Price"], ...r] : r;
  }
  if (op === "portfolio") {
    const p = cachedPrices_(ex);
    const priceOf = (a) => {
      if (a === "USDT") return 1;
      if (p[a + "USDT"]) return p[a + "USDT"];
      if (p[a + "BTC"] && p.BTCUSDT) return p[a + "BTC"] * p.BTCUSDT;
      if (p["USDT" + a]) return 1 / p["USDT" + a];
      return "";
    };
    const val = (r) => (r[3] === "" ? -1 : r[3]);
    const r = ex.balances()
      .map(([a, t]) => { const pr = priceOf(a); return [a, t, pr, pr === "" ? "" : t * pr]; })
      .filter((x) => x[3] === "" || x[3] >= (parseFloat(setting_("MIN_VALUE")) || 0))
      .sort((x, y) => val(y) - val(x));
    return headers ? [["Asset", "Total", "Price USDT", "Value USDT"], ...r] : r;
  }
  throw new Error(ex.name + ': unknown operation "' + operation + '". Use "portfolio", "balances" or "prices".');
}

function fetch_(name, host, pathAndQuery, headers, method, payload) {
  const base = setting_("RELAY_URL").trim().replace(/\/+$/, "");
  const token = setting_("RELAY_TOKEN").trim();
  if (!base || !token) throw new Error("Relay not configured. Menu Crypto -> Settings.");
  const url = base + "/" + token + "/" + host + pathAndQuery;
  let res;
  for (let attempt = 1; ; attempt++) {
    const req = { method: method || "get", headers: headers || {}, muteHttpExceptions: true };
    if (payload !== undefined) { req.contentType = "application/json"; req.payload = JSON.stringify(payload); }
    res = UrlFetchApp.fetch(url, req);
    const code = res.getResponseCode();
    if ((code === 429 || code >= 500) && attempt < 3) { Utilities.sleep(1500 * attempt); continue; }
    break;
  }
  const text = res.getContentText();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(name + " via relay: HTTP " + res.getResponseCode() + " " + text.slice(0, 150));
  }
}

function cachedPrices_(ex) {
  const cache = CacheService.getScriptCache();
  const key = "PRICES_" + ex.name;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const p = ex.prices();
  try { cache.put(key, JSON.stringify(p), 55); } catch (e) { /* too big to cache, fine */ }
  return p;
}

function keys_(ex) {
  const props = PropertiesService.getUserProperties();
  const vals = ex.keys.map(([, prop]) => props.getProperty(prop));
  if (vals.some((v) => !v)) throw new Error(ex.name + " keys not set. Menu Crypto -> Settings.");
  return vals;
}

function optional_(name, what, fn) {
  try { fn(); } catch (e) { Logger.log(name + " " + what + " skipped: " + e); }
}

function add_(t, asset, amount) {
  if (amount > 0) t[asset] = (t[asset] || 0) + amount;
}

function rows_(t) {
  return Object.keys(t).sort().map((a) => [a, t[a]]);
}

function hex_(bytes) {
  return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}

// ============================== MENU / SETTINGS / REFRESH ==============================

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Crypto")
    .addItem("Settings", "showSettings")
    .addItem("Refresh now", "refresh")
    .addToUi();
}

function showSettings() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutput(SETTINGS_HTML_).setTitle("Crypto settings"));
}

/** All editable fields: [section, label, property, secret?] */
function settingsFields_() {
  const f = [
    ["Relay", "Relay URL", "RELAY_URL", false],
    ["Relay", "Relay token", "RELAY_TOKEN", true],
    ["Display", "Hide coins worth less than (USDT)", "MIN_VALUE", false],
    ["Display", "Auto-refresh every (minutes: 1, 5, 10, 15, 30)", "REFRESH_MINUTES", false],
  ];
  Object.values(EX).forEach((ex) => ex.keys.forEach(([label, prop]) => f.push([ex.name, label, prop, true])));
  return f;
}

function mask_(v) {
  return v ? "saved ••••" + v.slice(-4) : "";
}

/** Called by the sidebar. Secrets are never sent back, only a masked hint. */
function getSettings() {
  const props = PropertiesService.getUserProperties();
  const hasTrigger = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === "refresh");
  return {
    fields: settingsFields_().map(([section, label, prop, secret]) => {
      const v = props.getProperty(prop) || "";
      return { section, label, prop, secret, value: secret ? "" : (v || (SETTINGS[prop] ? SETTINGS[prop].def : "")), hint: secret ? mask_(v) : "" };
    }),
    autoRefresh: hasTrigger,
  };
}

/** Called by the sidebar. Empty secret field = keep; clear[prop] = true deletes it. */
function saveSettings(values, clear) {
  const props = PropertiesService.getUserProperties();
  const fields = settingsFields_();
  const allowed = {};
  fields.forEach(([, , prop, secret]) => { allowed[prop] = secret; });
  const oldRefresh = setting_("REFRESH_MINUTES");

  if (values.RELAY_URL && !/^https:\/\/[^\s/]+/i.test(values.RELAY_URL.trim())) throw new Error("Relay URL must start with https://");
  if (values.REFRESH_MINUTES && [1, 5, 10, 15, 30].indexOf(Number(values.REFRESH_MINUTES)) === -1) throw new Error("Refresh must be 1, 5, 10, 15 or 30");
  if (values.MIN_VALUE && isNaN(parseFloat(values.MIN_VALUE))) throw new Error("Min value must be a number");

  Object.keys(allowed).forEach((prop) => {
    if (clear && clear[prop]) { props.deleteProperty(prop); return; }
    const v = values[prop] === undefined ? "" : String(values[prop]).trim();
    if (allowed[prop]) { if (v) props.setProperty(prop, v); }       // secret: only overwrite when typed
    else if (v) props.setProperty(prop, v); else props.deleteProperty(prop);
  });

  const hasTrigger = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === "refresh");
  if (!hasTrigger || setting_("REFRESH_MINUTES") !== oldRefresh) installTrigger_();
  CacheService.getScriptCache().removeAll(["NBU"]);
  refresh();
  return "Saved.";
}

/** Replaces all project triggers (incl. leftovers from the old Binance add-on) with one refresh trigger. */
function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("refresh").timeBased().everyMinutes(Number(setting_("REFRESH_MINUTES")) || 5).create();
}

/** Called by the sidebar: relay + proxy health, then one signed call per configured exchange. */
function testConnection() {
  const out = [];
  const base = setting_("RELAY_URL").trim().replace(/\/+$/, ""), token = setting_("RELAY_TOKEN").trim();
  if (!base || !token) return "Relay URL / token not set.";
  try {
    const res = UrlFetchApp.fetch(base + "/" + token + "/check", { muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code !== 200) return "Relay: HTTP " + code + " " + res.getContentText().slice(0, 150);
    if (res.getContentText().trim() === "ok") return "Relay answered, but the token is wrong (check Relay token).";
    const j = JSON.parse(res.getContentText());
    const proxies = Object.keys(j).filter((k) => k.indexOf("://") !== -1);
    const good = proxies.filter((k) => String((j[k] || {}).binance_btc || "").indexOf("200") === 0);
    out.push("Relay OK. Proxies working: " + good.length + "/" + proxies.length + (proxies[0] ? " (exit IP " + String((j[proxies[0]] || {}).exit_ip || "").replace(/^200 /, "") + ")" : ""));
    if (!j.proxy_login_set) out.push("Warning: relay has no proxy login set.");
  } catch (e) {
    return "Relay: " + e.message;
  }
  Object.values(EX).forEach((ex) => {
    const props = PropertiesService.getUserProperties();
    if (!ex.keys.every(([, p]) => props.getProperty(p))) { out.push(ex.name + ": no keys"); return; }
    try { out.push(ex.name + ": OK, " + ex.balances().length + " assets"); }
    catch (e) { out.push(ex.name + ": " + e.message); }
  });
  return out.join("\n");
}

const SETTINGS_HTML_ = `<!DOCTYPE html><html><head><base target="_top"><style>
body{font:13px/1.4 Arial,sans-serif;margin:0;padding:12px;color:#202124}
h3{margin:16px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#5f6368}
label{display:block;margin:8px 0 2px;font-weight:bold}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:6px;border:1px solid #dadce0;border-radius:4px;font-family:monospace}
.hint{font-size:11px;color:#5f6368}.clr{font-size:11px;color:#b3261e;font-weight:normal;display:inline}
.bar{position:sticky;bottom:0;background:#fff;padding:10px 0;margin-top:14px;border-top:1px solid #eee}
button{padding:7px 14px;border:0;border-radius:4px;cursor:pointer;margin-right:6px}
.primary{background:#1a73e8;color:#fff}.secondary{background:#e8eaed}
pre{white-space:pre-wrap;background:#f1f3f4;padding:8px;border-radius:4px;font-size:12px;min-height:1em}
</style></head><body>
<div id="form">Loading…</div>
<div class="bar"><button class="primary" onclick="save()">Save</button><button class="secondary" onclick="test()">Test connection</button></div>
<pre id="status"></pre>
<script>
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function status(t){document.getElementById("status").textContent=t}
function render(d){
  let html="",sec="";
  d.fields.forEach(f=>{
    if(f.section!==sec){sec=f.section;html+="<h3>"+esc(sec)+"</h3>";}
    html+="<label>"+esc(f.label)+"</label>";
    html+='<input type="'+(f.secret?"password":"text")+'" id="'+f.prop+'" value="'+esc(f.value)+'" placeholder="'+esc(f.secret?(f.hint||"not set"):"")+'" autocomplete="off">';
    if(f.secret&&f.hint)html+='<span class="hint">'+esc(f.hint)+' — leave empty to keep. </span><label class="clr"><input type="checkbox" id="clr_'+f.prop+'"> clear</label>';
  });
  document.getElementById("form").innerHTML=html;
  status(d.autoRefresh?"":"Auto-refresh is not installed yet — press Save once.");
}
function collect(){
  const v={},c={};
  document.querySelectorAll("input[type=text],input[type=password]").forEach(i=>v[i.id]=i.value);
  document.querySelectorAll("input[type=checkbox]").forEach(i=>{if(i.checked)c[i.id.slice(4)]=true});
  return [v,c];
}
function load(){google.script.run.withSuccessHandler(render).withFailureHandler(e=>status("Error: "+e.message)).getSettings()}
function save(){status("Saving…");const [v,c]=collect();
  google.script.run.withSuccessHandler(m=>{status(m);load()}).withFailureHandler(e=>status("Error: "+e.message)).saveSettings(v,c)}
function test(){status("Testing… (up to 30 s)");
  google.script.run.withSuccessHandler(status).withFailureHandler(e=>status("Error: "+e.message)).testConnection()}
load();
</script></body></html>`;

/** Forces BINANCE/KUCOIN/UAH/BINANCE_P2P formulas to recalculate. */
function refresh() {
  const cache = CacheService.getScriptCache();
  Object.values(EX).forEach((ex) => cache.remove("PRICES_" + ex.name));
  cache.removeAll(["WB_USDT", "WB_USDC", "WB_BTC", "WB_ETH"]);
  for (const sheet of SpreadsheetApp.getActive().getSheets()) {
    let range;
    try { range = sheet.getDataRange(); } catch (e) { continue; }
    const f = range.getFormulas();
    for (let r = 0; r < f.length; r++) {
      for (let c = 0; c < f[r].length; c++) {
        if (!f[r][c] || !/(BINANCE_P2P|BINANCE|KUCOIN|UAH)R?\s*\(/i.test(f[r][c])) continue;
        const nf = f[r][c].replace(/\b(BINANCE_P2P|BINANCE|KUCOIN|UAH)(R?)(\s*\()/gi, (m, n, rr, p) => n + (rr ? "" : "R") + p);
        range.getCell(r + 1, c + 1).setFormula(nf);
      }
    }
  }
}
