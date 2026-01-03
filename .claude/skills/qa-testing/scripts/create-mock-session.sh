#!/bin/bash
#
# Create a mock session and send events to the monitor
#
# Usage: ./create-mock-session.sh <scenario>
# Scenarios: bugfix, decision, feature, empty, malformed
#

set -e

SCENARIO=${1:-bugfix}
MOCK_DIR="${TMPDIR}mock-claude-session"
SOCKET_PATH="${TMPDIR}session-monitor.sock"
SESSION_ID="test-${SCENARIO}-$(date +%s)"
TRANSCRIPT_PATH="${MOCK_DIR}/${SESSION_ID}.jsonl"

mkdir -p "$MOCK_DIR"

echo "Creating mock session: $SESSION_ID"
echo "Scenario: $SCENARIO"
echo "Transcript: $TRANSCRIPT_PATH"
echo

# Create transcript based on scenario
case $SCENARIO in
  bugfix)
    cat > "$TRANSCRIPT_PATH" << JSONL
{"type":"user","message":{"role":"user","content":"Help me fix a bug in the authentication system"},"uuid":"msg-1","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll help you debug the authentication system. Let me first look at the code to understand the current implementation."}]},"uuid":"msg-2","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{"type":"user","message":{"role":"user","content":"yes, that's correct, the bug is in the JWT validation"},"uuid":"msg-3","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I found the bug! The issue was in the JWT token expiration validation. The comparison was using greater-than instead of greater-than-or-equal. Here's the fix."}]},"uuid":"msg-4","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{"type":"user","message":{"role":"user","content":"great, that fixed it! the tests are passing now"},"uuid":"msg-5","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
JSONL
    ;;

  decision)
    cat > "$TRANSCRIPT_PATH" << JSONL
{"type":"user","message":{"role":"user","content":"Should we use PostgreSQL or MongoDB for the new microservice?"},"uuid":"msg-1","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me analyze the trade-offs. Given your requirements for complex queries and ACID transactions, I recommend PostgreSQL."}]},"uuid":"msg-2","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{"type":"user","message":{"role":"user","content":"Good analysis. Let's go with PostgreSQL then."},"uuid":"msg-3","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
JSONL
    ;;

  feature)
    cat > "$TRANSCRIPT_PATH" << JSONL
{"type":"user","message":{"role":"user","content":"I want to add dark mode to the dashboard"},"uuid":"msg-1","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I can help you implement dark mode. Should it respect system preferences?"}]},"uuid":"msg-2","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{"type":"user","message":{"role":"user","content":"Yes, and the color scheme should match our brand - dark blue (#1a1a2e) as the background."},"uuid":"msg-3","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
JSONL
    ;;

  empty)
    touch "$TRANSCRIPT_PATH"
    ;;

  malformed)
    cat > "$TRANSCRIPT_PATH" << JSONL
{"type":"user","message":{"role":"user","content":"Valid message"},"uuid":"msg-1","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{invalid json here
{"type":"user","message":{"role":"user","content":"Another valid message"},"uuid":"msg-2","sessionId":"$SESSION_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
JSONL
    ;;

  *)
    echo "Unknown scenario: $SCENARIO"
    echo "Available: bugfix, decision, feature, empty, malformed"
    exit 1
    ;;
esac

echo "Transcript created with $(wc -l < "$TRANSCRIPT_PATH" | tr -d ' ') lines"
echo

# Check if socket exists
if [ ! -S "$SOCKET_PATH" ]; then
  echo "ERROR: Socket not found at $SOCKET_PATH"
  echo "Is the monitor running? Start it with: node dist/index.js start -v"
  exit 1
fi

# Send SessionStart
echo "Sending SessionStart event..."
echo "{\"type\":\"SessionStart\",\"sessionId\":\"$SESSION_ID\",\"transcriptPath\":\"$TRANSCRIPT_PATH\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"data\":{}}" | nc -U "$SOCKET_PATH"
sleep 1

# Send PostToolUse to trigger processing
echo "Sending PostToolUse event..."
echo "{\"type\":\"PostToolUse\",\"sessionId\":\"$SESSION_ID\",\"transcriptPath\":\"$TRANSCRIPT_PATH\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"data\":{\"tool_name\":\"Read\"}}" | nc -U "$SOCKET_PATH"

echo
echo "Events sent! Check monitor logs and .session-docs/ for output."
echo "Session ID: $SESSION_ID"
