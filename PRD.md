# SeriouslyCasualBotV2 - Product Requirements Document

## Project Overview
Complete rewrite of SeriouslyCasualBot (WoW guild management Discord bot) using TypeScript/ESM/Discord.js v14/better-sqlite3/BullMQ. Based on KevinNovak/Discord-Bot-TypeScript-Template.

## Tasks

```json
{
  "tasks": [
    {
      "id": 1,
      "title": "Foundation & Bot Template",
      "status": "complete",
      "description": "Clone KevinNovak template, adapt for our stack (better-sqlite3, BullMQ, ioredis, axios). Set up TypeScript/ESM, Docker, CI/CD, logging system, audit log, permission system, pagination utility, graceful shutdown, bot status, /ping and /help commands.",
      "dependencies": [],
      "files": [
        "package.json",
        "tsconfig.json",
        ".gitignore",
        ".env.example",
        "Dockerfile",
        "docker-compose.yml",
        ".github/workflows/ci.yml",
        "src/index.ts",
        "src/config.ts",
        "src/types/index.ts",
        "src/utils.ts",
        "src/utils/pagination.ts",
        "src/utils/permissions.ts",
        "src/deploy-commands.ts",
        "src/services/logger.ts",
        "src/services/auditLog.ts",
        "src/commands/ping.ts",
        "src/commands/help.ts",
        "src/commands/loglevel.ts",
        "src/events/ready.ts",
        "src/events/interactionCreate.ts"
      ],
      "verify": [
        "npm install succeeds",
        "npm run build has zero errors",
        "/ping responds with Pong!",
        "Logs category and channels auto-created",
        "Graceful shutdown works on SIGTERM"
      ]
    },
    {
      "id": 2,
      "title": "Database, Scheduler, Settings & Setup",
      "status": "complete",
      "description": "Set up better-sqlite3 with all table schemas, DB migration system, BullMQ scheduler, /settings command for feature toggles, /setup command for channel/role configuration at runtime. Graceful degradation when channels not configured.",
      "dependencies": [1],
      "files": [
        "src/database/database.ts",
        "src/database/schema.ts",
        "src/database/migrations.ts",
        "src/scheduler/scheduler.ts",
        "src/scheduler/jobs.ts",
        "src/functions/settings/settings.ts",
        "src/functions/settings/getSettings.ts",
        "src/functions/settings/setSetting.ts",
        "src/functions/settings/getAllSettings.ts",
        "src/functions/setup/getChannel.ts",
        "src/functions/setup/setChannel.ts",
        "src/functions/setup/getAllChannels.ts",
        "src/commands/settings.ts",
        "src/commands/setup.ts"
      ],
      "tables": [
        "channel_config",
        "settings",
        "raiders",
        "overlords",
        "ignored_characters",
        "trials",
        "trial_alerts",
        "promote_alerts",
        "applications",
        "application_questions",
        "application_sessions",
        "application_votes",
        "vote_entries",
        "loot_posts",
        "loot_responses",
        "guild_info",
        "priority_loot_post",
        "application_analytics",
        "raid_attendance",
        "trial_analytics"
      ],
      "verify": [
        "DB file created on startup with all tables",
        "BullMQ connects to Redis",
        "/settings get_all_settings works",
        "/settings toggle_setting works",
        "/setup set_channel stores correctly",
        "/setup get_config shows all assignments",
        "Bot status shows 'Run /setup to configure' when unconfigured",
        "Build passes with zero errors"
      ]
    },
    {
      "id": 3,
      "title": "Guild Info Embeds",
      "status": "complete",
      "description": "Guild info display: JSON data files for static content, Raider.io service for dynamic achievement/ranking data, embed builders, /guildinfo and /updateachievements commands. Scheduled achievement updates every 30min via BullMQ.",
      "dependencies": [2],
      "files": [
        "data/aboutus.json",
        "data/schedule.json",
        "data/recruitment.json",
        "data/achievements.json",
        "src/services/raiderio.ts",
        "src/functions/guild-info/clearGuildInfo.ts",
        "src/functions/guild-info/updateAboutUs.ts",
        "src/functions/guild-info/updateSchedule.ts",
        "src/functions/guild-info/updateRecruitment.ts",
        "src/functions/guild-info/updateAchievements.ts",
        "src/commands/guildinfo.ts",
        "src/commands/updateachievements.ts"
      ],
      "scheduled": ["updateAchievements every 30min"],
      "verify": [
        "/guildinfo posts all embeds to configured channel",
        "/updateachievements updates achievements embed",
        "Achievements auto-update every 30min",
        "Build passes"
      ]
    },
    {
      "id": 4,
      "title": "Raider Management",
      "status": "pending",
      "description": "Roster sync via Raider.io, overlord (guild leadership) management, ignored characters, M+ reports, Great Vault tracking. 12 /raiders subcommands. Scheduled sync and weekly reports.",
      "dependencies": [2, 3],
      "files": [
        "src/services/raiderio.ts (add getGuildRoster, getPreviousWeeklyHighestMythicPlusRun)",
        "src/services/wowaudit.ts (getHistoricalData, getCurrentPeriod)",
        "src/functions/raids/getRaiders.ts",
        "src/functions/raids/syncRaiders.ts",
        "src/functions/raids/sendAlertForRaidersWithNoUser.ts",
        "src/functions/raids/updateRaiderDiscordUser.ts",
        "src/functions/raids/ignoreCharacter.ts",
        "src/functions/raids/overlords.ts",
        "src/functions/raids/alertHighestMythicPlusDone.ts",
        "src/functions/addOverlordsToThread.ts",
        "src/commands/raiders.ts"
      ],
      "subcommands": [
        "get_raiders",
        "sync_raiders",
        "check_missing_users",
        "update_raider_user",
        "add_overlord",
        "remove_overlord",
        "get_overlords",
        "ignore_character",
        "remove_ignore_character",
        "get_ignored_characters",
        "previous_highest_mythicplus",
        "previous_great_vault"
      ],
      "scheduled": ["syncRaiders every 10min", "weeklyReports noon Wednesday"],
      "verify": [
        "All 12 subcommands functional",
        "Roster sync with Raider.io works",
        "Weekly reports fire on schedule",
        "Build passes"
      ]
    },
    {
      "id": 5,
      "title": "Application System",
      "status": "pending",
      "description": "Custom applicant-facing application system with DM questionnaire flow. Supports both custom mode (built-in DM questions) and legacy mode (monitor 3rd party bot channels). Configurable questions stored in DB. Creates applicant text channel + officers-only forum post with voting buttons and forum tags.",
      "dependencies": [2],
      "settings": {
        "use_custom_applications": "Toggle between custom DM questionnaire and legacy 3rd party bot monitoring"
      },
      "custom_mode_flow": [
        "Applicant triggers via /apply or 'Apply Now' button",
        "Bot DMs applicant with questions one at a time",
        "After confirmation, creates text channel (applicant+officers)",
        "Creates forum post in Applications Forum with voting buttons",
        "Forum tag set to 'Active'",
        "Applicant gets DM confirmation"
      ],
      "legacy_mode_flow": [
        "Bot scans applications category for new channels (3rd party bot)",
        "Copies application content",
        "Creates forum post with voting buttons + 'Active' tag",
        "Scheduled: checkApplications every 5min"
      ],
      "default_questions": [
        "What class and (if multi-role) spec are you applying as?",
        "Please link your Raider.IO profile of the character you wish to apply with",
        "Tell us about yourself - age, location, and any other aspects you're willing to share",
        "How did you find us and what made you want to apply to SeriouslyCasual? (Include any known members)",
        "What is your current and past experience in raiding at the highest level? (MYTHIC progression while current only, include logs)",
        "We aim to achieve Cutting Edge every tier. If you haven't done this, showcase your ability (M+ logs, PvP achievements, heroic logs, etc.)",
        "Could you commit to both a Wednesday and Sunday raid each week? Is there anything that might interfere?",
        "Do you have an offspec or other classes you'd play and raid as? If so, provide logs (Mythic preferred)",
        "Would you like to include any further information to support your application?"
      ],
      "forum_tags": ["Active", "Accepted", "Rejected"],
      "files": [
        "src/functions/applications/startApplication.ts",
        "src/functions/applications/dmQuestionnaire.ts",
        "src/functions/applications/submitApplication.ts",
        "src/functions/applications/createApplicationChannel.ts",
        "src/functions/applications/createForumPost.ts",
        "src/functions/applications/checkApplicationsLegacy.ts",
        "src/functions/applications/copyApplicationToViewer.ts",
        "src/commands/apply.ts",
        "src/commands/applications.ts"
      ],
      "verify": [
        "/apply triggers DM questionnaire flow",
        "Questions are configurable via admin command",
        "Text channel + forum post created on submit",
        "Forum tags applied correctly",
        "Legacy mode scans 3rd party channels when enabled",
        "Build passes"
      ]
    },
    {
      "id": 6,
      "title": "Application Review",
      "status": "pending",
      "description": "Officer-facing review system: voting buttons in forum posts (For/Neutral/Against/Kekw), accept/reject workflow with DM notifications to applicant. Collects analytics data (submission date, outcome, vote counts).",
      "dependencies": [5],
      "files": [
        "src/functions/applications/generateVotingMessage.ts",
        "src/functions/applications/voteApplicant.ts",
        "src/functions/applications/acceptApplication.ts",
        "src/functions/applications/rejectApplication.ts",
        "src/functions/applications/notifyApplicant.ts",
        "src/events/interactionCreate.ts (update)"
      ],
      "verify": [
        "Voting buttons work (For/Neutral/Against/Kekw)",
        "Accept DMs applicant and bridges to trial creation",
        "Reject DMs applicant and archives channel/post",
        "Forum tag changes to Accepted or Rejected",
        "Analytics data collected in application_analytics table",
        "Build passes"
      ]
    },
    {
      "id": 7,
      "title": "Trial Management",
      "status": "pending",
      "description": "WarcraftLogs OAuth2+GraphQL integration, trial review forum posts with buttons (Update/Extend/Promote/Close), modal for trial info, review and promotion alerts, forum tags. 6 /trials subcommands. Collects trial outcome analytics.",
      "dependencies": [4, 6],
      "forum_tags": ["In Review", "Extended", "Promoted", "Closed"],
      "files": [
        "src/services/warcraftlogs.ts",
        "src/functions/trial-review/createTrialReviewPost.ts",
        "src/functions/trial-review/trialInfoModal.ts",
        "src/functions/trial-review/generateTrialReviewMessage.ts",
        "src/functions/trial-review/generateTrialReviewContent.ts",
        "src/functions/trial-review/calculateReviewDates.ts",
        "src/functions/trial-review/calculateExtendedDates.ts",
        "src/functions/trial-review/dateInputValidator.ts",
        "src/functions/trial-review/generateTrialLogsContent.ts",
        "src/functions/trial-review/getTrialLogs.ts",
        "src/functions/trial-review/updateTrialLogs.ts",
        "src/functions/trial-review/updateTrialReviewMessages.ts",
        "src/functions/trial-review/getCurrentTrials.ts",
        "src/functions/trial-review/removeTrial.ts",
        "src/functions/trial-review/changeTrialInfo.ts",
        "src/functions/trial-review/extendTrial.ts",
        "src/functions/trial-review/markToPromote.ts",
        "src/functions/trial-review/checkForReviewAlerts.ts",
        "src/functions/trial-review/alertPromotions.ts",
        "src/functions/trial-review/keepTrialPostsAlive.ts",
        "src/commands/trials.ts",
        "src/events/interactionCreate.ts (update)"
      ],
      "subcommands": [
        "create_thread",
        "get_current_trials",
        "remove_trial",
        "change_trial_info",
        "update_trial_logs",
        "update_trial_review_messages"
      ],
      "scheduled": [
        "updateTrialLogs every 60min",
        "keepTrialPostsAlive every 6min",
        "checkReviewAlerts every 3min",
        "checkPromotionAlerts every 5min"
      ],
      "verify": [
        "WarcraftLogs OAuth2 token caching works",
        "Full trial lifecycle: create -> review -> extend/promote/close",
        "Forum tags change on status update",
        "Review alerts fire at 2-week and 4-week marks",
        "Trial analytics collected",
        "Build passes"
      ]
    },
    {
      "id": 8,
      "title": "Raid Signup Alerts",
      "status": "pending",
      "description": "WoW Audit integration for raid signup tracking. Configurable 48hr/24hr alerts before raids. AI-generated quips via OpenAI GPT-4o-mini. /raids command for manual trigger. Collects raid attendance analytics.",
      "dependencies": [2, 4],
      "files": [
        "src/services/openai.ts",
        "src/services/wowaudit.ts (add getUpcomingRaids, getRaidDetails)",
        "src/functions/raids/alertSignups.ts",
        "src/functions/raids/getCurrentSignupsForNextRaid.ts",
        "src/commands/raids.ts"
      ],
      "scheduled": ["alertSignups (configurable, 48hr/24hr before raid)"],
      "verify": [
        "/raids alert_signups identifies unsigned raiders",
        "AI-generated quips included in alerts",
        "Scheduled alerts fire correctly",
        "Raid attendance data collected",
        "Build passes"
      ]
    },
    {
      "id": 9,
      "title": "Loot Management",
      "status": "pending",
      "description": "Boss loot posts with button-based responses (Major/Minor/Want In/Do Not Need). Auto-create posts from Raider.io raid data. Manual post creation/deletion. 5 /loot subcommands.",
      "dependencies": [3, 4],
      "files": [
        "src/functions/loot/generateLootPost.ts",
        "src/functions/loot/addLootPost.ts",
        "src/functions/loot/deleteLootPost.ts",
        "src/functions/loot/updateLootResponse.ts",
        "src/functions/loot/checkRaidExpansions.ts",
        "src/functions/loot/updateLootPost.ts",
        "src/commands/loot.ts",
        "src/events/interactionCreate.ts (update)"
      ],
      "subcommands": [
        "add_post",
        "delete_post",
        "delete_posts",
        "create_posts",
        "update_priority_post"
      ],
      "verify": [
        "Loot posts with four buttons displayed",
        "Button clicks update responses and embed",
        "Auto-create from Raider.io works",
        "Delete commands work",
        "Build passes"
      ]
    },
    {
      "id": 10,
      "title": "EPGP Integration",
      "status": "pending",
      "description": "EPGP priority rankings via existing API (integration approach deferred). /epgp command with filtering by tier token or armour type. Priority post auto-update every 10min.",
      "dependencies": [9],
      "files": [
        "src/services/epgp.ts",
        "src/functions/epgp/priorityRankingPost.ts",
        "src/commands/epgp.ts"
      ],
      "subcommands": ["get_by_token", "get_by_armour"],
      "scheduled": ["updatePriorityPost every 10min"],
      "verify": [
        "/epgp get_by_token returns formatted table",
        "/epgp get_by_armour returns formatted table",
        "Priority post auto-updates",
        "Build passes"
      ]
    }
  ]
}
```

## Channel Configuration (via /setup)
| Purpose | Description |
|---------|------------|
| guild_info | Guild info embeds (About Us, Schedule, etc.) |
| applications_category | Category for application channels (legacy mode) |
| applications_forum | Forum channel for officer application reviews |
| trial_review_forum | Forum channel for trial reviews |
| raiders_lounge | Signup alerts + M+ reports |
| loot | Loot posts |
| priority_loot | EPGP priority post |
| weekly_check | Weekly M+/vault reports |
| bot_setup | Bot admin area |
| audit | Audit log channel |

## Workflow
- **Commit after each task**: Before starting the next task, commit all changes from the completed task to git.
- **Update memory after each task**: Add key patterns, decisions, and implementation details to MEMORY.md so future agents can reference them.
- **Create/update skills after each task**: Add or update `.claude/skills/*.md` files documenting how to use the systems implemented. Skills should be practical reference guides for future agents.

## Testing Strategy
- **Build check**: `npm run build` must pass with zero errors after every task
- **Run check**: Start the bot with `npm run dev` and verify no startup errors in console
- **Unit tests**: `npm test` - vitest, business logic + DB operations + service parsing
- **Live Discord tests**: LOCAL ONLY, real test server, verify commands/embeds/buttons work
- **Verification per task**: build + run + test + manual Discord check
