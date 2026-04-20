import { getReadonlyTestDb } from './db.js';
import type { TextBasedChannel, GuildMember, Role, Message } from 'discord.js';

export function queryOne<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
  return getReadonlyTestDb().prepare(sql).get(...params) as T | undefined;
}

export function queryAll<T = unknown>(sql: string, params: unknown[] = []): T[] {
  return getReadonlyTestDb().prepare(sql).all(...params) as T[];
}

export async function findRecentMessage(
  channel: TextBasedChannel,
  predicate: (m: Message) => boolean,
  limit = 20,
): Promise<Message | null> {
  const msgs = await channel.messages.fetch({ limit });
  for (const m of msgs.values()) {
    if (predicate(m)) return m;
  }
  return null;
}

export async function assertMemberHasRole(member: GuildMember, role: Role): Promise<void> {
  const fresh = await member.guild.members.fetch(member.id);
  if (!fresh.roles.cache.has(role.id)) {
    throw new Error(`member ${fresh.user.tag} missing role ${role.name}`);
  }
}

export async function assertMemberLacksRole(member: GuildMember, role: Role): Promise<void> {
  const fresh = await member.guild.members.fetch(member.id);
  if (fresh.roles.cache.has(role.id)) {
    throw new Error(`member ${fresh.user.tag} unexpectedly has role ${role.name}`);
  }
}
