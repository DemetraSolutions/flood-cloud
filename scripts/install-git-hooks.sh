#!/bin/sh
# Points this clone's git hooks to the versioned .githooks/ folder (secret scanning before each commit).
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "git hooks enabled: .githooks/pre-commit (gitleaks)"
