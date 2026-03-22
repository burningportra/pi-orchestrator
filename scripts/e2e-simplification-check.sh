#!/usr/bin/env bash
# E2E validation for UX simplifications S1/S2/S3/S5
# Run: bash scripts/e2e-simplification-check.sh
set -uo pipefail

PASS=0; FAIL=0

check() {
  local desc="$1"; shift
  if eval "$@" >/dev/null 2>&1; then
    echo "  ✅ $desc"; PASS=$((PASS + 1))
  else
    echo "  ❌ $desc"; FAIL=$((FAIL + 1))
  fi
}

echo "=== S1: Discovery mode removed ==="
check "No Standard/Creative/Wizard select in profile.ts" \
  '! grep -qE "Standard|Creative.*think.*100|Wizard.*rubric" src/tools/profile.ts'
check "discoveryInstructions has no mode param" \
  '! grep -q "mode.*standard.*wizard.*creative" src/prompts.ts'
check "No isCreative/isWizard in profile.ts" \
  '! grep -qE "isCreative|isWizard|discoveryModeKey" src/tools/profile.ts'
check "discoveryInstructions still exists" \
  'grep -q "export function discoveryInstructions" src/prompts.ts'
check "Wizard scoring axes present in discovery prompt" \
  'grep -q "Useful.*2.*weight" src/prompts.ts'

echo ""
echo "=== S2: Simplified approval options ==="
check "Advanced sub-menu exists in approve.ts" \
  'grep -q "Advanced options" src/tools/approve.ts'
check "Polish beads option exists for round 0" \
  'grep -q "Polish beads" src/tools/approve.ts'
check "Refine further option exists for round 1+" \
  'grep -q "Refine further" src/tools/approve.ts'
check "advancedOptions array built" \
  'grep -q "advancedOptions" src/tools/approve.ts'
check "Back option in advanced menu" \
  'grep -q "⬅️ Back" src/tools/approve.ts'

echo ""
echo "=== S3: Auto-advance gates ==="
check "Gate auto flag exists in gates.ts" \
  'grep -q "auto: true" src/gates.ts'
check "Auto gates skip select (gate.auto check exists)" \
  'grep -q "gate.auto" src/gates.ts'
check "All 7 gates present" \
  'test $(grep -c "label:" src/gates.ts | head -1) -ge 7'
check "Self-review is auto" \
  'grep -A1 "Fresh self-review" src/gates.ts | grep -q "auto: true"'
check "Peer review is prompted" \
  'grep -A1 "Peer review" src/gates.ts | grep -q "auto: false"'
check "Commit gate still exists" \
  'grep -q "Commit" src/gates.ts'

echo ""
echo "=== S5: No refinement for system ideas ==="
check "No refineChoice in select.ts" \
  '! grep -q "refineChoice" src/tools/select.ts'
check "No 'Would you like to refine' in select.ts" \
  '! grep -q "Would you like to refine" src/tools/select.ts'
check "runGoalRefinement still imported (for custom goals)" \
  'grep -q "runGoalRefinement" src/tools/select.ts'
check "Custom goal path still exists" \
  'grep -q "Enter a custom goal" src/tools/select.ts'

echo ""
echo "=== Build & Test ==="
check "npm run build succeeds" 'npm run build'
check "npm test succeeds" 'npm test'

echo ""
echo "════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
