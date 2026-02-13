import type {
    ChatInputCommandInteraction,
    Client,
    Collection,
    SlashCommandBuilder,
    SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

// --- Bot Core Types ---

export interface BotClient extends Client {
    commands: Collection<string, Command>;
}

export interface Command {
    data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export interface BotEvent {
    name: string;
    once?: boolean;
    execute: (...args: unknown[]) => void | Promise<void>;
}

// --- Log Levels ---

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    FATAL: 4,
};

// --- Database Row Types ---

export interface ChannelConfigRow {
    key: string;
    channel_id: string;
    guild_id: string;
}

export interface SettingsRow {
    key: string;
    value: string;
}

export interface RaiderRow {
    id: number;
    character_name: string;
    discord_user_id: string | null;
    realm: string | null;
    region: string;
}

export interface OverlordRow {
    id: number;
    name: string;
    discord_user_id: string;
}

export interface IgnoredCharacterRow {
    id: number;
    character_name: string;
}

export interface TrialRow {
    id: number;
    thread_id: string;
    character_name: string;
    role: string;
    start_date: string;
    trial_review_message_id: string | null;
    trial_logs_message_id: string | null;
    extended: number;
}

export interface TrialAlertRow {
    id: number;
    thread_id: string;
    alert_date: string;
    sent: number;
}

export interface PromoteAlertRow {
    id: number;
    thread_id: string;
}

export interface ApplicationRow {
    id: number;
    user_id: string;
    channel_id: string | null;
    forum_post_id: string | null;
    status: string;
    submitted_at: string;
}

export interface ApplicationQuestionRow {
    id: number;
    question_text: string;
    sort_order: number;
    active: number;
}

export interface ApplicationSessionRow {
    id: number;
    user_id: string;
    status: string;
    current_question: number;
    answers: string;
    channel_id: string | null;
    forum_post_id: string | null;
}

export interface ApplicationVoteRow {
    id: number;
    forum_post_id: string;
}

export interface VoteEntryRow {
    id: number;
    forum_post_id: string;
    user_id: string;
    vote_type: string;
}

export interface LootPostRow {
    id: number;
    boss_id: number;
    boss_name: string;
    channel_id: string;
    message_id: string;
}

export interface LootResponseRow {
    id: number;
    boss_id: number;
    user_id: string;
    response_type: string;
    character_name: string | null;
}

export interface GuildInfoRow {
    key: string;
    value: string;
}

export interface PriorityLootPostRow {
    key: string;
    value: string;
}

export interface ApplicationAnalyticsRow {
    id: number;
    user_id: string;
    submitted_at: string;
    decided_at: string | null;
    outcome: string | null;
    votes_for: number;
    votes_neutral: number;
    votes_against: number;
}

export interface RaidAttendanceRow {
    id: number;
    raid_date: string;
    raid_id: string;
    character_name: string;
    user_id: string | null;
    signup_status: string;
}

export interface TrialAnalyticsRow {
    id: number;
    character_name: string;
    start_date: string;
    end_date: string | null;
    outcome: string | null;
    extensions: number;
}
