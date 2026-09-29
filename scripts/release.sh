#!/usr/bin/env bash
# Tag a release: a plugin (bump version in its plugin.json first), the factory (bump factory/VERSION) or
# the controller (bump version in controller/package.json).
# Usage: release.sh <plugin|factory|controller> [--push]
set -euo pipefail
cd "$(dirname "$0")/.."
usage="usage: release.sh <plugin|factory|controller> [--push]"
target="${1:?$usage}"; shift || true
die() { echo "error: $*" >&2; exit 1; }

if [ "$target" != factory ] && [ "$target" != controller ]; then
  claude plugin validate "plugins/$target" --strict
  claude plugin tag "plugins/$target" -m "$target v%s" "$@"
  exit
fi

# The factory and the controller are no plugins: the factory ships as a static binary and the controller
# as an npm package, so the release of either is a tag CI builds and attaches to a GitHub release.
push=""
for arg in "$@"; do
  case "$arg" in
    --push) push=yes ;;
    *) die "unknown option $arg; $usage" ;;
  esac
done
if [ "$target" = factory ]; then
  file=factory/VERSION
  [ -f "$file" ] || die "$file is missing; it is the one place the factory's version is written"
  # Read as the binary reads it: factory/version.go embeds the file and trims its ends, so whitespace
  # inside it is part of the version the binary reports. Stripping it here would tag a version nothing
  # else in the release ever says.
  version=$(cat "$file")
  built="CI builds the static linux binaries and attaches them to the release"
else
  file=controller/package.json
  [ -f "$file" ] || die "$file is missing; its version is the one the controller's package is released under"
  command -v node >/dev/null || die "node is not installed; brew install node (or https://nodejs.org), it reads the version of $file"
  # Read as npm reads it, the version field of the JSON; npm packs exactly that string.
  version=$(node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version; process.stdout.write(typeof v === "string" ? v : "")' "$file") \
    || die "$file is no JSON npm can read; fix it and commit"
  built="CI packs the controller with its dashboard and plugins and attaches the package to the release"
fi
if ! printf '%s' "$version" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+' \
  || [ "$(printf '%s\n' "$version" | wc -l | tr -d '[:space:]')" != 1 ]; then
  die "$file says \"$version\"; write the version as X.Y.Z on one line"
fi
# The namespace: a plugin release is tagged <plugin>--vX.Y.Z and a milestone vX.Y.Z, so a tag with a
# slash in it can be neither. For the factory it is also the tag its Go module would be published under.
tag="$target/v$version"
if [ -n "$(git status --porcelain)" ]; then
  die "the working tree has uncommitted changes; commit them, so the tag names what is released"
fi
# What a release ships is built from what was reviewed and merged, so origin decides what is
# taggable, not this checkout: one question asks whether the tag is taken there and what main points
# at (docs/repo-standard.md: releases are tagged on main).
remote=$(git ls-remote origin "refs/tags/$tag" refs/heads/main) \
  || die "cannot read the tags and branches of origin; a release is tagged from a checkout that reaches it"
if printf '%s\n' "$remote" | awk -v t="refs/tags/$tag" '$2 == t { taken = 1 } END { exit !taken }'; then
  die "the tag $tag exists on origin; bump the version in $file and commit it"
fi
main=$(printf '%s\n' "$remote" | awk '$2 == "refs/heads/main" { print $1 }')
[ -n "$main" ] || die "origin has no main branch; releases are tagged on main (docs/repo-standard.md)"
if tagged=$(git rev-parse -q --verify "refs/tags/$tag^{commit}"); then
  # Tagged here and never pushed, which is where a run without --push ends: the release is one push
  # away, so this says that rather than to bump a version the tag already carries. That holds only
  # while the tag names what origin/main names: CI asks whether the tagged commit is on main, not
  # whether it is its tip, so a tag left over from an earlier attempt would release an older build
  # under this version.
  [ "$tagged" = "$main" ] || die "the tag $tag exists here and names $tagged, which is not origin/main \
($main); it would release an older $target, so delete it with: git tag -d $tag"
  die "the tag $tag exists here and not on origin; push it with: git push origin $tag"
fi
head=$(git rev-parse HEAD)
[ "$head" = "$main" ] || die "HEAD is $head and origin/main is $main; releases are tagged on main \
(docs/repo-standard.md), so a release is built from a commit that was reviewed and gated"
# The gate is what a release stands on: what CI builds from the tag is never gated again.
make check || die "the gate failed; a release is tagged from a green gate, fix it and run this again"
git tag -a "$tag" -m "$target v$version"
echo "tagged $tag"
if [ -n "$push" ]; then
  git push origin "$tag"
  echo "pushed $tag; $built"
else
  echo "push it with: git push origin $tag"
fi
