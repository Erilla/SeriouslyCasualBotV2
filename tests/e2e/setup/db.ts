import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'fs';
import { loadE2EEnv } from './env.js';

export function testDbPath(): string {
  return loadE2EEnv().testDbPath;
}

export function wipeTestDb(): void {
  const path = testDbPath();
  if (existsSync(path)) unlinkSync(path);
}

export function openTestDbReadonly(): Database.Database {
  return new Database(testDbPath(), { readonly: true, fileMustExist: true });
}
