#!/bin/bash
#
# Check session-docs output structure and content
#
# Usage: ./check-output.sh [session-docs-path]
#

SESSION_DOCS="${1:-.session-docs}"

echo "=== Session Documentation Check ==="
echo "Path: $SESSION_DOCS"
echo

if [ ! -d "$SESSION_DOCS" ]; then
  echo "ERROR: Directory not found: $SESSION_DOCS"
  exit 1
fi

# Check index.md
echo "1. Index File"
if [ -f "$SESSION_DOCS/index.md" ]; then
  echo "  [PASS] index.md exists"
  LINES=$(wc -l < "$SESSION_DOCS/index.md" | tr -d ' ')
  echo "  Lines: $LINES"
else
  echo "  [FAIL] index.md missing"
fi

# Check sessions directory
echo
echo "2. Sessions Directory"
if [ -d "$SESSION_DOCS/sessions" ]; then
  echo "  [PASS] sessions/ exists"

  # Count date folders
  DATE_FOLDERS=$(find "$SESSION_DOCS/sessions" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  echo "  Date folders: $DATE_FOLDERS"

  # Count total sessions
  SESSION_FOLDERS=$(find "$SESSION_DOCS/sessions" -mindepth 2 -maxdepth 2 -type d | wc -l | tr -d ' ')
  echo "  Session folders: $SESSION_FOLDERS"
else
  echo "  [FAIL] sessions/ missing"
fi

# List recent sessions
echo
echo "3. Recent Sessions"
RECENT=$(find "$SESSION_DOCS/sessions" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort -r | head -5)
if [ -n "$RECENT" ]; then
  for SESSION in $RECENT; do
    SESSION_NAME=$(basename "$SESSION")
    echo "  - $SESSION_NAME"

    # Check session structure
    if [ -f "$SESSION/session.md" ]; then
      echo "      [PASS] session.md"
    else
      echo "      [FAIL] session.md missing"
    fi

    EVENT_COUNT=$(ls -1 "$SESSION/events/" 2>/dev/null | wc -l | tr -d ' ')
    echo "      Events: $EVENT_COUNT"

    if [ -f "$SESSION/summaries/running-summary.md" ]; then
      echo "      [PASS] running-summary.md"
    else
      echo "      [WARN] running-summary.md missing"
    fi

    if [ -f "$SESSION/.dedup-state.json" ]; then
      echo "      [PASS] .dedup-state.json"
    else
      echo "      [WARN] .dedup-state.json missing"
    fi

    echo
  done
else
  echo "  No sessions found"
fi

# Check event types
echo "4. Event Type Distribution"
EVENT_FILES=$(find "$SESSION_DOCS" -path "*/events/*.md" -type f 2>/dev/null)
if [ -n "$EVENT_FILES" ]; then
  echo "  Total event files: $(echo "$EVENT_FILES" | wc -l | tr -d ' ')"
  echo
  echo "  By type:"
  echo "$EVENT_FILES" | xargs -I {} basename {} | sed 's/[0-9]*-//' | sort | uniq -c | sort -rn | while read count type; do
    echo "    $type: $count"
  done
else
  echo "  No event files found"
fi

# Check for issues
echo
echo "5. Potential Issues"
ISSUES=0

# Check for empty event files
EMPTY=$(find "$SESSION_DOCS" -path "*/events/*.md" -type f -empty 2>/dev/null | wc -l | tr -d ' ')
if [ "$EMPTY" -gt 0 ]; then
  echo "  [WARN] Empty event files: $EMPTY"
  ((ISSUES++))
fi

# Check for very small session.md files (likely incomplete)
SMALL=$(find "$SESSION_DOCS" -name "session.md" -type f -size -100c 2>/dev/null | wc -l | tr -d ' ')
if [ "$SMALL" -gt 0 ]; then
  echo "  [WARN] Very small session.md files: $SMALL"
  ((ISSUES++))
fi

if [ $ISSUES -eq 0 ]; then
  echo "  No issues found"
fi

echo
echo "=== Check Complete ==="
