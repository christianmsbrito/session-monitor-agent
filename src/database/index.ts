import { DatabaseManager } from './db-manager.js';
import * as path from 'path';
import * as fs from 'fs';

let instance: DatabaseManager | null = null;

export function initializeDatabase(dbPath: string): DatabaseManager {
  if (instance) {
    return instance;
  }

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  instance = new DatabaseManager(dbPath);
  return instance;
}

export function getDatabase(): DatabaseManager {
  if (!instance) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// Re-export types and class
export { DatabaseManager } from './db-manager.js';
export type {
  SessionRow,
  EventRow,
  DedupHashRow,
  AnalyzedMessageRow,
  InsertEventInput,
  CreateSessionInput,
} from './db-manager.js';
