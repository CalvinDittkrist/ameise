#!/usr/bin/env bash
# PROTOTYPE, throwaway. Question: does a non-interactive Codex call hold the factory's reviewer schema?
# It builds a tiny repository with a base branch and a flawed change, runs `codex exec` read-only with
# --output-schema, and prints the exit status, the events it saw and whether the last message is an
# object of the schema. Two cases: a flawed diff (expect fix + findings) and a clean diff (expect pass, []).
# Run: prototypes/codex-review-prototype/run.sh   (needs codex logged in, jq)
set -u
here=$(cd "$(dirname "$0")" && pwd)
schema="$here/schema.json"
out=$(mktemp -d)
echo "output: $out"

make_repo() { # $1 dir, $2 flawed|clean
  rm -rf "$1"; mkdir -p "$1"; cd "$1"
  git init -q -b main .
  git config user.email p@example.com; git config user.name proto
  cat > sum.go <<'GO'
package sum

// Sum adds the numbers. An empty slice sums to 0.
func Sum(xs []int) int {
	total := 0
	for _, x := range xs {
		total += x
	}
	return total
}
GO
  git add -A; git commit -qm "base"
  git checkout -q -b feat/1-avg
  if [ "$2" = flawed ]; then
    cat > avg.go <<'GO'
package sum

// Avg is the mean of the numbers. An empty slice has the mean 0.
func Avg(xs []int) int {
	return Sum(xs) / len(xs)
}
GO
  else
    cat > avg.go <<'GO'
package sum

// Avg is the mean of the numbers, rounded down. An empty slice has the mean 0.
func Avg(xs []int) int {
	if len(xs) == 0 {
		return 0
	}
	return Sum(xs) / len(xs)
}
GO
  fi
  git add -A; git commit -qm "feat: add Avg"
}

brief='You are a read-only code reviewer. Review the change of this branch against the base branch main: run `git diff main...HEAD` and read the files it touches. Report only problems you verified in the diff. Answer with a JSON object of the given schema and nothing else: verdict fix when any finding is S1 or S2, pass otherwise; findings empty for a clean diff.'

for kind in flawed clean; do
  repo="$out/repo-$kind"; make_repo "$repo" "$kind"
  echo; echo "=== case: $kind ==="
  codex exec --sandbox read-only --cd "$repo" --ephemeral --skip-git-repo-check \
    --output-schema "$schema" --json -o "$out/last-$kind.json" "$brief" > "$out/events-$kind.jsonl" 2> "$out/stderr-$kind.txt"
  echo "exit: $?"
  echo "events by type:"; jq -r '.type' "$out/events-$kind.jsonl" | sort | uniq -c
  echo "model:"; jq -r 'select(.type=="thread.started" or .type=="turn.started") | .' "$out/events-$kind.jsonl" | head -12
  echo "usage:"; jq -c 'select(.type=="turn.completed") | .usage' "$out/events-$kind.jsonl"
  echo "stderr (head):"; head -5 "$out/stderr-$kind.txt"
  echo "last message:"; cat "$out/last-$kind.json"; echo
  echo "schema check (jq):"
  jq -e '
    (keys|sort) == ["findings","verdict"] and
    (.verdict|IN("pass","fix")) and
    (.findings|type) == "array" and
    all(.findings[]; (keys|sort) == ["claim","fix","line","path","severity","why"]
        and (.severity|IN("S1","S2","S3")) and (.line|type)=="number" and (.line>=0))
  ' "$out/last-$kind.json" >/dev/null && echo "  holds: object of the schema" || echo "  BROKEN: not an object of the schema"
done
