#!/usr/bin/env bash
# End-to-end local smoke test for Patchwork.
# Usage:  PORT=3040 bash scripts/smoke.sh
# Assumes the dev server is running on $PORT with JOIN_CODE=$CODE. Docker is used by the verifier.
set -uo pipefail
PORT=${PORT:-3040}
BASE="http://localhost:$PORT"
CODE=${JOIN_CODE:-patchwork}
HERE="$(cd "$(dirname "$0")" && pwd)"
say(){ printf "\n\033[1m== %s ==\033[0m\n" "$1"; }

say "wait for server ($BASE)"
for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code}' "$BASE/api/state" 2>/dev/null | grep -q 200 && { echo "up after ${i}s"; break; }; sleep 1; done

say "pages render"
for p in "/" "/dashboard"; do echo "  $p -> $(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")"; done

say "join"
TOK=$(curl -s -XPOST "$BASE/api/join" -H 'content-type: application/json' -d "{\"handle\":\"smoke\",\"location\":\"Testville\",\"code\":\"$CODE\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOK" ] && echo "  token acquired" || { echo "  JOIN FAILED"; exit 1; }
AUTH="authorization: Bearer $TOK"

say "heartbeat · claim · trace"
curl -s -XPOST "$BASE/api/nodes/heartbeat" -H "$AUTH" -H 'content-type: application/json' -d '{"status":"running"}' >/dev/null && echo "  heartbeat ok"
echo "  claimed: $(curl -s -XPOST "$BASE/api/work/claim" -H "$AUTH" -d '{}' | head -c 110)"
curl -s -XPOST "$BASE/api/trace" -H "$AUTH" -H 'content-type: application/json' -d '{"kind":"thought","text":"smoke: scanning httpserver.rs read_line"}' >/dev/null && echo "  trace ok"

say "submit 2 findings (one real repro, one bogus over-claim)"
curl -s -XPOST "$BASE/api/findings" -H "$AUTH" -H 'content-type: application/json' -d '{"repo":"snare","title":"SMOKE positive (marker echoed)","oracle":"logic-authz","severity":"low","claimed":"reproduced","patch":true,"pov":{"image":"debian:stable-slim","cmd":"echo PATCHWORK_REPRO_OK","marker":"PATCHWORK_REPRO_OK","timeoutSec":60}}' >/dev/null
curl -s -XPOST "$BASE/api/findings" -H "$AUTH" -H 'content-type: application/json' -d '{"repo":"snare","title":"SMOKE negative (bogus claim)","oracle":"logic-authz","severity":"low","claimed":"reproduced","patch":false,"pov":{"image":"debian:stable-slim","cmd":"echo nope","marker":"WONT_APPEAR","timeoutSec":60}}' >/dev/null
echo "  submitted 2 (both claimed reproduced)"

say "stats BEFORE verify"; curl -s "$BASE/api/state" | sed -n 's/.*"stats":\({[^}]*}\).*/\1/p'

say "run central verifier (real Docker sandbox — first run pulls debian, be patient)"
( cd "$HERE/../verifier" && PW_URL="$BASE" PW_VERIFY_CODE="$CODE" PW_POLL_MS=3000 timeout 90 node worker.mjs 2>&1 | grep -E 'verify|VERDICT|docker|marker|→|✓|✗' ) || true

say "stats AFTER verify"; curl -s "$BASE/api/state" | sed -n 's/.*"stats":\({[^}]*}\).*/\1/p'

say "SMOKE findings — claimed vs verified tier"
python3 - "$BASE" <<'PY'
import json,sys,urllib.request
s=json.load(urllib.request.urlopen(sys.argv[1]+"/api/state"))
for f in s["findings"]:
    if f["title"].startswith("SMOKE"):
        oc = f["claimed"]=="reproduced" and f["tier"] in ("analytical","refuted")
        print(f"  {f['title']:34} claimed={f['claimed']:11} -> tier={f['tier']:11} {'[OVER-CLAIM CAUGHT]' if oc else ''}")
print("  expected: positive -> reproduced, negative -> refuted (over-claim)")
PY
echo
