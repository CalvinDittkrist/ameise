# Print each reference to an ADR that has no file, as path:line: message. check.sh runs it from the repository root
# over the files that may cite an ADR. The variable adrs lists the ADR file names under docs/adr, one per line.
# A reference is a relative Markdown link or a link definition to an ADR file, or the bare form ADR plus four digits.
# A URL with a scheme is not a reference.
BEGIN { n = split(adrs, a, "\n"); for (i = 1; i <= n; i++) { have["docs/adr/" a[i]] = 1; num[substr(a[i], 1, 4)] = 1 } }

# norm: a path without empty, . and .. segments; empty when it climbs above the root.
function norm(p,   parts, out, n, i, k, s) {
  n = split(p, parts, "/"); k = 0
  for (i = 1; i <= n; i++) {
    s = parts[i]
    if (s == "" || s == ".") continue
    if (s == "..") { if (k == 0) return ""; k--; continue }
    out[++k] = s
  }
  p = ""; for (i = 1; i <= k; i++) p = p (i > 1 ? "/" : "") out[i]
  return p
}

# target: report a link target that resolves to an ADR file under docs/adr that does not exist.
function target(t,   d, p) {
  sub(/^</, "", t); sub(/>.*$/, "", t); sub(/#.*$/, "", t)
  if (t ~ /^[A-Za-z][A-Za-z0-9+.-]*:/ || t !~ /(^|\/)[0-9][0-9][0-9][0-9]-[^\/]*\.md$/) return
  if (t ~ /^\//) p = norm(t)
  else { d = FILENAME; if (d ~ /\//) sub(/\/[^\/]*$/, "", d); else d = "."; p = norm(d "/" t) }
  if (p ~ /^docs\/adr\/[0-9][0-9][0-9][0-9]-[^\/]*\.md$/ && !(p in have))
    printf "%s:%d: links %s, an ADR with no file; link an ADR that exists or state the reason\n", FILENAME, FNR, p
}

{
  s = $0
  while (match(s, /\]\([^) \t]+/)) { target(substr(s, RSTART + 2, RLENGTH - 2)); s = substr(s, RSTART + RLENGTH) }
  s = $0
  while (match(s, /\]:[ \t]+[^ \t]+/)) { t = substr(s, RSTART + 2, RLENGTH - 2); sub(/^[ \t]+/, "", t); target(t); s = substr(s, RSTART + RLENGTH) }
  s = $0; gsub(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^ \t)>]*/, "", s)
  while (match(s, /ADR[ -]?[0-9][0-9][0-9][0-9]/)) {
    pre = RSTART > 1 ? substr(s, RSTART - 1, 1) : ""; post = substr(s, RSTART + RLENGTH, 1); d = substr(s, RSTART + RLENGTH - 4, 4)
    if (pre !~ /[A-Za-z0-9_]/ && post !~ /[0-9]/ && !(d in num))
      printf "%s:%d: cites ADR %s, which has no file; cite an ADR that exists or state the reason\n", FILENAME, FNR, d
    s = substr(s, RSTART + RLENGTH)
  }
}
