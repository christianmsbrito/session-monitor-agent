/**
 * FileManager - Manages documentation output file structure
 *
 * Directory structure:
 * .session-docs/
 * ├── index.md
 * └── sessions/
 *     └── 2025-12-03/                    # Grouped by day
 *         ├── abc123-debugging-auth/     # sessionId-subject slug
 *         │   ├── session.md
 *         │   ├── events/
 *         │   └── summaries/
 *         └── def456-refactor-api/
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionMetadata } from '../types/index.js';

export class FileManager {
  private sessionDir: string;
  private eventsDir: string;
  private summariesDir: string;
  private eventCounter: number = 0;
  private initialized: boolean = false;
  private sessionSubject: string | null = null;
  private dateStr: string;
  private shortSessionId: string;
  private subjectLocked: boolean = false;  // Prevents subject changes after finding existing dir

  constructor(
    private outputDir: string,
    private sessionId: string
  ) {
    // Extract date for grouping (YYYY-MM-DD)
    this.dateStr = new Date().toISOString().slice(0, 10);

    // Use shortened session ID (first 8 chars of UUID)
    this.shortSessionId = sessionId.slice(0, 8);

    // Initial path without subject - will be updated when subject is set
    this.sessionDir = path.join(outputDir, 'sessions', this.dateStr, this.shortSessionId);
    this.eventsDir = path.join(this.sessionDir, 'events');
    this.summariesDir = path.join(this.sessionDir, 'summaries');
  }

  /**
   * Check for and reuse an existing session directory for this session ID.
   * This prevents session fragmentation when the monitor restarts mid-session.
   * Should be called early, before any writes.
   */
  async findExistingSessionDir(): Promise<boolean> {
    const dateDir = path.join(this.outputDir, 'sessions', this.dateStr);

    try {
      const entries = await fs.readdir(dateDir);

      // Look for directories that start with our short session ID
      const matchingDirs = entries.filter((e) => e.startsWith(this.shortSessionId + '-'));

      if (matchingDirs.length > 0) {
        // Select the directory with the most events (most active session)
        const existingDir = await this.selectBestDirectory(dateDir, matchingDirs);
        this.sessionDir = path.join(dateDir, existingDir);
        this.eventsDir = path.join(this.sessionDir, 'events');
        this.summariesDir = path.join(this.sessionDir, 'summaries');

        // Extract the subject from the directory name
        const subjectSlug = existingDir.slice(this.shortSessionId.length + 1);
        if (subjectSlug) {
          this.sessionSubject = subjectSlug;
          this.subjectLocked = true;  // Don't allow subject changes
        }

        // Find highest event number to continue numbering correctly
        try {
          const eventFiles = await fs.readdir(this.eventsDir);
          this.eventCounter = this.findHighestEventNumber(eventFiles);
        } catch {
          // Events dir might not exist yet
        }

        this.initialized = true;
        return true;
      }
    } catch {
      // Date directory might not exist yet
    }

    return false;
  }

  /**
   * Select the best directory when multiple exist for the same session.
   * Picks the one with the most events (most active documentation).
   */
  private async selectBestDirectory(dateDir: string, dirs: string[]): Promise<string> {
    if (dirs.length === 1) {
      return dirs[0];
    }

    let bestDir = dirs[0];
    let maxEvents = 0;

    for (const dir of dirs) {
      try {
        const eventsPath = path.join(dateDir, dir, 'events');
        const files = await fs.readdir(eventsPath);
        const eventCount = files.filter(f => f.endsWith('.md')).length;
        if (eventCount > maxEvents) {
          maxEvents = eventCount;
          bestDir = dir;
        }
      } catch {
        // Events dir doesn't exist, count as 0
      }
    }

    return bestDir;
  }

  /**
   * Set the session subject/title - updates directory name
   * Should be called early, before writing many files.
   * Once a subject is locked (from finding existing directory), it won't change.
   */
  async setSessionSubject(subject: string): Promise<void> {
    // Don't change subject if it's locked (reusing existing directory)
    if (this.subjectLocked) return;

    if (this.sessionSubject === subject) return;

    const slug = this.slugify(subject);
    if (!slug) return;

    const oldSessionDir = this.sessionDir;
    const newDirName = `${this.shortSessionId}-${slug}`;
    const newSessionDir = path.join(this.outputDir, 'sessions', this.dateStr, newDirName);

    // If already initialized with files, try to rename the directory
    if (this.initialized && oldSessionDir !== newSessionDir) {
      try {
        await fs.rename(oldSessionDir, newSessionDir);
      } catch {
        // Rename failed - keep using old directory to prevent fragmentation
        // This can happen if another process is using the directory
        return;
      }
    }

    this.sessionSubject = subject;
    this.sessionDir = newSessionDir;
    this.eventsDir = path.join(this.sessionDir, 'events');
    this.summariesDir = path.join(this.sessionDir, 'summaries');
  }

  /**
   * Get the current session subject
   */
  getSessionSubject(): string | null {
    return this.sessionSubject;
  }

  /**
   * Check if subject is locked (from reusing existing directory)
   */
  isSubjectLocked(): boolean {
    return this.subjectLocked;
  }

  /**
   * Convert a title to a URL-friendly slug
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
      .replace(/\s+/g, '-')          // Spaces to hyphens
      .replace(/-+/g, '-')           // Collapse multiple hyphens
      .replace(/^-|-$/g, '')         // Trim hyphens
      .slice(0, 50);                 // Limit length
  }

  /**
   * Initialize directory structure
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.eventsDir, { recursive: true });
    await fs.mkdir(this.summariesDir, { recursive: true });

    // Ensure index file exists
    const indexPath = path.join(this.outputDir, 'index.md');
    try {
      await fs.access(indexPath);
    } catch {
      await fs.writeFile(
        indexPath,
        '# Session Documentation Index\n\nAutomatically generated documentation from coding sessions.\n\n## Sessions\n\n'
      );
    }

    this.initialized = true;
  }

  /**
   * Get the next event filename
   */
  private getNextEventFilename(eventType: string): string {
    this.eventCounter++;
    const paddedNum = String(this.eventCounter).padStart(3, '0');
    return `${paddedNum}-${eventType}.md`;
  }

  /**
   * Write an event to the events directory
   */
  async writeEvent(eventType: string, content: string): Promise<string> {
    await this.initialize();

    const filename = this.getNextEventFilename(eventType);
    const filepath = path.join(this.eventsDir, filename);

    await fs.writeFile(filepath, content, 'utf-8');

    return filepath;
  }

  /**
   * Append content to the main session document
   */
  async appendToSession(content: string): Promise<void> {
    await this.initialize();

    const sessionPath = path.join(this.sessionDir, 'session.md');

    try {
      await fs.access(sessionPath);
      await fs.appendFile(sessionPath, '\n' + content);
    } catch {
      // File doesn't exist, create with header
      const title = this.sessionSubject || `Session ${this.shortSessionId}`;
      const header = `# ${title}\n\n**Session ID**: ${this.sessionId}\n**Date**: ${this.dateStr}\n**Started**: ${new Date().toISOString()}\n\n## Events\n\n`;
      await fs.writeFile(sessionPath, header + content, 'utf-8');
    }
  }

  /**
   * Write complete session.md content (used by DB-backed mode)
   * Regenerates the entire file from database state
   */
  async writeSessionMarkdown(content: string): Promise<void> {
    await this.initialize();
    const sessionPath = path.join(this.sessionDir, 'session.md');
    await fs.writeFile(sessionPath, content, 'utf-8');
  }

  /**
   * Update the session.md header with subject if it was set after creation
   */
  async updateSessionHeader(): Promise<void> {
    if (!this.sessionSubject) return;

    const sessionPath = path.join(this.sessionDir, 'session.md');

    try {
      const content = await fs.readFile(sessionPath, 'utf-8');

      // Check if header still has default title
      const defaultTitlePattern = new RegExp(`^# Session ${this.shortSessionId}\\n`);
      if (defaultTitlePattern.test(content)) {
        const updatedContent = content.replace(
          defaultTitlePattern,
          `# ${this.sessionSubject}\n`
        );
        await fs.writeFile(sessionPath, updatedContent, 'utf-8');
      }
    } catch {
      // File doesn't exist yet, that's ok
    }
  }

  /**
   * Write a summary file
   */
  async writeSummary(
    summaryType: 'hourly' | 'session',
    content: string
  ): Promise<string> {
    await this.initialize();

    let filename: string;
    if (summaryType === 'hourly') {
      const hourlyFiles = await this.listFiles(this.summariesDir, 'hourly-');
      const nextNum = hourlyFiles.length + 1;
      filename = `hourly-${nextNum}.md`;
    } else {
      filename = 'session-final.md';
    }

    const filepath = path.join(this.summariesDir, filename);
    await fs.writeFile(filepath, content, 'utf-8');

    return filepath;
  }

  /**
   * Update the running session summary (called after each interaction)
   * This overwrites the current summary with an updated version
   */
  async updateRunningSummary(content: string): Promise<string> {
    await this.initialize();

    const filepath = path.join(this.summariesDir, 'running-summary.md');
    const header = `# Session Summary (Live)\n\n**Last Updated**: ${new Date().toISOString()}\n\n---\n\n`;
    await fs.writeFile(filepath, header + content, 'utf-8');

    return filepath;
  }

  /**
   * Read the current running summary
   */
  async getRunningSummary(): Promise<string | null> {
    try {
      const filepath = path.join(this.summariesDir, 'running-summary.md');
      return await fs.readFile(filepath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Mark an event file as invalidated
   * Prepends a warning banner and renames the file
   */
  async markEventInvalidated(eventTitle: string, reason: string): Promise<boolean> {
    await this.initialize();

    try {
      // Find the event file by searching for matching title
      const files = await this.listFiles(this.eventsDir);

      for (const file of files) {
        if (file.endsWith('.md') && !file.startsWith('INVALIDATED-')) {
          const filepath = path.join(this.eventsDir, file);
          const content = await fs.readFile(filepath, 'utf-8');

          // Check if this file contains the event we're looking for
          if (content.includes(eventTitle)) {
            // Prepend invalidation banner
            const banner = `# ⚠️ INVALIDATED

> **This documentation has been marked as INCORRECT**
>
> **Reason:** ${reason}
>
> **Invalidated at:** ${new Date().toISOString()}
>
> The information below was found to be wrong. See the correction event for accurate information.

---

`;
            const newContent = banner + content;

            // Rename file to indicate invalidation
            const newFilename = `INVALIDATED-${file}`;
            const newFilepath = path.join(this.eventsDir, newFilename);

            // Write updated content to new file
            await fs.writeFile(newFilepath, newContent, 'utf-8');

            // Remove old file
            await fs.unlink(filepath);

            // Also update the session.md to mark this event
            await this.markInSessionDocument(eventTitle, reason);

            return true;
          }
        }
      }

      return false;
    } catch (error) {
      // File operations might fail, but we don't want to crash
      return false;
    }
  }

  /**
   * Mark an event as invalidated in the main session document
   */
  private async markInSessionDocument(eventTitle: string, reason: string): Promise<void> {
    const sessionPath = path.join(this.sessionDir, 'session.md');

    try {
      const content = await fs.readFile(sessionPath, 'utf-8');

      // Find and mark the event entry
      // Look for the event title and add a strikethrough + note
      const updatedContent = content.replace(
        new RegExp(`(### [^:]+: ${this.escapeRegex(eventTitle)})`, 'g'),
        `$1 ~~[INVALIDATED]~~\n\n> ⚠️ **Invalidated:** ${reason}\n`
      );

      if (updatedContent !== content) {
        await fs.writeFile(sessionPath, updatedContent, 'utf-8');
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Escape special regex characters in a string
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Update the global index with this session
   */
  async updateIndex(metadata: SessionMetadata): Promise<void> {
    const indexPath = path.join(this.outputDir, 'index.md');

    // Build the display title
    const displayTitle = this.sessionSubject || this.shortSessionId;

    // Get relative path from sessions dir
    const sessionDirName = path.basename(this.sessionDir);
    const relativePath = `./sessions/${this.dateStr}/${sessionDirName}/session.md`;

    const sessionLink = `- [${displayTitle}](${relativePath}) - ${this.shortSessionId} (${metadata.eventCount} events)\n`;

    let content: string;
    try {
      content = await fs.readFile(indexPath, 'utf-8');
    } catch {
      // Index doesn't exist, create it
      content = '# Session Documentation Index\n\nAutomatically generated documentation from coding sessions.\n\n';
    }

    // Check if we have a section for this date
    const dateSectionHeader = `## ${this.dateStr}\n`;
    if (!content.includes(dateSectionHeader)) {
      // Add new date section (insert before other sections or at end)
      const insertPosition = content.lastIndexOf('\n## ');
      if (insertPosition > 0) {
        // Insert before existing date sections (to keep newest first)
        content = content.slice(0, insertPosition) + '\n' + dateSectionHeader + '\n' + content.slice(insertPosition);
      } else {
        // No existing sections, append
        content += '\n' + dateSectionHeader + '\n';
      }
    }

    // Check if session already in index (by session ID)
    const sessionIdPattern = new RegExp(`- \\[[^\\]]+\\]\\([^)]*${this.shortSessionId}[^)]*\\).*\\n`);
    if (sessionIdPattern.test(content)) {
      // Update existing entry
      content = content.replace(sessionIdPattern, sessionLink);
    } else {
      // Add entry under the date section
      const sectionIndex = content.indexOf(dateSectionHeader);
      const insertAt = sectionIndex + dateSectionHeader.length + 1;
      content = content.slice(0, insertAt) + sessionLink + content.slice(insertAt);
    }

    await fs.writeFile(indexPath, content, 'utf-8');
  }

  /**
   * Read an existing file
   */
  async readFile(relativePath: string): Promise<string | null> {
    try {
      const filepath = path.join(this.sessionDir, relativePath);
      return await fs.readFile(filepath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * List files in a directory matching a prefix
   */
  private async listFiles(dir: string, prefix?: string): Promise<string[]> {
    try {
      const files = await fs.readdir(dir);
      if (prefix) {
        return files.filter((f) => f.startsWith(prefix));
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * Find the highest event number from a list of event filenames.
   * Handles files like "001-user_request.md", "INVALIDATED-002-foo.md", etc.
   */
  private findHighestEventNumber(files: string[]): number {
    let highest = 0;
    const eventNumberPattern = /^(?:INVALIDATED-)?(\d{3})-/;

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const match = file.match(eventNumberPattern);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > highest) {
          highest = num;
        }
      }
    }

    return highest;
  }

  /**
   * Get session directory path
   */
  getSessionDir(): string {
    return this.sessionDir;
  }

  /**
   * Get current event count
   */
  getEventCount(): number {
    return this.eventCounter;
  }

  /**
   * Save deduplication state to the session directory.
   * This allows resuming a session without re-documenting the same events.
   */
  async saveDedupState(items: Array<{ hash: string; title: string; eventType: string; timestamp: Date }>): Promise<void> {
    await this.initialize();
    const filepath = path.join(this.sessionDir, '.dedup-state.json');
    await fs.writeFile(filepath, JSON.stringify(items, null, 2), 'utf-8');
  }

  /**
   * Load deduplication state from the session directory.
   * Returns null if no state file exists.
   */
  async loadDedupState(): Promise<Array<{ hash: string; title: string; eventType: string; timestamp: string }> | null> {
    try {
      const filepath = path.join(this.sessionDir, '.dedup-state.json');
      const content = await fs.readFile(filepath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Save transcript position for resuming later.
   */
  async saveTranscriptPosition(transcriptPath: string, position: number): Promise<void> {
    await this.initialize();
    const filepath = path.join(this.sessionDir, '.transcript-position.json');
    await fs.writeFile(filepath, JSON.stringify({ transcriptPath, position }), 'utf-8');
  }

  /**
   * Load transcript position for resuming.
   */
  async loadTranscriptPosition(): Promise<{ transcriptPath: string; position: number } | null> {
    try {
      const filepath = path.join(this.sessionDir, '.transcript-position.json');
      const content = await fs.readFile(filepath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Save analyzed message state to the session directory.
   * This tracks which messages have been sent to Claude for analysis,
   * preventing re-analysis of the same content.
   */
  async saveAnalyzedState(
    items: Array<{ messageId: string; analyzedAt: string; briefSummary: string }>
  ): Promise<void> {
    await this.initialize();
    const filepath = path.join(this.sessionDir, '.analyzed-messages.json');
    await fs.writeFile(filepath, JSON.stringify(items, null, 2), 'utf-8');
  }

  /**
   * Load analyzed message state from the session directory.
   * Returns null if no state file exists.
   */
  async loadAnalyzedState(): Promise<Array<{
    messageId: string;
    analyzedAt: string;
    briefSummary: string;
  }> | null> {
    try {
      const filepath = path.join(this.sessionDir, '.analyzed-messages.json');
      const content = await fs.readFile(filepath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}
