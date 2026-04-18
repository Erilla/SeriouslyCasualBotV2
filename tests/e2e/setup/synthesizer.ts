export interface OptionsShimInit {
  subcommand?: string;
  values: Record<string, string | number | boolean | unknown>;
}

export interface OptionsShim {
  getSubcommand(required?: boolean): string;
  getString(name: string, required?: boolean): string | null;
  getInteger(name: string, required?: boolean): number | null;
  getBoolean(name: string, required?: boolean): boolean | null;
  getUser(name: string, required?: boolean): unknown;
  getMember(name: string): unknown;
  getChannel(name: string, required?: boolean): unknown;
  getRole(name: string, required?: boolean): unknown;
  getAttachment(name: string, required?: boolean): unknown;
}

export function buildOptionsShim(init: OptionsShimInit): OptionsShim {
  const get = <T>(name: string, required: boolean | undefined, typeLabel: string): T | null => {
    const v = init.values[name];
    if (v === undefined || v === null) {
      if (required) throw new Error(`required option "${name}" (${typeLabel}) not provided`);
      return null;
    }
    return v as T;
  };

  return {
    getSubcommand(required = true) {
      if (!init.subcommand) {
        if (required) throw new Error('no subcommand set on options shim');
        return '';
      }
      return init.subcommand;
    },
    getString: (n, r) => get<string>(n, r, 'string'),
    getInteger: (n, r) => get<number>(n, r, 'integer'),
    getBoolean: (n, r) => get<boolean>(n, r, 'boolean'),
    getUser: (n, r) => get(n, r, 'user'),
    getMember: (n) => get(n, false, 'member'),
    getChannel: (n, r) => get(n, r, 'channel'),
    getRole: (n, r) => get(n, r, 'role'),
    getAttachment: (n, r) => get(n, r, 'attachment'),
  };
}

import type {
  Client, Guild, GuildMember, TextBasedChannel, User,
  InteractionReplyOptions, InteractionEditReplyOptions,
  ModalBuilder,
} from 'discord.js';
import { MessageFlags } from 'discord.js';

export interface FakeReply {
  options: InteractionReplyOptions | string;
  ephemeral: boolean;
}

export interface FakeChatInputInit {
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  commandName: string;
  subcommand?: string;
  options?: Record<string, unknown>;
}

export interface FakeChatInput {
  type: 'chatInput';
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  commandName: string;
  options: OptionsShim;
  createdTimestamp: number;
  deferred: boolean;
  replied: boolean;

  // recordings
  __replies: FakeReply[];
  __deferred: { ephemeral: boolean } | null;
  __editedReply: FakeReply | null;
  __followUps: FakeReply[];
  __modalShown: ModalBuilder | null;

  // discord.js-shaped methods
  reply(opts: InteractionReplyOptions | string): Promise<unknown>;
  deferReply(opts?: { flags?: number }): Promise<unknown>;
  editReply(opts: InteractionEditReplyOptions | string): Promise<unknown>;
  followUp(opts: InteractionReplyOptions | string): Promise<unknown>;
  showModal(modal: ModalBuilder): Promise<void>;
  fetchReply(): Promise<unknown>;
}

function isEphemeral(opts: InteractionReplyOptions | string): boolean {
  if (typeof opts === 'string') return false;
  const flags = opts.flags;
  if (typeof flags === 'number') return (flags & MessageFlags.Ephemeral) !== 0;
  return false;
}

export function fakeChatInput(init: FakeChatInputInit): FakeChatInput {
  const fake: FakeChatInput = {
    type: 'chatInput',
    client: init.client,
    guild: init.guild,
    channel: init.channel,
    member: init.member,
    user: init.user,
    commandName: init.commandName,
    options: buildOptionsShim({
      subcommand: init.subcommand,
      values: init.options ?? {},
    }),
    createdTimestamp: Date.now(),
    deferred: false,
    replied: false,
    __replies: [],
    __deferred: null,
    __editedReply: null,
    __followUps: [],
    __modalShown: null,

    async reply(opts) {
      fake.__replies.push({ options: opts, ephemeral: isEphemeral(opts) });
      fake.replied = true;
      // withResponse-shaped return: callers use response.resource?.message?.createdTimestamp
      return { resource: { message: { createdTimestamp: Date.now() } } };
    },
    async deferReply(opts) {
      fake.__deferred = {
        ephemeral: (opts?.flags ?? 0) === MessageFlags.Ephemeral,
      };
      fake.deferred = true;
      return undefined;
    },
    async editReply(opts) {
      fake.__editedReply = { options: opts as InteractionReplyOptions, ephemeral: false };
      return { id: 'fake-edited-reply' };
    },
    async followUp(opts) {
      const ephemeral = isEphemeral(opts);
      fake.__followUps.push({ options: opts, ephemeral });
      // If non-ephemeral, pipe to channel.send so real Discord reflects it.
      if (!ephemeral && 'send' in init.channel) {
        const payload = typeof opts === 'string' ? { content: opts } : opts;
        await (init.channel as any).send(payload);
      }
      return { id: 'fake-follow-up' };
    },
    async showModal(modal) {
      fake.__modalShown = modal;
    },
    async fetchReply() {
      return { id: 'fake-reply' };
    },
  };
  return fake;
}

