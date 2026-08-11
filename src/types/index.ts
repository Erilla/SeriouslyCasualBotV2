import {
  ChatInputCommandInteraction,
  Client,
  Collection,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

// ─── Bot Types ───────────────────────────────────────────────

export interface BotClient extends Client {
  commands: Collection<string, Command>;
}

export interface Command {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  devOnly?: boolean;
}

export interface BotEvent {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => Promise<void> | void;
}

// ─── Database Row Types ──────────────────────────────────────

export interface ConfigRow {
  key: string;
  value: string;
}

export interface SettingRow {
  key: string;
  value: number;
}

export interface RaiderRow {
  id: number;
  character_name: string;
  realm: string;
  region: string;
  rank: number | null;
  class: string | null;
  discord_user_id: string | null;
  message_id: string | null;
  missing_since: string | null;
  inactive_since: string | null;
}

export interface RaiderIdentityMapRow {
  character_name: string;
  discord_user_id: string;
}

export interface OverlordRow {
  id: number;
  name: string;
  user_id: string;
}

export interface IgnoredCharacterRow {
  character_name: string;
}

export interface ApplicationRow {
  id: number;
  character_name: string | null;
  applicant_user_id: string;
  status: 'in_progress' | 'active' | 'accepted' | 'rejected' | 'abandoned';
  current_question_id: number | null;
  channel_id: string | null;
  forum_post_id: string | null;
  thread_id: string | null;
  started_at: string;
  submitted_at: string | null;
  resolved_at: string | null;
  /** When overlords were told the applicant left the Discord; NULL if they have not been. */
  departed_notified_at: string | null;
}

export interface ApplicationQuestionRow {
  id: number;
  question: string;
  sort_order: number;
}

export interface ApplicationAnswerRow {
  id: number;
  application_id: number;
  question_id: number;
  answer: string;
}

export interface ApplicationVoteRow {
  id: number;
  application_id: number;
  user_id: string;
  vote_type: 'for' | 'neutral' | 'against';
}

export interface TrialRow {
  id: number;
  character_name: string;
  role: string;
  start_date: string;
  thread_id: string | null;
  logs_message_id: string | null;
  application_id: number | null;
  status: 'active' | 'promoted' | 'closed';
  /** Whose Discord account this trial is; NULL when nobody has linked it. */
  discord_user_id: string | null;
  /** When overlords were told this trial left the Discord; NULL if they have not been. */
  departed_notified_at: string | null;
}

export interface TrialAlertRow {
  id: number;
  trial_id: number;
  alert_name: string;
  alert_date: string;
  alerted: number;
}

export interface PromoteAlertRow {
  id: number;
  trial_id: number;
  thread_id: string;
  promote_date: string;
}

export interface LootPostRow {
  id: number;
  boss_id: number;
  boss_name: string;
  boss_url: string | null;
  channel_id: string;
  message_id: string;
}

export interface LootResponseRow {
  id: number;
  loot_post_id: number;
  user_id: string;
  response_type: 'major' | 'minor' | 'wantIn' | 'wantOut';
}

export interface GuildInfoContentRow {
  key: string;
  title: string | null;
  content: string;
}

export interface ScheduleDayRow {
  id: number;
  day: string;
  time: string;
  sort_order: number;
}

export interface ScheduleConfigRow {
  key: string;
  value: string;
}

export interface GuildInfoMessageRow {
  key: string;
  message_id: string;
}

export interface GuildInfoLinkRow {
  id: number;
  label: string;
  url: string;
  emoji_id: string | null;
}

export interface AchievementsManualRow {
  id: number;
  raid: string;
  progress: string;
  result: string;
  expansion: number;
  sort_order: number;
  icon: string | null;
}

export interface CeOverrideRow {
  raid_slug: string;
  cutoff_at: string;
}

export interface DefaultMessageRow {
  key: string;
  message: string;
}

export interface SchemaVersionRow {
  version: number;
  applied_at: string;
}

export interface BuildInfoRow {
  sha: string;
  build: number;
}

export interface IntelJobRow {
  id: number;
  application_id: number | null;
  target_channel_id: string | null;
  character_name: string;
  character_realm: string;
  character_region: string;
  phase: string;
  status: string;
  resume_after: string | null;
  paused_service: string | null;
  attempts: number;
  logs_message_id: string | null;
  alts_message_id: string | null;
  guilds_message_id: string | null;
  applicant_discord: string | null;
  created_at: string;
  updated_at: string;
}

export type FingerprintEntries = [number, number][];

export interface ApplicantIntelAnchorFingerprint {
  name: string;
  realm: string;
  region: string;
  entries: FingerprintEntries;
  fetchedAt: string;
}

export interface ApplicantIntelTopUpState {
  requested: boolean;
  reopenedAt: string | null;
}

export type ApplicantIntelTopUpResult = 'queued' | 'reopened';

/**
 * A character harvested from a conversation link.
 *
 * `raiderIoVerified` records whether Raider.IO could resolve the identity. It
 * gates only whether a Raider.IO profile link is RENDERED — an unverified
 * identity (a WarcraftLogs or Armory link for a character Raider.IO has never
 * indexed) is still swept, because the fingerprint and guild work run against
 * Blizzard. Optional so rows written before verification existed stay readable.
 */
export interface LinkedCharacter {
  region: string;
  realm: string;
  name: string;
  raiderIoVerified?: boolean;
}

// ─── Scheduler Types ─────────────────────────────────────────

export interface ScheduledTask {
  name: string;
  type: 'interval' | 'cron';
  schedule: string | number;
  handler: () => Promise<void>;
  overlap?: boolean;
}

// ─── Logger Types ────────────────────────────────────────────

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
