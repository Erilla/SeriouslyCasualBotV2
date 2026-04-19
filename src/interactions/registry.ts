import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  UserSelectMenuInteraction,
} from 'discord.js';
import { logger } from '../services/logger.js';
import { requireOfficer, wrapErrors, type InteractionKind } from './middleware.js';

export type ButtonHandler = {
  prefix: string;
  officerOnly?: boolean;
  handle(interaction: ButtonInteraction, params: string[]): Promise<void>;
};

export type ModalHandler = {
  prefix: string;
  officerOnly?: boolean;
  handle(interaction: ModalSubmitInteraction, params: string[]): Promise<void>;
};

export type UserSelectHandler = {
  prefix: string;
  officerOnly?: boolean;
  handle(interaction: UserSelectMenuInteraction, params: string[]): Promise<void>;
};

type AnyHandler = ButtonHandler | ModalHandler | UserSelectHandler;
type AnyInteraction = ButtonInteraction | ModalSubmitInteraction | UserSelectMenuInteraction;

export async function dispatch<H extends AnyHandler, I extends AnyInteraction>(
  handlers: H[],
  kind: InteractionKind,
  interaction: I,
  customId: string,
): Promise<void> {
  const handler = handlers.find(
    h => customId === h.prefix || customId.startsWith(h.prefix + ':'),
  );

  if (!handler) {
    logger.warn('interaction', `Unhandled ${kind}: ${customId}`);
    return;
  }

  if (handler.officerOnly && !(await requireOfficer(interaction, kind))) return;

  const tail = customId === handler.prefix ? '' : customId.slice(handler.prefix.length + 1);
  const params = tail ? tail.split(':') : [];

  await wrapErrors(kind, customId, interaction, () =>
    (handler.handle as (i: I, p: string[]) => Promise<void>)(interaction, params),
  );
}

export const buttonHandlers: ButtonHandler[] = [];
export const modalHandlers: ModalHandler[] = [];
export const userSelectHandlers: UserSelectHandler[] = [];
