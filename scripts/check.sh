#!/usr/bin/env bash
# Every check CI runs (P5-05d), in one command, from any directory:
#
#   scripts/check.sh            all checks
#   scripts/check.sh --no-tests static checks and dependency audits only (no pytest, unit or automation tests)
#
# Backend: ruff, ruff format --check, mypy --strict, pytest. Web: tsc, eslint, unit tests. Automation toolkit: tests,
# typecheck, eslint. Dependency audit: pip-audit on the locked backend dependencies (through uv; no install) and
# npm audit (production dependencies; high and critical fail unless listed with a reason and an unexpired review date in
# scripts/audit-allowlist.json) for web/ and automation/. Every step runs; the script
# fails at the end if any step failed. It never starts or stops servers and never touches databases or .env files.
# The mocked UI suite needs the web dev server and runs as its own CI job (see .github/workflows/ci.yml).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UV="${UV:-$(command -v uv || echo "$HOME/.local/bin/uv")}"
TESTS=1
[[ "${1:-}" == "--no-tests" ]] && TESTS=0

failed=()
step() {
  local name="$1"
  shift
  printf '\n==> %s\n' "$name"
  if "$@"; then
    printf -- '--- ok: %s\n' "$name"
  else
    printf -- '--- FAILED: %s\n' "$name"
    failed+=("$name")
  fi
}

in_dir() {
  local dir="$1"
  shift
  (cd "$ROOT/$dir" && "$@")
}

pip_audit() {
  # The exact locked set (with hashes), audited without installing anything.
  local req
  req="$(mktemp)"
  in_dir backend "$UV" export --frozen --format requirements-txt --no-emit-project --quiet >"$req" &&
    "$UV" tool run pip-audit --disable-pip --require-hashes --progress-spinner off -r "$req"
  local rc=$?
  rm -f "$req"
  return $rc
}

# ---------------------------------------------------------------- backend
step "backend: ruff check" in_dir backend "$UV" run --frozen ruff check .
step "backend: ruff format --check" in_dir backend "$UV" run --frozen ruff format --check .
step "backend: mypy --strict app" in_dir backend "$UV" run --frozen mypy --strict app
((TESTS)) && step "backend: pytest" in_dir backend "$UV" run --frozen pytest -q

# ---------------------------------------------------------------- web
step "web: tsc" in_dir web npx tsc --noEmit -p .
step "web: eslint" in_dir web npm run --silent lint
((TESTS)) && step "web: unit tests" in_dir web env PW_UNIT=1 npx playwright test --project=unit --reporter=line

# ---------------------------------------------------------------- automation toolkit
((TESTS)) && step "automation: tests" in_dir automation npm test --silent
step "automation: typecheck" in_dir automation npm run --silent typecheck
step "automation: eslint" in_dir automation npm run --silent lint

# ---------------------------------------------------------------- dependency audit
step "audit: backend (pip-audit)" pip_audit
step "audit: web (npm audit)" node "$ROOT/scripts/npm-audit.mjs" "$ROOT/web"
step "audit: automation (npm audit)" node "$ROOT/scripts/npm-audit.mjs" "$ROOT/automation"

printf '\n'
if ((${#failed[@]})); then
  printf 'FAILED (%d): %s\n' "${#failed[@]}" "$(IFS=';'; echo "${failed[*]}")"
  exit 1
fi
echo "All checks passed."
