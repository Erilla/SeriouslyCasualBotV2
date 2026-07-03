/**
 * Label for a loot voter: the linked raider's character name, or a Discord
 * mention (<@id>) when the user isn't a linked raider. Mentions inside embed
 * fields render as the user but do not notify, so this is safe on every update.
 */
export function resolveVoterLabel(userToCharacter: Map<string, string>, userId: string): string {
  return userToCharacter.get(userId) ?? `<@${userId}>`;
}
