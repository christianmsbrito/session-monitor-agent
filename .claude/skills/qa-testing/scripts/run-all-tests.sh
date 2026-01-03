#!/bin/bash
#
# Run all QA test scenarios
#
# Usage: ./run-all-tests.sh [output-dir]
#

set -e

OUTPUT_DIR="${1:-.session-docs}"
SCRIPT_DIR="$(dirname "$0")"
MOCK_DIR="${TMPDIR}mock-claude-session"

echo "=========================================="
echo "  Session Monitor QA Test Suite"
echo "=========================================="
echo
echo "Output directory: $OUTPUT_DIR"
echo "Mock directory: $MOCK_DIR"
echo

# Cleanup function
cleanup() {
  echo
  echo "Cleaning up..."
  rm -rf "$MOCK_DIR"
  echo "Done."
}
trap cleanup EXIT

# Phase 1: Setup verification
echo "=== Phase 1: Setup Verification ==="
bash "$SCRIPT_DIR/verify-setup.sh" || {
  echo "Setup verification failed. Fix issues and retry."
  exit 1
}
echo

# Phase 2: Run test scenarios
echo "=== Phase 2: Test Scenarios ==="
echo

SCENARIOS="bugfix decision feature"
for SCENARIO in $SCENARIOS; do
  echo "--- Testing: $SCENARIO ---"
  bash "$SCRIPT_DIR/create-mock-session.sh" "$SCENARIO"
  sleep 3  # Wait for processing
  echo
done

# Phase 3: Edge cases
echo "=== Phase 3: Edge Cases ==="
echo

echo "--- Testing: empty transcript ---"
bash "$SCRIPT_DIR/create-mock-session.sh" empty || true
sleep 2
echo

echo "--- Testing: malformed JSON ---"
bash "$SCRIPT_DIR/create-mock-session.sh" malformed || true
sleep 2
echo

# Phase 4: Check output
echo "=== Phase 4: Output Verification ==="
bash "$SCRIPT_DIR/check-output.sh" "$OUTPUT_DIR"
echo

# Summary
echo "=========================================="
echo "  Test Suite Complete"
echo "=========================================="
echo
echo "Next steps:"
echo "  1. Review monitor logs for any errors"
echo "  2. Inspect .session-docs/ for generated documentation"
echo "  3. Create TESTING.md with your findings"
echo
