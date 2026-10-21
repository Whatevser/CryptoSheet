# CryptoSheet

Live crypto portfolio in Google Sheets: **Binance, KuCoin** balances and prices,
**Binance P2P** USDT/UAH offers, and **UAH** exchange rates, as plain spreadsheet formulas.

```
Google Sheets ──HTTPS──▶ relay ──HTTP/SOCKS5──▶ your proxy ──HTTPS──▶ exchange APIs
 (CRYPTO.gs)           (relay.ts)                (e.g. UA IP)
```

| File | What it is | Where it runs |
|---|---|---|
| `CRYPTO.gs` | The Apps Script: formulas, exchange API clients, settings sidebar, auto-refresh | Your Google Sheet (Extensions → Apps Script) |
| `relay/relay.ts` | Small HTTPS relay that forwards requests through your proxy | Your always-on Linux box (or Deno Deploy) |
| `relay/install-relay.sh` | One-shot installer: Deno + systemd service + Tailscale Funnel | Same Linux box |

Nothing secret is stored in this repo. Your API keys and relay token live in your Google user
properties, and the proxy login lives in a root-only file on your server.

---

## Why a relay?

- Google runs Apps Script on **US servers**. Binance and KuCoin block US IPs (HTTP 451/403).
- Apps Script's `UrlFetchApp` can only call URLs. It **can't use an HTTP/SOCKS proxy**.

The relay is a public HTTPS URL that Sheets *can* call. It forwards each request through your
proxy, so the exchange sees your proxy's IP.

It is locked down:
- It only answers requests whose path starts with your secret **relay token**.
- It only forwards to a fixed list of exchange hosts (`HOSTS` in `relay.ts`).
- Exchange traffic stays TLS end-to-end, so the proxy can't read your API keys.

It is also cheap to run:
- Public data (prices, P2P) is cached for 45 s.
- Identical parallel requests are merged into one.
- Big responses are stripped down to the few fields the script uses.

---

## Setup

### 1. Relay server (Linux box with Tailscale): about 5 min

**Needs:**
- An always-on Debian/Ubuntu/Mint machine with systemd.
- [Tailscale](https://tailscale.com/download) installed and logged in (`tailscale status` works).
- Your proxy: host, HTTP and/or SOCKS5 port, and login if it has one.

```bash
git clone https://github.com/Whatevser/CryptoSheet.git
cd CryptoSheet/relay
sudo bash install-relay.sh
```

It asks for the proxy details, then:

| Step | What happens |
|---|---|
| 1–2 | Installs `curl`/`unzip`/`python3` if missing, and Deno to `/usr/local/bin` |
| 3 | Copies `relay.ts` to `/opt/relay/` |
| 4 | Writes `/opt/relay/relay.env` (root-only, `600`): proxy URLs + login + a **random relay token** |
| 5 | Creates the `crypto-relay` systemd service. It listens on **127.0.0.1:8787 only** (nothing exposed on your LAN), starts on boot, restarts on crash, and runs sandboxed |
| 6 | Tests Binance through your proxy and prints the result |
| 7 | Publishes it with **Tailscale Funnel** at `https://<machine>.<tailnet>.ts.net`. This works behind NAT/CGNAT with no port forwarding or firewall rules. If you already serve something on 443, it uses 8443 |

The first time you use Funnel, Tailscale prints a `login.tailscale.com/...` link. Open it, click
**Enable**, and the script continues on its own.

At the end it prints:

```
   Relay URL   : https://green-g4.tail1234.ts.net
   Relay token : Xq3...long random string...
```

Keep that window open for step 2.

Re-running the installer is safe. It updates the relay code and asks before changing the proxy or
the token.

<details>
<summary>Alternative: Deno Deploy instead of your own server</summary>

1. On console.deno.com, create a **New Playground** and paste `relay/relay.ts`.
2. Add these under **Env Variables**, all as *Secret*:
   - `RELAY_TOKEN`: any random string of 16+ chars
   - `PROXY_URLS`: e.g. `http://1.2.3.4:8080,socks5://1.2.3.4:1080`
   - `PROXY_USER`, `PROXY_PASS`
3. Deploy. Use the playground URL + your token in the sheet settings.

The free plan has monthly limits (1M requests, 20 GB egress, 10 h CPU). When a limit is hit, the
app is suspended until the monthly reset (`HTTP 503 USAGE_EXCEEDED`). Set auto-refresh to 15+ min
there.
</details>

### 2. Google Sheet

1. Open your sheet, then **Extensions → Apps Script**.
2. Delete every script file (keep `appsscript.json`). Create a file named `CRYPTO` and paste all of
   `CRYPTO.gs` into it. **Save.**
3. Reload the sheet. A **Crypto** menu appears (it can take a few seconds).
4. Open **Crypto → Settings**. The first time, Google asks for permissions. Allow them. If it says
   "unverified app": **Advanced → Go to (project)**.
5. In the sidebar, fill in:
   - **Relay URL** and **Relay token** from step 1
   - Exchange API keys: see below
6. Click **Save**, then **Test connection**. You should see something like:
   ```
   Relay OK. Proxies working: 2/2 (exit IP {"ip":"194.x.x.x"})
   Binance: OK, 7 assets
   KuCoin: OK, 3 assets
   ```

**Saving also installs the auto-refresh trigger.** It removes every other trigger in the project,
including leftovers from the old Binance add-on.

### Exchange API keys: always **read-only**

| Exchange | Create at | Permissions | Fields |
|---|---|---|---|
| Binance | API Management | *Enable Reading* only, IP access **unrestricted** | API Key, API Secret |
| KuCoin | API Management | *General* only | API Key, API Secret, Passphrase (you choose it when creating) |

### The settings sidebar

- **Secret fields** (token, keys) never show their value, only `saved ••••abcd`.
  - Leave a secret field **empty to keep** the saved value.
  - Type a new value to replace it.
  - Tick **clear** to delete it.
- **Hide coins worth less than**: the dust filter for `portfolio` tables (USDT).
- **Auto-refresh every**: 1, 5, 10, 15 or 30 minutes. Changing it reinstalls the trigger on Save.
- Everything is stored in your **Google user properties**: per Google account, not visible to
  other editors of the sheet, and not in the script code.

---

## Formulas

A sheet in a French/European locale uses **`;`** between arguments (not `,`). Type quotes by hand;
pasted "smart quotes" break formulas.

### Portfolio: same shape for every exchange

```
=BINANCE("portfolio")
=KUCOIN("portfolio")
```

→ **Asset | Total | Price USDT | Value USDT**, all wallets summed, sorted by value.

| Exchange | Wallets included |
|---|---|
| Binance | spot, funding, simple earn (flexible + locked), cross margin, USDⓈ-M futures |
| KuCoin | main, trade, trade_hf, margin |

A wallet your key can't read is skipped silently. A coin without a USDT pair is priced via BTC;
if there's still no price, that cell is blank.

**Options:**
- `"headers: false"` as the 2nd argument drops the header row.
- Total in USDT: `=SUM(CHOOSECOLS(BINANCE("portfolio"; "headers: false"); 4))`

**Also available:**
```
=BINANCE("balances")        Asset | Total
=BINANCE("prices")          Symbol | Price   (ADAUSDT format, same for both)
=VLOOKUP("SOLUSDT"; KUCOIN("prices"; "headers: false"); 2; 0)     one price
```

### UAH rates

```
=UAH("USD")        NBU official rate (any NBU currency: EUR, PLN, …), via relay
=UAH("USDT")       WhiteBIT last price for USDT/UAH (any coin with a <COIN>_UAH market)
=GOOGLEFINANCE("CURRENCY:USDUAH")     Google's own rate, no script needed
```

### Binance P2P

```
=BINANCE_P2P("BUY";  "Monobank, PrivatBank"; 20000)
=BINANCE_P2P("SELL"; "Monobank"; 20000; "minorders: 100, minrate: 97, merchant: true")
=BINANCE_P2P_METHODS()          exact payment-method names to filter by
```

→ **Price | Available | Min | Max | Payment | Advertiser | Orders 30d | Completion %**

| Argument | Meaning |
|---|---|
| side | `"BUY"`: you buy USDT (cheapest first). `"SELL"`: you sell USDT (highest first) |
| payment | Comma list, a range, or `""` for any |
| amount | Your trade size in UAH. Only ads whose limits accept it are shown (`0` = any). This is what makes the prices realistic |
| options | `rows: 20` (≤100), `minorders`, `minrate` (%), `merchant: true`, `fiat: UAH`, `asset: USDT`, `headers: false` |

Average of the top 20 for the amount in `B1`:
```
=AVERAGE(CHOOSECOLS(BINANCE_P2P("SELL"; "Monobank, PrivatBank"; B1; "headers: false"); 1))
=AVERAGE(CHOOSECOLS(BINANCE_P2P("BUY";  "Monobank, PrivatBank"; B1; "headers: false"); 1))
```

The P2P endpoint is the one Binance's own website uses. It isn't officially documented and could
change.

### Other formulas that don't need the script

**Raptoreum wallet balance** (address in `A1`):
```
=IMPORTDATA("https://chainz.cryptoid.info/rtm/api.dws?q=getbalance&a=" & A1; ","; "en_US")
```
Up to 6 h delay without a free CryptoID API key (`&key=…`).

---

## How refresh works

Sheets caches custom-function results until their arguments change. The `refresh` trigger forces a
recalculation by rewriting every `BINANCE(` ⇄ `BINANCER(` (and `KUCOIN`, `UAH`,
`BINANCE_P2P`). The `…R` twins are identical functions.

- Don't type the `…R` names yourself.
- Don't be surprised to see them in your formulas.
- **Crypto → Refresh now** does it immediately.

`IMPORTDATA`/`GOOGLEFINANCE` cells are refreshed by Google itself (roughly hourly / ~20 min).

---

## Maintaining the relay

```bash
systemctl status crypto-relay          # running?
journalctl -u crypto-relay -f          # live log
sudo systemctl restart crypto-relay
tailscale funnel status                # public URL
sudo grep RELAY_TOKEN /opt/relay/relay.env   # show token again
cd CryptoSheet && git pull && sudo bash relay/install-relay.sh   # update
```

**Rotate the token:** re-run the installer and answer **y** to "Generate a NEW relay token", then
paste the new token in **Crypto → Settings**.

**Uninstall:**
```bash
sudo tailscale funnel --https=443 off
sudo systemctl disable --now crypto-relay
sudo rm -rf /opt/relay /etc/systemd/system/crypto-relay.service
```

---

## Troubleshooting

| You see | Cause / fix |
|---|---|
| `Erreur d'analyse de formule` / parse error | Use `;` between arguments, retype the quotes |
| `Relay not configured` | Crypto → Settings → relay URL + token |
| `… keys not set` | Crypto → Settings → that exchange's keys |
| `via relay: HTTP 500 relay misconfigured` | `relay.env` is missing `RELAY_TOKEN` or `PROXY_URLS`. Re-run the installer |
| `via relay: HTTP 502 relay error` | Proxy unreachable or wrong login. Run **Test connection**; check `journalctl -u crypto-relay` |
| `via relay: HTTP 503 USAGE_EXCEEDED` | Deno Deploy free quota is used up. Self-host (step 1) or wait for the monthly reset |
| Test connection says `ok` instead of JSON, or `Relay: HTTP 200` with nothing | Wrong **token**. The relay answers `ok` to anything without the right token |
| `Binance error -2015` · `KuCoin error 400005` | Wrong key/secret/passphrase, or an IP restriction on the key → unrestricted + read-only |
| `host not allowed` | Host missing from `HOSTS` in `relay.ts` |
| `No ads match these filters` | Loosen the P2P filters; check names with `=BINANCE_P2P_METHODS()` |
| Numbers never update | Crypto → Settings → **Save** (reinstalls the trigger). Apps Script → **Triggers** should show exactly one `refresh` |
| `Unsupported operation 'undefined'` in the editor | You ran a formula function from the editor. Only use the sheet menu |

**Logs:** Apps Script → **Executions**.

---

## Security notes

- **Read-only keys only.** If anything leaks, the worst case is someone seeing your balances.
- **What passes through the relay:** it sees the signed requests but can't reuse them after about 30 s (timestamps). Exchange traffic stays TLS all the way to the exchange, so the proxy sees none of it.
- **Proxy login:** HTTP/SOCKS5 send it unencrypted between the relay and the proxy. That's inherent to those protocols. Use a dedicated proxy login if you can.
- **Relay token:** anyone with the URL + token can use your relay (only toward the allowed exchange hosts). Rotate it if you think it leaked.
