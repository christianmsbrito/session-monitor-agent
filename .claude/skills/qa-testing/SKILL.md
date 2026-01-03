---
name: qa-testing
description: Manual QA testing for session-monitor agent. Use when testing features manually, verifying functionality works end-to-end, before releases, or when asked to test the session monitor. Covers hook verification, session lifecycle, transcript parsing, documentation generation, and edge cases.
---

# QA Testing: Session Monitor Agent

You are a QA tester for the session-monitor-agent application. Your job is to thoroughly test the application and produce a comprehensive test report.

## Overview

Session-monitor is a background documentation agent that:
1. Watches Claude Code sessions via hooks (PostToolUse, Stop, SessionStart, SessionEnd)
2. Reads transcript files and detects significant events
3. Uses Claude Haiku to analyze and document events
4. Writes structured markdown documentation to `.session-docs/`

## Architecture Reference

```
Claude Code Session
    ↓
Claude Hooks (PostToolUse, Stop, SessionStart, SessionEnd)
    ↓
Hook Script (src/hooks/hook-script.ts) → Unix socket
    ↓
SocketServer (src/server/socket-server.ts)
    ↓
SessionWatcher (src/watcher/session-watcher.ts)
    ↓
TranscriptReader (src/server/transcript-reader.ts)
    ↓
SignificanceDetector (src/documentation/significance-detector.ts)
    ↓
DocumentationAgent (src/documentation/doc-agent.ts) → Claude Haiku
    ↓
DeduplicationTracker (src/documentation/deduplication.ts)
    ↓
FileManager (src/output/file-manager.ts) → .session-docs/
```

## Testing Process

Follow these steps in order. Document results as you go.

### Phase 1: Environment Setup

1. **Build the project**
   ```bash
   npm run build
   ```
   - Verify: No TypeScript errors

2. **Check API key**
   ```bash
   echo "ANTHROPIC_API_KEY set: $([ -n \"$ANTHROPIC_API_KEY\" ] && echo 'YES' || echo 'NO')"
   ```
   - Verify: Must be YES

3. **Check hook status**
   ```bash
   node dist/index.js status
   ```
   - Verify: All 4 hooks installed (PostToolUse, Stop, SessionStart, SessionEnd)

4. **Install hooks if needed**
   ```bash
   node dist/index.js install
   ```

### Phase 2: Monitor Startup

1. **Start monitor in background with verbose logging**
   ```bash
   node dist/index.js start -v -o .session-docs 2>&1 &
   ```

2. **Verify socket created**
   ```bash
   ls -la "${TMPDIR}session-monitor.sock"
   ```

3. **Check monitor is running**
   ```bash
   ps aux | grep "node dist/index.js" | grep -v grep
   ```

### Phase 3: Session Simulation

Create mock sessions to test the full pipeline without needing real Claude Code sessions.

1. **Create mock transcript directory**
   ```bash
   MOCK_DIR="${TMPDIR}mock-claude-session"
   mkdir -p "$MOCK_DIR"
   ```

2. **Create mock transcript file** (see test-scenarios.md for templates)

3. **Send SessionStart event to socket**
   ```bash
   SOCKET_PATH="${TMPDIR}session-monitor.sock"
   echo '{"type":"SessionStart","sessionId":"test-session-id","transcriptPath":"path/to/transcript.jsonl","timestamp":"..."}' | nc -U "$SOCKET_PATH"
   ```

4. **Send PostToolUse event to trigger processing**
   ```bash
   echo '{"type":"PostToolUse","sessionId":"test-session-id","transcriptPath":"path/to/transcript.jsonl","timestamp":"..."}' | nc -U "$SOCKET_PATH"
   ```

### Phase 4: Documentation Verification

1. **Check output structure**
   ```bash
   find .session-docs -type f -name "*.md" | sort
   ```

2. **Verify session folder created**
   - Should have: `session.md`, `events/`, `summaries/`

3. **Check event types detected**
   - `user_request` - User asking for something
   - `user_confirmed` - User saying "yes", "correct", etc.
   - `agent_analysis` - Agent's conclusions
   - `solution_verified` - User confirming fix works

4. **Verify deduplication**
   - Check `.dedup-state.json` exists in session folder
   - Repeated events should not create duplicate files

### Phase 5: Edge Cases

Test these scenarios (see test-scenarios.md for details):

1. **Empty transcript** - Should handle gracefully
2. **Malformed JSON** - Should skip bad entries
3. **Concurrent sessions** - Should create separate folders
4. **Monitor restart** - Should resume without duplicates
5. **Large transcript** - Should handle batching

### Phase 6: Feature Exploration

Examine source code for undocumented features:

1. **Check CLI options**
   ```bash
   node dist/index.js start --help
   node dist/index.js install --help
   ```

2. **Review config defaults** in `src/types/config.ts`

3. **Check environment variables**
   - `SESSION_MONITOR_SOCKET`
   - `SESSION_MONITOR_DEBUG`

4. **Examine significance patterns** in `src/documentation/significance-detector.ts`

### Phase 7: Cleanup

1. **Kill test monitor**
   ```bash
   pkill -f "node dist/index.js start"
   ```

2. **Remove mock files**
   ```bash
   rm -rf "${TMPDIR}mock-claude-session"
   ```

## Output Requirement

**CRITICAL**: At the end of testing, you MUST create or update `TESTING.md` with this structure:

```markdown
# Session Monitor Testing Log

**Date:** [YYYY-MM-DD]
**Tester:** Claude QA Agent

---

## Test Plan

[List what was tested]

---

## Test Results

### 1. Build Project

**Status:** PASSED/FAILED
**Command:** `npm run build`

[Output and observations]

---

### 2. Hook Installation

**Status:** PASSED/FAILED

[Details]

---

### 3. Monitor Startup

**Status:** PASSED/FAILED

[Details about socket, process, initial logs]

---

### 4. Session Simulation

**Status:** PASSED/FAILED

#### Mock Sessions Created
- [List mock sessions and their purposes]

#### Events Detected
- [List event types that were correctly identified]

---

### 5. Documentation Verification

**Status:** PASSED/FAILED

#### Output Structure
```
[Tree of .session-docs/]
```

#### Event Type Detection
| Input | Expected Type | Actual Type | Correct? |
|-------|---------------|-------------|----------|

#### Content Quality
- Session subjects: [observations]
- Evidence quotes: [observations]
- Confidence levels: [observations]

---

### 6. Edge Cases & Error Handling

| Test Case | Status | Notes |
|-----------|--------|-------|

---

### 7. Undocumented Features Found

[List any features discovered that aren't in README/CLAUDE.md]

---

### 8. Issues Found

#### Critical
[Breaking issues]

#### Minor
[Non-critical issues]

---

### 9. Feature Verification Matrix

| Feature | Status | Notes |
|---------|--------|-------|
| Hook detection | | |
| Socket communication | | |
| Transcript parsing | | |
| Significance detection | | |
| Deduplication | | |
| Multi-session support | | |
| Event categorization | | |
| Confidence levels | | |
| File manager | | |
| Running summary | | |

---

### 10. Recommendations

[Suggestions for improvements]

---

*Testing completed: [timestamp]*
```

## Event Types Reference

**Confirmed (user verified):**
- `user_request` - What the user asked for
- `user_confirmed` - User said "yes", "correct", "that's right"
- `user_provided` - Information user directly gave
- `solution_verified` - User confirmed fix works
- `requirement_clarified` - Requirements confirmed

**Unconfirmed (agent analysis):**
- `agent_analysis` - Agent's understanding
- `agent_suggestion` - Agent's recommendation
- `bug_identified` - Root cause found
- `decision_made` - Architectural decision

**Special:**
- `correction` - Invalidates previous documentation

## Tips

1. **Be thorough** - Test every CLI command and option
2. **Check logs** - Monitor verbose output for errors
3. **Verify content quality** - Don't just check files exist, read them
4. **Test boundaries** - Empty inputs, large inputs, concurrent access
5. **Document everything** - The TESTING.md file is the deliverable
