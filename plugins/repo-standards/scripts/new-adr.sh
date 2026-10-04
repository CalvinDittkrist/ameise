#!/usr/bin/env bash
# Create an ADR under the index's next free number from the template, add it to the index and raise that number.
# A number is never reused, so an old commit's ADR number stays unambiguous after a deletion.
# Usage: new-adr.sh <title words...>
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
dir="$root/docs/adr"; [ -d "$dir" ] || { echo "error: docs/adr missing; run scaffold.sh first" >&2; exit 1; }
[ $# -gt 0 ] || { echo "usage: new-adr.sh <title>" >&2; exit 1; }
title="$*"
idx="$dir/README.md"
last=$(printf '%s\n' "$dir"/[0-9][0-9][0-9][0-9]-*.md | sed -nE 's#.*/([0-9]{4})-.*\.md$#\1#p' | sort | tail -n1); last=${last:-0000}
next=$(adr_next_free "$idx")
# The index's number, or one above the highest file when the index has none or lags behind.
if [ -z "$next" ]; then
  echo "warn: docs/adr/README.md has no line Next free number: NNNN; add it so a number is never reused" >&2
  n=$((10#$last + 1))
else n=$((10#$next > 10#$last ? 10#$next : 10#$last + 1)); fi
num=$(printf '%04d' "$n")
slug=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-60 | sed -E 's/-+$//')
file="$dir/$num-$slug.md"
tpl="$dir/template.md"; [ -f "$tpl" ] || tpl="$(dirname "$0")/../templates/adr-template.md"
sed -e "s/{{NUMBER}}/$num/g" -e "s/{{TITLE}}/$(printf '%s' "$title" | sed 's/[&/\]/\\&/g')/g" -e "s/{{DATE}}/$(date +%Y-%m-%d)/g" "$tpl" > "$file"
if [ -f "$idx" ]; then
  if grep -q '^| ADR |' "$idx"; then printf '| [%s](%s) | %s | proposed |\n' "$num" "$(basename "$file")" "$title" >> "$idx"; fi
  if [ -n "$next" ]; then
    raised=$(sed -E "s/^Next free number: [0-9]{4}[[:space:]]*\$/Next free number: $(printf '%04d' $((n + 1)))/" "$idx")
    printf '%s\n' "$raised" > "$idx"
  fi
fi
printf 'created: docs/adr/%s\n' "$(basename "$file")"
if ! max=$(adr_max); then
  echo "warn: WF_ADR_MAX=$max is not a positive integer, so the warning on a full set counts to 20; set it to the most ADRs the repository keeps" >&2
  max=20
fi
count=$(printf '%s\n' "$dir"/[0-9][0-9][0-9][0-9]-*.md | grep -c .)
if [ "$count" -gt "$max" ]; then
  echo "warn: $count ADRs (>$max); remove one, or move it as a rule with its reason into the document of its area" >&2
fi
