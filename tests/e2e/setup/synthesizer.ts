import type {
  Client, Guild, GuildMember, TextBasedChannel, User,
  InteractionReplyOptions, InteractionEditReplyOptions,
  ModalBuilder, Message, MessageEditOptions,
} from 'discord.js';
import { MessageFlags } from 'discord.js';

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

export interface FakeReply {
  options: InteractionReplyOptions | InteractionEditReplyOptions | string;
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
      fake.__editedReply = { options: opts, ephemeral: false };
      return { id: 'fake-edited-reply' };
    },
    async followUp(opts) {
      const ephemeral = isEphemeral(opts);
      fake.__followUps.push({ options: opts, ephemeral });
      // If non-ephemeral, pipe to channel.send so real Discord reflects it.
      if (!ephemeral && init.channel.isSendable()) {
        const payload = typeof opts === 'string' ? { content: opts } : opts;
        await init.channel.send(payload);
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

export interface FakeButtonInit {
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  message: Message;
  customId: string;
}

export interface FakeButton {
  type: 'button';
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  message: Message;
  customId: string;
  createdTimestamp: number;
  deferred: boolean;
  replied: boolean;

  __replies: FakeReply[];
  __deferred: { ephemeral: boolean } | null;
  __deferredUpdate: boolean;
  __updated: MessageEditOptions | null;
  __followUps: FakeReply[];

  reply(opts: InteractionReplyOptions | string): Promise<unknown>;
  deferReply(opts?: { flags?: number }): Promise<unknown>;
  deferUpdate(): Promise<unknown>;
  update(opts: MessageEditOptions | string): Promise<unknown>;
  followUp(opts: InteractionReplyOptions | string): Promise<unknown>;
}

export function fakeButton(init: FakeButtonInit): FakeButton {
  const fake: FakeButton = {
    type: 'button',
    client: init.client,
    guild: init.guild,
    channel: init.channel,
    member: init.member,
    user: init.user,
    message: init.message,
    customId: init.customId,
    createdTimestamp: Date.now(),
    deferred: false,
    replied: false,
    __replies: [],
    __deferred: null,
    __deferredUpdate: false,
    __updated: null,
    __followUps: [],

    async reply(opts) {
      fake.__replies.push({ options: opts, ephemeral: isEphemeral(opts) });
      fake.replied = true;
      return { resource: { message: { createdTimestamp: Date.now() } } };
    },
    async deferReply(opts) {
      fake.__deferred = {
        ephemeral: (opts?.flags ?? 0) === MessageFlags.Ephemeral,
      };
      fake.deferred = true;
      return undefined;
    },
    async deferUpdate() {
      fake.__deferredUpdate = true;
      return undefined;
    },
    async update(opts) {
      const payload = typeof opts === 'string' ? { content: opts } : opts;
      fake.__updated = payload;
      // Pipe to real message.edit so the sandbox guild reflects the change.
      await init.message.edit(payload);
      return undefined;
    },
    async followUp(opts) {
      const ephemeral = isEphemeral(opts);
      fake.__followUps.push({ options: opts, ephemeral });
      if (!ephemeral && init.channel.isSendable()) {
        const payload = typeof opts === 'string' ? { content: opts } : opts;
        await init.channel.send(payload);
      }
      return { id: 'fake-follow-up' };
    },
  };
  return fake;
}

export interface FakeModalSubmitInit {
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  customId: string;
  fields: Record<string, string>;
}

export interface FakeModalSubmit {
  type: 'modalSubmit';
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  customId: string;
  fields: { getTextInputValue(customId: string): string };
  createdTimestamp: number;
  deferred: boolean;
  replied: boolean;

  __replies: FakeReply[];
  __editedReply: FakeReply | null;
  __followUps: FakeReply[];

  reply(opts: InteractionReplyOptions | string): Promise<unknown>;
  deferReply(opts?: { flags?: number }): Promise<unknown>;
  editReply(opts: InteractionEditReplyOptions | string): Promise<unknown>;
  followUp(opts: InteractionReplyOptions | string): Promise<unknown>;
}

export function fakeModalSubmit(init: FakeModalSubmitInit): FakeModalSubmit {
  const fake: FakeModalSubmit = {
    type: 'modalSubmit',
    client: init.client,
    guild: init.guild,
    channel: init.channel,
    member: init.member,
    user: init.user,
    customId: init.customId,
    fields: {
      getTextInputValue(id: string) {
        const v = init.fields[id];
        if (v === undefined) {
          throw new Error(`modal field "${id}" not provided in fakeModalSubmit`);
        }
        return v;
      },
    },
    createdTimestamp: Date.now(),
    deferred: false,
    replied: false,
    __replies: [],
    __editedReply: null,
    __followUps: [],

    async reply(opts) {
      fake.__replies.push({ options: opts, ephemeral: isEphemeral(opts) });
      fake.replied = true;
      return { resource: { message: { createdTimestamp: Date.now() } } };
    },
    async deferReply(opts) {
      fake.deferred = true;
      return undefined;
    },
    async editReply(opts) {
      fake.__editedReply = { options: opts, ephemeral: false };
      return { id: 'fake-edited-reply' };
    },
    async followUp(opts) {
      const ephemeral = isEphemeral(opts);
      fake.__followUps.push({ options: opts, ephemeral });
      if (!ephemeral && init.channel.isSendable()) {
        const payload = typeof opts === 'string' ? { content: opts } : opts;
        await init.channel.send(payload);
      }
      return { id: 'fake-follow-up' };
    },
  };
  return fake;
}

