#!/usr/bin/env bash
# Print the CHANGELOG.md section for one version, and fail if there is not exactly one.
#
# This exists because the release step it feeds used to be a manual habit. 0.6.0's git tag,
# npm packages and GHCR images all shipped, and the GitHub Release was simply forgotten - it
# surfaced days later when someone installing the version noticed the tag had no release.
# A step nobody performs leaves no trace, so the only durable fix is a step that fails.
#
# Which means the failure modes here matter more than the happy path. Printing an empty body
# would reproduce the original defect in a form that looks like it worked: a release exists,
# so nothing is obviously missing, and the notes are gone. Both "no section" and "more than
# one section" are errors rather than empty output.
#
# Usage: changelog-section.sh 0.6.0 [path/to/CHANGELOG.md]
set -euo pipefail

VERSION="${1:?usage: changelog-section.sh <version> [changelog]}"
CHANGELOG="${2:-CHANGELOG.md}"

[ -r "$CHANGELOG" ] || { echo "changelog-section: cannot read $CHANGELOG" >&2; exit 1; }

# Match the heading literally rather than by regex: `[0.6.0]` must not be found by a search
# for `0.6.0` that would also hit a link, a date, or a sentence mentioning the version.
# awk's index() takes the string as a string, so a version containing `.` cannot widen it.
section=$(
  awk -v want="## [$VERSION]" '
    index($0, want) == 1 { found++; printing = 1; next }
    /^## \[/ && printing  { printing = 0 }
    printing              { print }
    END                   { if (found != 1) exit 3 }
  ' "$CHANGELOG"
) || {
  echo "changelog-section: expected exactly one '## [$VERSION]' heading in $CHANGELOG" >&2
  exit 1
}

# A heading with nothing under it is the same silent hole as no heading at all.
if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  echo "changelog-section: the '## [$VERSION]' section is empty" >&2
  exit 1
fi

printf '%s\n' "$section"
