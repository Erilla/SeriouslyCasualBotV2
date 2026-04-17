import type Database from 'better-sqlite3';
import { createTables } from '../schema.js';

export const version = 1;

export function up(db: Database.Database): void {
  createTables(db);
}
