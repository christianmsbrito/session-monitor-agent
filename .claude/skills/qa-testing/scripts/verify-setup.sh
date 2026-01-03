#!/bin/bash
#
# Verify session-monitor setup before testing
#

echo "=== Session Monitor Setup Verification ==="
echo

PASS=0
FAIL=0

check() {
  if [ $1 -eq 0 ]; then
    echo "  [PASS] $2"
    ((PASS++))
  else
    echo "  [FAIL] $2"
    ((FAIL++))
  fi
}

# 1. Check if dist/ exists (built)
echo "1. Build Status"
if [ -f "dist/index.js" ]; then
  check 0 "dist/index.js exists"
else
  check 1 "dist/index.js missing - run 'npm run build'"
fi

# 2. Check ANTHROPIC_API_KEY
echo
echo "2. Environment"
if [ -n "$ANTHROPIC_API_KEY" ]; then
  check 0 "ANTHROPIC_API_KEY is set"
else
  check 1 "ANTHROPIC_API_KEY not set"
fi

# 3. Check hooks
echo
echo "3. Hook Installation"
if [ -f "$HOME/.claude/settings.json" ]; then
  if grep -q "SessionStart" "$HOME/.claude/settings.json" 2>/dev/null; then
    check 0 "SessionStart hook found"
  else
    check 1 "SessionStart hook missing"
  fi

  if grep -q "SessionEnd" "$HOME/.claude/settings.json" 2>/dev/null; then
    check 0 "SessionEnd hook found"
  else
    check 1 "SessionEnd hook missing"
  fi

  if grep -q "PostToolUse" "$HOME/.claude/settings.json" 2>/dev/null; then
    check 0 "PostToolUse hook found"
  else
    check 1 "PostToolUse hook missing"
  fi

  if grep -q "Stop" "$HOME/.claude/settings.json" 2>/dev/null; then
    check 0 "Stop hook found"
  else
    check 1 "Stop hook missing"
  fi
else
  check 1 "~/.claude/settings.json not found"
fi

# 4. Check socket
echo
echo "4. Monitor Status"
SOCKET_PATH="${TMPDIR}session-monitor.sock"
if [ -S "$SOCKET_PATH" ]; then
  check 0 "Socket exists at $SOCKET_PATH"
else
  check 1 "Socket not found - monitor may not be running"
fi

# Check process
if pgrep -f "node dist/index.js start" > /dev/null 2>&1; then
  check 0 "Monitor process running"
else
  check 1 "Monitor process not found"
fi

# Summary
echo
echo "=== Summary ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo

if [ $FAIL -eq 0 ]; then
  echo "All checks passed! Ready for testing."
  exit 0
else
  echo "Some checks failed. Fix issues before testing."
  exit 1
fi
