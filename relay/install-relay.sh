#!/usr/bin/env bash
# =====================================================================
#  CryptoSheet relay installer (Debian / Ubuntu / Linux Mint, systemd, Tailscale)
#
#    sudo bash install-relay.sh
#
#  - installs Deno, the relay as a systemd service (localhost only),
#  - stores proxy + token in a root-only env file,
#  - publishes it over HTTPS with Tailscale Funnel,
#  - prints the Relay URL + token to paste into Crypto -> Settings.
#  Safe to re-run: keeps existing settings unless you choose to change them.
# =====================================================================
set -euo pipefail

PORT=8787                      # local-only port for the relay
DIR=/opt/relay
SERVICE=crypto-relay
ENVF="$DIR/relay.env"
RAW_URL="https://raw.githubusercontent.com/Whatevser/CryptoSheet/main/relay/relay.ts"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    OK:\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m    WARNING:\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
# env file values are double-quoted with \ and " escaped (systemd EnvironmentFile rules)
envget() {
  [ -f "$ENVF" ] || return 0
  python3 - "$ENVF" "$1" <<'PY'
import sys
for line in open(sys.argv[1]):
    k, _, v = line.rstrip("\n").partition("=")
    if k == sys.argv[2]:
        if len(v) >= 2 and v[0] == v[-1] == '"':
            out, i, v = [], 0, v[1:-1]
            while i < len(v):
                if v[i] == "\\" and i + 1 < len(v): i += 1
                out.append(v[i]); i += 1
            v = "".join(out)
        print(v); break
PY
}
envq() { python3 -c 'import sys; print("\"" + sys.argv[1].replace("\\", "\\\\").replace("\"", "\\\"") + "\"")' "$1"; }
yes_no() { local a; read -r -p "    $1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }

[ "$(id -u)" -eq 0 ] || die "Run it with sudo:  sudo bash $0"

# ---------------------------------------------------------------- 1. packages
say "1/7 Packages"
missing=()
for p in curl unzip python3; do command -v "$p" >/dev/null || missing+=("$p"); done
if [ ${#missing[@]} -gt 0 ]; then apt-get update -qq && apt-get install -y -qq "${missing[@]}"; fi
ok "curl, unzip, python3"

# ---------------------------------------------------------------- 2. deno
say "2/7 Deno (/usr/local/bin/deno)"
if [ ! -x /usr/local/bin/deno ]; then
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y >/dev/null
else
  /usr/local/bin/deno upgrade -q >/dev/null 2>&1 || true
fi
ok "$(/usr/local/bin/deno --version | head -1)"

# ---------------------------------------------------------------- 3. relay code
say "3/7 Relay code -> $DIR/relay.ts"
mkdir -p "$DIR"
if [ -f "$SRC_DIR/relay.ts" ]; then
  cp "$SRC_DIR/relay.ts" "$DIR/relay.ts"; ok "copied from $SRC_DIR"
else
  curl -fsSL "$RAW_URL" -o "$DIR/relay.ts"; ok "downloaded from GitHub"
fi
chmod 644 "$DIR/relay.ts"

# ---------------------------------------------------------------- 4. settings
say "4/7 Proxy + token (stored root-only in $ENVF)"
PROXY_URLS=$(envget PROXY_URLS); PROXY_USER=$(envget PROXY_USER); PROXY_PASS=$(envget PROXY_PASS)
RELAY_TOKEN=$(envget RELAY_TOKEN)

if [ -n "$PROXY_URLS" ]; then
  echo "    Current proxy: $PROXY_URLS  (login: ${PROXY_USER:-none})"
  yes_no "Change proxy settings?" && PROXY_URLS=""
fi
if [ -z "$PROXY_URLS" ]; then
  read -r -p "    Proxy host/IP: " PH
  [ -n "$PH" ] || die "proxy host required"
  read -r -p "    HTTP proxy port  (empty = none): " HP
  read -r -p "    SOCKS5 proxy port (empty = none): " SP
  urls=()
  [ -n "$HP" ] && urls+=("http://$PH:$HP")
  [ -n "$SP" ] && urls+=("socks5://$PH:$SP")
  [ ${#urls[@]} -gt 0 ] || die "need at least one port"
  PROXY_URLS=$(IFS=,; echo "${urls[*]}")
  read -r    -p "    Proxy username (empty = no login): " PROXY_USER
  PROXY_PASS=""
  if [ -n "$PROXY_USER" ]; then read -r -s -p "    Proxy password (hidden): " PROXY_PASS; echo; fi
fi

if [ -n "$RELAY_TOKEN" ]; then
  yes_no "Generate a NEW relay token? (you must then update it in Crypto -> Settings)" && RELAY_TOKEN=""
fi
[ -n "$RELAY_TOKEN" ] || RELAY_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')

umask 077
{
  echo "RELAY_TOKEN=$(envq "$RELAY_TOKEN")"
  echo "PROXY_URLS=$(envq "$PROXY_URLS")"
  echo "PROXY_USER=$(envq "$PROXY_USER")"
  echo "PROXY_PASS=$(envq "$PROXY_PASS")"
  echo "PORT=$PORT"
  echo "RELAY_BIND=127.0.0.1"
} > "$ENVF"
chmod 600 "$ENVF"; chown root:root "$ENVF"
ok "saved"

# ---------------------------------------------------------------- 5. service
say "5/7 systemd service '$SERVICE'"
if ss -ltn "sport = :$PORT" | grep -q LISTEN && ! systemctl is-active -q "$SERVICE"; then
  die "port $PORT is used by something else — change PORT at the top of this script"
fi
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=CryptoSheet relay (Google Sheets -> proxy -> exchanges)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENVF
Environment=DENO_DIR=/tmp/deno
ExecStart=/usr/local/bin/deno run --allow-net --allow-env $DIR/relay.ts
Restart=always
RestartSec=5
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"
sleep 3
systemctl is-active -q "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "service failed to start (log above)"; }
ok "running on 127.0.0.1:$PORT"

# ---------------------------------------------------------------- 6. local test
say "6/7 Local test through your proxy"
CHECK=$(curl -s -m 60 "http://127.0.0.1:$PORT/$RELAY_TOKEN/check" || true)
echo "$CHECK" | python3 -m json.tool 2>/dev/null | sed 's/^/    /' || echo "    $CHECK"
if echo "$CHECK" | grep -Eq '"binance_btc": ?"200'; then
  ok "Binance reachable through the proxy"
else
  warn "no '200' from Binance above — check proxy host/ports/login (re-run and change proxy settings)"
fi

# ---------------------------------------------------------------- 7. funnel
say "7/7 Public HTTPS via Tailscale Funnel"
command -v tailscale >/dev/null || die "Tailscale not installed: curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up"
TS_STATE=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null || true)
[ "$TS_STATE" = "Running" ] || die "Tailscale state is '${TS_STATE:-unknown}', expected Running (check: tailscale status)"
TSV=$(tailscale version | head -1)
python3 - "$TSV" <<'PY' || die "Tailscale $TSV is too old (need 1.52+). Update: curl -fsSL https://tailscale.com/install.sh | sh"
import sys
v = [int(x) for x in sys.argv[1].split("-")[0].split(".")[:2]]
sys.exit(0 if v >= [1, 52] else 1)
PY
ok "Tailscale $TSV running"

# keep anything you already publish on 443 -> use 8443 then
HTTPS_PORT=$(tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
try: cfg = json.load(sys.stdin) or {}
except Exception: cfg = {}
mine = "127.0.0.1:'"$PORT"'"
def used_by_other(port):
    if str(port) not in (cfg.get("TCP") or {}): return False
    for hp, web in (cfg.get("Web") or {}).items():
        if hp.endswith(":" + str(port)):
            return not any(mine in (h.get("Proxy") or "") for h in (web.get("Handlers") or {}).values())
    return True
print(8443 if used_by_other(443) else 443)
')
echo "    Public port: $HTTPS_PORT"
echo "    First time only: Tailscale prints a login.tailscale.com link — open it, click Enable, it continues."
tailscale funnel --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT"

DNS=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
URL="https://$DNS"; [ "$HTTPS_PORT" != 443 ] && URL="$URL:$HTTPS_PORT"

echo "    Waiting for the public URL (first HTTPS certificate can take ~1 min)…"
for i in $(seq 1 12); do
  if curl -s -m 20 "$URL/" | grep -q '^ok$'; then ok "public URL answers"; break; fi
  sleep 10
  [ "$i" = 12 ] && warn "public URL not answering yet — try $URL in a browser in a few minutes"
done

cat <<DONE

=====================================================================
 DONE.  In the Google Sheet: Crypto -> Settings

   Relay URL   : $URL
   Relay token : $RELAY_TOKEN

 Then Save and press "Test connection".

 Useful:
   status   : systemctl status $SERVICE
   logs     : journalctl -u $SERVICE -f
   restart  : sudo systemctl restart $SERVICE
   public   : tailscale funnel status
   show token again : sudo grep RELAY_TOKEN $ENVF
   uninstall: sudo tailscale funnel --https=$HTTPS_PORT off; sudo systemctl disable --now $SERVICE
=====================================================================
DONE
