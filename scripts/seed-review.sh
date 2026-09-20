#!/usr/bin/env bash
# Drive a full review round through the REAL claim/report flow, against the demo PR.
#
#   ./scripts/seed-review.sh [base-url]
#
# Defaults to http://localhost:3042. Point it at an IN-MEMORY server (DATABASE_URL= ): against
# the shared prod Neon this writes rows the audience would see (see TASKS.md).
#
# Why the real flow rather than posting comments directly: submitting a comment against a CLAIMED
# work item is what marks that item done, and that is what feeds reviewQuorum's per-lens counts.
# Posting comments with no work item produces clusters but leaves quorum at zero, so the "ready
# to post" state never lights up.
#
# Consensus comes from DIFFERENT agents landing on the same lines. Clustering is by file and line
# proximity and is category-agnostic, so agents on different lenses still merge when they flag the
# same place — which is exactly the cross-lens agreement worth publishing.
set -euo pipefail

B="${1:-http://localhost:3042}"
CODE="${JOIN_CODE:-patchwork}"
PR_URL="${PR_URL:-https://github.com/CorneliusHagmeister/snare/pull/1}"
PR_TITLE="${PR_TITLE:-Bound the pre-auth HTTP request line and header block}"

py() { python3 -c "$1"; }

join() {
  curl -s -X POST "$B/api/join" -H 'content-type: application/json' \
    -d "{\"handle\":\"$1\",\"location\":\"$2\",\"code\":\"$CODE\"}" \
    | py "import sys,json;print(json.load(sys.stdin).get('token',''))"
}

# The hot region of the PR: the request-line / header bound in parse_get. Several lenses land
# here on purpose, because that is where independent agreement should form.
comment_for_lens() {
  case "$1" in
    security)     echo '[{"path":"src/httpserver.rs","line":366,"category":"security","severity":"high","body":"The new cap is applied after the first read_line returns, so a single oversized request line is still fully buffered before the limit is checked."}]' ;;
    correctness)  echo '[{"path":"src/httpserver.rs","line":369,"category":"correctness","severity":"high","body":"Bound is checked once per line rather than against the cumulative header block, so many small headers can exceed the intended total."}]' ;;
    performance)  echo '[{"path":"src/httpserver.rs","line":364,"category":"performance","severity":"medium","body":"Reading byte-at-a-time to enforce the cap makes header parsing measurably slower on normal requests; a bounded take() reader would avoid the per-byte cost."}]' ;;
    test-coverage) echo '[{"path":"tests/limits.rs","line":41,"category":"tests","severity":"medium","body":"The oversized-header test asserts the connection closes but never asserts memory stayed bounded, which is the actual regression being guarded."}]' ;;
    api-surface)  echo '[{"path":"src/httpserver.rs","line":31,"category":"api-design","severity":"low","body":"MAX_REQUEST_LINE and MAX_HEADER_BLOCK are hard-coded consts; these belong in the config so operators can tune them."}]' ;;
    docs-comments) echo '[{"path":"src/httpserver.rs","line":33,"category":"docs","severity":"info","body":"The new constants carry no comment explaining why 8192 was chosen or what an operator should weigh when changing it."}]' ;;
    *)            echo '[{"path":"src/httpserver.rs","line":366,"category":"correctness","severity":"medium","body":"Reviewed this hunk and the bound looks reachable before the cap is enforced."}]' ;;
  esac
}

echo "→ reviewing $PR_URL"

echo "→ joining agents"
declare -a TOKENS=() NAMES=()
for pair in "ada:Edinburgh" "lin:Toronto" "nour:Lisbon" "rafa:Porto"; do
  h=${pair%%:*}; loc=${pair##*:}
  t=$(join "$h" "$loc")
  [ -n "$t" ] || { echo "join failed — is $B up, and is the join code '$CODE'?" >&2; exit 1; }
  TOKENS+=("$t"); NAMES+=("$h")
done
echo "  ${NAMES[*]}"

echo "→ opening the round"
OPEN=$(curl -s -X POST "$B/api/review/target" -H "authorization: Bearer ${TOKENS[0]}" \
  -H 'content-type: application/json' -d "{\"url\":\"$PR_URL\",\"title\":\"$PR_TITLE\"}")
TID=$(echo "$OPEN" | py "import sys,json;d=json.load(sys.stdin);print((d.get('target') or {}).get('id',''))")
REPL=$(echo "$OPEN" | py "import sys,json;print(json.load(sys.stdin).get('replication','?'))")
ITEMS=$(echo "$OPEN" | py "import sys,json;print(json.load(sys.stdin).get('workItems','?'))")
[ -n "$TID" ] || { echo "could not open a review target: $OPEN" >&2; exit 1; }
echo "  target $TID — $ITEMS work items at replication $REPL"

# Each agent claims until it runs out of lenses it hasn't already taken for this target.
echo "→ agents claiming and reporting"
for i in "${!TOKENS[@]}"; do
  tok="${TOKENS[$i]}"; who="${NAMES[$i]}"; got=0
  while :; do
    CLAIM=$(curl -s -X POST "$B/api/review/claim" -H "authorization: Bearer $tok" \
      -H 'content-type: application/json' -d '{}')
    NONE=$(echo "$CLAIM" | py "import sys,json;print(json.load(sys.stdin).get('none',False))")
    [ "$NONE" = "True" ] && break
    WID=$(echo "$CLAIM" | py "import sys,json;print(json.load(sys.stdin).get('id',''))")
    LENS=$(echo "$CLAIM" | py "import sys,json;print(json.load(sys.stdin).get('lens',''))")
    [ -n "$WID" ] || break
    curl -s -X POST "$B/api/review/comments" -H "authorization: Bearer $tok" \
      -H 'content-type: application/json' \
      -d "{\"target\":\"$TID\",\"workItem\":\"$WID\",\"comments\":$(comment_for_lens "$LENS")}" > /dev/null
    got=$((got+1))
    # LENS_CAP paces the round: low values leave the quorum meter partially filled (good for
    # rehearsing the "not ready yet" state), unset drains to full quorum.
    [ -n "${LENS_CAP:-}" ] && [ "$got" -ge "$LENS_CAP" ] && break
  done
  echo "  $who reported on $got lens(es)"
done

echo "→ aggregate + quorum"
curl -s "$B/api/review/aggregate?target=$TID" | py "
import sys, json
d = json.load(sys.stdin)
if 'error' in d:
    print('  ERROR:', d['error']); raise SystemExit(1)
s = d['stats']
print(f\"  {s['raw']} comments from {s['contributors']} agents → {s['clustered']} claims ({s['method']})\")
q = d.get('quorum')
if q:
    print(f\"  quorum: ready={q['ready']}  postable={q['postable']}  replication={q['replication']}\")
    for l in q['lenses']:
        mark = 'ok ' if l['done'] >= l['need'] else '   '
        print(f\"    {mark}{l['lens']:<14} {l['done']}/{l['need']}\")
print('  agreed (would post inline):')
for c in d.get('agreed', []):
    print(f\"    {c['consensus']}x {c['severity']:6} {c['path']}:{c.get('line')}  {c['reviewers']}\")
print('  raised once (recorded, not posted):')
for c in d.get('solo', []):
    print(f\"    {c['consensus']}x {c['severity']:6} {c['path']}:{c.get('line')}  {c['reviewers']}\")
"
echo "→ done. Board: $B/dashboard"
