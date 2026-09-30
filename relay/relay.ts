// Exchange relay for Google Sheets (Binance, KuCoin, CoinEx).
// Google Sheets -> this relay (HTTPS) -> your proxy -> exchange.
// Runs on Deno Deploy (paste into a Playground) or on your own box: `deno run -A relay.ts` (PORT env, default 8000).
//
// Lightweight by design: public data (prices, P2P) is cached ~45 s and identical parallel requests are merged,
// and big responses are stripped down to only the fields CRYPTO.gs uses (5-20x less traffic).

// ---- configuration: environment variables only (nothing secret in this file) ----
//   RELAY_TOKEN  required, 16+ chars; the same value goes into Crypto -> Settings in the sheet
//   PROXY_URLS   required, comma list tried in order, e.g. "http://1.2.3.4:8080,socks5://1.2.3.4:1080"
//   PROXY_USER / PROXY_PASS   proxy login (optional if your proxy has none)
//   PORT (8000), RELAY_BIND (0.0.0.0)   self-hosting only

const TOKEN = (Deno.env.get("RELAY_TOKEN") ?? "").trim();
const PROXIES = (Deno.env.get("PROXY_URLS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const CONFIG_ERROR = TOKEN.length < 16
  ? "RELAY_TOKEN env var missing or shorter than 16 chars"
  : PROXIES.length === 0 ? "PROXY_URLS env var missing" : "";
if (CONFIG_ERROR) console.error("CONFIG ERROR: " + CONFIG_ERROR);

const HOSTS = new Set([
  "api.binance.com", "api1.binance.com", "api2.binance.com", "api3.binance.com",
  "api4.binance.com", "fapi.binance.com", "dapi.binance.com",
  "api.kucoin.com", "api.coinex.com",
  "bank.gov.ua", "p2p.binance.com",
]);

// Proxy login comes from Deno Deploy secrets (Env Variables), never from this code.
const USER = Deno.env.get("PROXY_USER");
const PASS = Deno.env.get("PROXY_PASS");
const basicAuth = USER && PASS ? { username: USER, password: PASS } : undefined;
if (!basicAuth) console.warn("PROXY_USER / PROXY_PASS not set — fine only if your proxy needs no login");

const CACHE_MS = 45_000;
const cache = new Map<string, { t: number; status: number; body: string; ctype: string }>();
const inflight = new Map<string, Promise<{ status: number; body: string; ctype: string }>>();

// Keep only what CRYPTO.gs reads from the heavy public endpoints.
// deno-lint-ignore no-explicit-any
function slim(host: string, path: string, j: any): any {
  try {
    if (host === "api.kucoin.com" && path.endsWith("/market/allTickers")) {
      // deno-lint-ignore no-explicit-any
      return { code: j.code, msg: j.msg, data: { ticker: (j.data?.ticker ?? []).map((t: any) => ({ symbol: t.symbol, last: t.last })) } };
    }
    if (host === "api.coinex.com" && path.endsWith("/spot/ticker")) {
      // deno-lint-ignore no-explicit-any
      return { code: j.code, message: j.message, data: (j.data ?? []).map((t: any) => ({ market: t.market, last: t.last })) };
    }
    if (host === "p2p.binance.com" && path.endsWith("/adv/search")) {
      return {
        code: j.code, message: j.message, messageDetail: j.messageDetail, total: j.total,
        // deno-lint-ignore no-explicit-any
        data: (j.data ?? []).map((d: any) => ({
          adv: {
            advNo: d.adv?.advNo, price: d.adv?.price, surplusAmount: d.adv?.surplusAmount,
            tradableQuantity: d.adv?.tradableQuantity, minSingleTransAmount: d.adv?.minSingleTransAmount,
            maxSingleTransAmount: d.adv?.maxSingleTransAmount,
            // deno-lint-ignore no-explicit-any
            tradeMethods: (d.adv?.tradeMethods ?? []).map((m: any) => ({ identifier: m.identifier, tradeMethodName: m.tradeMethodName })),
          },
          advertiser: {
            nickName: d.advertiser?.nickName, monthOrderCount: d.advertiser?.monthOrderCount,
            monthFinishRate: d.advertiser?.monthFinishRate,
          },
        })),
      };
    }
    if (host === "p2p.binance.com" && path.endsWith("/filter-conditions")) {
      // deno-lint-ignore no-explicit-any
      return { code: j.code, data: { tradeMethods: (j.data?.tradeMethods ?? []).map((m: any) => ({ identifier: m.identifier, tradeMethodName: m.tradeMethodName })) } };
    }
  } catch { /* fall through */ }
  return j;
}

const clients = PROXIES.map((url) => Deno.createHttpClient({ proxy: { url, basicAuth } }));
let preferred = 0;

async function viaProxy(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < clients.length; i++) {
    const idx = (preferred + i) % clients.length;
    try {
      // deno-lint-ignore no-explicit-any
      const res = await fetch(url, { ...init, client: clients[idx], signal: AbortSignal.timeout(25000) } as any);
      preferred = idx;
      return res;
    } catch (e) {
      lastErr = e;
      console.error(`proxy ${PROXIES[idx]} failed: ${e}`);
    }
  }
  throw lastErr;
}

async function check(): Promise<Response> {
  const out: Record<string, unknown> = { proxy_login_set: !!basicAuth };
  for (let i = 0; i < clients.length; i++) {
    const r: Record<string, unknown> = {};
    for (const [name, url] of [
      ["exit_ip", "https://api.ipify.org?format=json"],
      ["binance_ping", "https://api.binance.com/api/v3/ping"],
      ["binance_btc", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"],
    ]) {
      try {
        // deno-lint-ignore no-explicit-any
        const res = await fetch(url, { client: clients[i], signal: AbortSignal.timeout(15000) } as any);
        r[name] = `${res.status} ${(await res.text()).slice(0, 200)}`;
      } catch (e) {
        r[name] = `ERROR ${e}`;
      }
    }
    out[PROXIES[i]] = r;
  }
  return Response.json(out, { headers: { "cache-control": "no-store" } });
}

Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000), hostname: Deno.env.get("RELAY_BIND") ?? "0.0.0.0" }, async (req) => {
  const u = new URL(req.url);
  const parts = u.pathname.split("/"); // ["", TOKEN, host, ...path]
  if (CONFIG_ERROR) return new Response("relay misconfigured: " + CONFIG_ERROR, { status: 500 });
  if (parts[1] !== TOKEN) return new Response("ok", { status: 200 });
  if (parts[2] === "check") return await check();

  const host = parts[2];
  if (!HOSTS.has(host)) return new Response("host not allowed", { status: 403 });
  const target = `https://${host}/${parts.slice(3).join("/")}${u.search}`;

  const headers = new Headers();
  for (const [h, v] of req.headers) {
    if (h === "x-mbx-apikey" || h === "content-type" || h.startsWith("kc-api-") || h.startsWith("x-coinex-")) headers.set(h, v);
  }
  if (host === "p2p.binance.com") {
    headers.set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36");
    headers.set("clienttype", "web");
  }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const bodyText = hasBody ? await req.text() : "";
  const path = "/" + parts.slice(3).join("/");
  const signed = headers.has("x-mbx-apikey") || headers.has("kc-api-key") || headers.has("x-coinex-key");
  const key = signed ? "" : `${req.method} ${target} ${bodyText}`;

  const reply = (r: { status: number; body: string; ctype: string }) =>
    new Response(r.body, { status: r.status, headers: { "content-type": r.ctype } });

  if (key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_MS) return reply(hit);
    const pending = inflight.get(key);
    if (pending) {
      try { return reply(await pending); } catch (e) { return new Response(`relay error: ${e}`, { status: 502 }); }
    }
  }

  const work = (async () => {
    const res = await viaProxy(target, { method: req.method, headers, body: hasBody ? bodyText : undefined });
    const ctype = res.headers.get("content-type") ?? "application/json";
    let body = await res.text();
    if (res.ok && ctype.includes("json")) {
      try { body = JSON.stringify(slim(host, path, JSON.parse(body))); } catch { /* keep raw */ }
    }
    return { status: res.status, body, ctype };
  })();

  if (key) inflight.set(key, work);
  try {
    const r = await work;
    if (key && r.status === 200) {
      cache.set(key, { t: Date.now(), ...r });
      if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.t > CACHE_MS) cache.delete(k);
    }
    return reply(r);
  } catch (e) {
    return new Response(`relay error: ${e}`, { status: 502 });
  } finally {
    if (key) inflight.delete(key);
  }
});
