import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  UserSelectMenuInteraction,
} from 'discord.js';
import { requireOfficer, wrapErrors, type InteractionKind } from './middleware.js';
import * as pagination from './pagination.js';
import * as loot from './loot.js';
import * as raider from './raider.js';

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

type AnyInteraction = ButtonInteraction | ModalSubmitInteraction | UserSelectMenuInteraction;

type HandlerFor<I> =
  I extends ButtonInteraction ? ButtonHandler :
  I extends ModalSubmitInteraction ? ModalHandler :
  I extends UserSelectMenuInteraction ? UserSelectHandler : never;

export async function dispatch<I extends AnyInteraction>(
  handlers: HandlerFor<I>[],
  kind: InteractionKind,
  interaction: I,
  customId: string,
): Promise<boolean> {
  const handler = handlers.find(
    h => customId === h.prefix || customId.startsWith(h.prefix + ':'),
  );

  if (!handler) return false;

  if (handler.officerOnly && !(await requireOfficer(interaction))) return true;

  const tail = customId === handler.prefix ? '' : customId.slice(handler.prefix.length + 1);
  const params = tail ? tail.split(':') : [];

  // HandlerFor<I> binds the handler to the interaction at the call site, but inside the
  // function body TypeScript can't unify the conditional — one minimal cast is required.
  await wrapErrors(kind, customId, interaction, () =>
    (handler.handle as (i: I, p: string[]) => Promise<void>)(interaction, params),
  );
  return true;
}

export const buttonHandlers: ButtonHandler[] = [
  ...pagination.buttons,
  ...loot.buttons,
  ...raider.buttons,
];
export const modalHandlers: ModalHandler[] = [];
export const userSelectHandlers: UserSelectHandler[] = [
  ...raider.userSelects,
];
