# Test Scenarios

Detailed test cases and mock transcript templates for QA testing.

---

## Mock Transcript Templates

### Template 1: Bug Fix Scenario

Tests: `user_request`, `agent_analysis`, `user_confirmed`, `solution_verified`

```bash
SESSION_ID="test-bugfix-$(date +%s)"
TRANSCRIPT_PATH="${TMPDIR}mock-claude-session/${SESSION_ID}.jsonl"

cat > "$TRANSCRIPT_PATH" << 'JSONL'
{"type":"user","message":{"role":"user","content":"Help me fix a bug in the authentication system"},"uuid":"msg-1","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:00.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll help you debug the authentication system. Let me first look at the code to understand the current implementation."}]},"uuid":"msg-2","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:05.000Z"}
{"type":"user","message":{"role":"user","content":"yes, that's correct, the bug is in the JWT validation"},"uuid":"msg-3","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:30.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I found the bug! The issue was in the JWT token expiration validation. The comparison was using greater-than instead of greater-than-or-equal, causing tokens to be rejected one second early. Here's the fix."}]},"uuid":"msg-4","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:01:00.000Z"}
{"type":"user","message":{"role":"user","content":"great, that fixed it! the tests are passing now"},"uuid":"msg-5","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:02:00.000Z"}
JSONL

sed -i '' "s/SESSION_ID/$SESSION_ID/g" "$TRANSCRIPT_PATH"
```

**Expected Events:**
1. `user_request` - "Help me fix a bug..."
2. `user_confirmed` - "yes, that's correct..."
3. `agent_analysis` - Bug root cause identified
4. `solution_verified` - "that fixed it!"

---

### Template 2: Decision Making Scenario

Tests: `user_request`, `decision_made`, `agent_suggestion`

```bash
SESSION_ID="test-decision-$(date +%s)"
TRANSCRIPT_PATH="${TMPDIR}mock-claude-session/${SESSION_ID}.jsonl"

cat > "$TRANSCRIPT_PATH" << 'JSONL'
{"type":"user","message":{"role":"user","content":"Should we use PostgreSQL or MongoDB for the new microservice?"},"uuid":"msg-1","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:00.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me analyze the trade-offs. Given your requirements for complex queries and ACID transactions, I recommend PostgreSQL. MongoDB would be better for document-heavy workloads with flexible schemas, but your data model is relational."}]},"uuid":"msg-2","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:10.000Z"}
{"type":"user","message":{"role":"user","content":"Good analysis. Let's go with PostgreSQL then."},"uuid":"msg-3","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:30.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Great decision. I'll set up the PostgreSQL schema based on your data model. The key trade-off we're accepting is slightly more rigid schema management in exchange for better query performance and transaction support."}]},"uuid":"msg-4","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:45.000Z"}
JSONL

sed -i '' "s/SESSION_ID/$SESSION_ID/g" "$TRANSCRIPT_PATH"
```

**Expected Events:**
1. `user_request` - Database choice question
2. `agent_suggestion` - PostgreSQL recommendation
3. `decision_made` - "Let's go with PostgreSQL"

---

### Template 3: Feature Request Scenario

Tests: `user_request`, `requirement_clarified`, `user_provided`

```bash
SESSION_ID="test-feature-$(date +%s)"
TRANSCRIPT_PATH="${TMPDIR}mock-claude-session/${SESSION_ID}.jsonl"

cat > "$TRANSCRIPT_PATH" << 'JSONL'
{"type":"user","message":{"role":"user","content":"I want to add dark mode to the dashboard"},"uuid":"msg-1","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:00.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I can help you implement dark mode. A few questions: Should it respect system preferences? Do you want a toggle in the UI? Should the preference persist across sessions?"}]},"uuid":"msg-2","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:05.000Z"}
{"type":"user","message":{"role":"user","content":"Yes to all three. Also, the color scheme should match our brand - dark blue (#1a1a2e) as the background."},"uuid":"msg-3","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:30.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Got it. I'll implement dark mode with: 1) System preference detection via prefers-color-scheme, 2) A toggle button in the header, 3) localStorage persistence, 4) Dark blue (#1a1a2e) as primary background. Starting implementation now."}]},"uuid":"msg-4","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:45.000Z"}
JSONL

sed -i '' "s/SESSION_ID/$SESSION_ID/g" "$TRANSCRIPT_PATH"
```

**Expected Events:**
1. `user_request` - Dark mode request
2. `requirement_clarified` - Questions answered
3. `user_provided` - Brand color specification

---

### Template 4: Empty Transcript (Edge Case)

Tests: Graceful handling of empty input

```bash
SESSION_ID="test-empty-$(date +%s)"
TRANSCRIPT_PATH="${TMPDIR}mock-claude-session/${SESSION_ID}.jsonl"
touch "$TRANSCRIPT_PATH"
```

**Expected Behavior:** No crash, no documentation created, possibly a log message.

---

### Template 5: Malformed JSON (Edge Case)

Tests: Error handling for invalid input

```bash
SESSION_ID="test-malformed-$(date +%s)"
TRANSCRIPT_PATH="${TMPDIR}mock-claude-session/${SESSION_ID}.jsonl"

cat > "$TRANSCRIPT_PATH" << 'JSONL'
{"type":"user","message":{"role":"user","content":"Valid message"},"uuid":"msg-1","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:00.000Z"}
{invalid json here
{"type":"user","message":{"role":"user","content":"Another valid message"},"uuid":"msg-2","sessionId":"SESSION_ID","timestamp":"2026-01-02T10:00:05.000Z"}
JSONL

sed -i '' "s/SESSION_ID/$SESSION_ID/g" "$TRANSCRIPT_PATH"
```

**Expected Behavior:** Skip invalid line, process valid messages.

---

### Template 6: Large Transcript (Edge Case)

Tests: Batching and backpressure handling

```bash
SESSION_ID="test-large-$(date +%s)"
TRANSCRIPT_PATH="${TMPDIR}mock-claude-session/${SESSION_ID}.jsonl"

# Generate 100 messages
for i in $(seq 1 100); do
  echo "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Message $i: Testing batch processing\"},\"uuid\":\"msg-$i\",\"sessionId\":\"$SESSION_ID\",\"timestamp\":\"2026-01-02T10:00:$(printf '%02d' $((i % 60))).000Z\"}"
done > "$TRANSCRIPT_PATH"
```

**Expected Behavior:** Messages processed in batches (default: 10), no memory issues.

---

## Sending Events to Socket

### Helper Function

```bash
send_event() {
  local TYPE=$1
  local SESSION_ID=$2
  local TRANSCRIPT_PATH=$3
  local SOCKET_PATH="${TMPDIR}session-monitor.sock"

  echo "{\"type\":\"$TYPE\",\"sessionId\":\"$SESSION_ID\",\"transcriptPath\":\"$TRANSCRIPT_PATH\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"data\":{}}" | nc -U "$SOCKET_PATH"
}

# Usage:
# send_event "SessionStart" "test-session-123" "/path/to/transcript.jsonl"
# send_event "PostToolUse" "test-session-123" "/path/to/transcript.jsonl"
# send_event "SessionEnd" "test-session-123" "/path/to/transcript.jsonl"
```

---

## Full Test Sequence

Run this complete sequence to test all scenarios:

```bash
#!/bin/bash
set -e

MOCK_DIR="${TMPDIR}mock-claude-session"
SOCKET_PATH="${TMPDIR}session-monitor.sock"

mkdir -p "$MOCK_DIR"

echo "=== Starting Full Test Sequence ==="

# Test 1: Bug Fix Scenario
echo "Test 1: Bug Fix Scenario"
SESSION_ID="test-bugfix-$(date +%s)"
# [Create transcript using Template 1]
# send_event "SessionStart" "$SESSION_ID" "$MOCK_DIR/${SESSION_ID}.jsonl"
# send_event "PostToolUse" "$SESSION_ID" "$MOCK_DIR/${SESSION_ID}.jsonl"
sleep 3

# Test 2: Decision Making
echo "Test 2: Decision Making Scenario"
SESSION_ID="test-decision-$(date +%s)"
# [Create transcript using Template 2]
# send_event "SessionStart" "$SESSION_ID" "$MOCK_DIR/${SESSION_ID}.jsonl"
# send_event "PostToolUse" "$SESSION_ID" "$MOCK_DIR/${SESSION_ID}.jsonl"
sleep 3

# Test 3: Concurrent Sessions
echo "Test 3: Concurrent Sessions"
SESSION_A="test-concurrent-a-$(date +%s)"
SESSION_B="test-concurrent-b-$(date +%s)"
# [Create both transcripts]
# send_event "SessionStart" "$SESSION_A" "..."
# send_event "SessionStart" "$SESSION_B" "..."
# send_event "PostToolUse" "$SESSION_A" "..."
# send_event "PostToolUse" "$SESSION_B" "..."
sleep 3

# Cleanup
echo "Cleaning up..."
rm -rf "$MOCK_DIR"

echo "=== Test Sequence Complete ==="
```

---

## Verification Checklist

After each test, verify:

- [ ] Session folder created in `.session-docs/sessions/YYYY-MM-DD/`
- [ ] `session.md` contains correct metadata
- [ ] Event files numbered sequentially (001-, 002-, etc.)
- [ ] Event types match expected values
- [ ] Confidence levels correct (confirmed vs unconfirmed)
- [ ] `running-summary.md` updated
- [ ] `.dedup-state.json` exists
- [ ] No duplicate events for same content
- [ ] No errors in monitor logs
