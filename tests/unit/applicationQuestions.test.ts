import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';

// Mock the logger
import { vi } from 'vitest';
vi.mock('../../src/services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  getQuestions,
  getQuestionById,
  addQuestion,
  removeQuestion,
} from '../../src/functions/applications/applicationQuestions.js';

describe('applicationQuestions', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('should return empty array on fresh DB', () => {
    const questions = getQuestions();
    expect(questions).toEqual([]);
  });

  it('should add a question and auto-increment sort_order', () => {
    const q1 = addQuestion('What is your character name?');
    expect(q1.id).toBeGreaterThan(0);
    expect(q1.sort_order).toBe(1);
    expect(q1.question).toBe('What is your character name?');

    const q2 = addQuestion('What class and spec?');
    expect(q2.sort_order).toBe(2);

    const q3 = addQuestion('Why do you want to join?');
    expect(q3.sort_order).toBe(3);

    const all = getQuestions();
    expect(all).toHaveLength(3);
    expect(all[0].sort_order).toBe(1);
    expect(all[1].sort_order).toBe(2);
    expect(all[2].sort_order).toBe(3);
  });

  it('should get a question by ID', () => {
    const added = addQuestion('Test question?');
    const found = getQuestionById(added.id);

    expect(found).toBeDefined();
    expect(found!.question).toBe('Test question?');
    expect(found!.id).toBe(added.id);
  });

  it('should return undefined for non-existent question ID', () => {
    const found = getQuestionById(9999);
    expect(found).toBeUndefined();
  });

  it('should remove a question by ID', () => {
    const q = addQuestion('To be deleted');
    expect(getQuestions()).toHaveLength(1);

    const result = removeQuestion(q.id);
    expect(result).toBe(true);
    expect(getQuestions()).toHaveLength(0);
  });

  it('should return false when removing non-existent question', () => {
    const result = removeQuestion(9999);
    expect(result).toBe(false);
  });

  it('should maintain sort_order gap after deletion', () => {
    addQuestion('Q1');
    const q2 = addQuestion('Q2');
    addQuestion('Q3');

    removeQuestion(q2.id);

    const remaining = getQuestions();
    expect(remaining).toHaveLength(2);
    expect(remaining[0].sort_order).toBe(1);
    expect(remaining[1].sort_order).toBe(3);

    // Next added question should get sort_order 4
    const q4 = addQuestion('Q4');
    expect(q4.sort_order).toBe(4);
  });
});
