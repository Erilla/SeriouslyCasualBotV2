import { describe, expect, it } from 'vitest';
import { ButtonStyle } from 'discord.js';
import { buildDecisionMessage } from '../../src/functions/applications/decisionMessage.js';

describe('the officer decision message', () => {
  it('carries an embed, so it is not a bare button row butted against the vote row', () => {
    // The whole point of the change: Accept/Reject used to be a components-only
    // message posted straight after the voting embed, which put a green button
    // directly under the green "For" button with nothing in between.
    const { embeds } = buildDecisionMessage(7);

    expect(embeds).toHaveLength(1);
    const embed = embeds[0].toJSON();
    expect(embed.title).toBe('Decision');
    expect(embed.description).toBeTruthy();
  });

  it('keeps the Accept and Reject buttons and their ids', () => {
    const { components } = buildDecisionMessage(7);

    expect(components).toHaveLength(1);
    const row = components[0].toJSON();
    expect(row.components.map((c) => ('custom_id' in c ? c.custom_id : undefined))).toEqual([
      'application:accept:7',
      'application:reject:7',
    ]);
    expect(row.components.map((c) => ('label' in c ? c.label : undefined))).toEqual([
      'Accept',
      'Reject',
    ]);
    expect(row.components.map((c) => ('style' in c ? c.style : undefined))).toEqual([
      ButtonStyle.Success,
      ButtonStyle.Danger,
    ]);
  });
});
