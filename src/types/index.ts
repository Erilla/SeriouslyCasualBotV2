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
  status: 'in_progress' | 'submitted' | 'active' | 'accepted' | 'rejected' | 'abandoned';
  current_question_id: number | null;
  channel_id: string | null;
  forum_post_id: string | null;
  thread_id: string | null;
  started_at: string;
  submitted_at: string | null;
  resolved_at: string | null;
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
  vote_type: 'for' | 'neutral' | 'against' | 'kekw';
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

export interface EpgpEffortPointsRow {
  id: number;
  raider_id: number;
  points: number;
  timestamp: string;
}

export interface EpgpGearPointsRow {
  id: number;
  raider_id: number;
  points: number;
  timestamp: string;
}

export interface EpgpUploadHistoryRow {
  id: number;
  timestamp: string;
  decay_percent: number;
  uploaded_content: string | null;
}

export interface EpgpLootHistoryRow {
  id: number;
  raider_id: number;
  item_id: string | null;
  item_string: string;
  gear_points: number;
  looted_at: string;
}

export interface EpgpConfigRow {
  key: string;
  value: string;
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
}

export interface SignupMessageRow {
  id: number;
  message: string;
}

export interface DefaultMessageRow {
  key: string;
  message: string;
}

export interface SchemaVersionRow {
  version: number;
  applied_at: string;
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
