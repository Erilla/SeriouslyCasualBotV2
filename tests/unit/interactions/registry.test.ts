import { describe, it, expect } from 'vitest';
import {
  buttonHandlers,
  modalHandlers,
  userSelectHandlers,
} from '../../../src/interactions/registry.js';

function assertNoCollisions(
  handlers: Array<{ prefix: string }>,
  kind: string,
): void {
  for (let i = 0; i < handlers.length; i++) {
    for (let j = i + 1; j < handlers.length; j++) {
      const a = handlers[i].prefix;
      const b = handlers[j].prefix;
      const collides =
        a === b ||
        a.startsWith(b + ':') ||
        b.startsWith(a + ':');
      expect(
        collides,
        `${kind} prefix collision: "${a}" and "${b}"`,
      ).toBe(false);
    }
  }
}

describe('registry prefix collisions', () => {
  it('no two button handlers share a prefix-with-boundary overlap', () => {
    assertNoCollisions(buttonHandlers, 'button');
  });

  it('no two modal handlers share a prefix-with-boundary overlap', () => {
    assertNoCollisions(modalHandlers, 'modal');
  });

  it('no two user-select handlers share a prefix-with-boundary overlap', () => {
    assertNoCollisions(userSelectHandlers, 'userSelect');
  });
});
