import type Database from 'better-sqlite3';

export function seedDatabase(db: Database.Database): void {
  const hasData = db.prepare('SELECT COUNT(*) as count FROM guild_info_content').get() as { count: number };
  if (hasData.count > 0) return;

  const tx = db.transaction(() => {
    // About Us
    db.prepare('INSERT INTO guild_info_content (key, title, content) VALUES (?, ?, ?)').run(
      'aboutus',
      'About Us',
      '**<SeriouslyCasual>** is a two-day Alliance mythic raiding guild. We were founded in 2013 and continue to progress every raid tier at Silvermoon-EU.\n\nOur aim is to obtain every Cutting Edge achievement there is while respecting the fact this game is NOT someone\'s second job.\n\nIf you\'re a fan of banter, memes, and high-end progression, then welcome to your new home.',
    );

    db.prepare('INSERT INTO guild_info_content (key, title, content) VALUES (?, ?, ?)').run(
      'achievements_title', 'Current Progress & Past Achievements', '',
    );

    // Recruitment sections
    const recruitmentSections = [
      { key: 'recruitment_who', title: 'Who are we', body: 'A SeriouslyCasual player is one that knows the ins and outs of their class, can consistently perform up to a mythic raiding standard, and enjoys a relaxed social environment. If that sounds like you, then we\'d love to hear from you!' },
      { key: 'recruitment_want', title: 'What We Want From You', body: '- Know everything there is to know about your class at any given time. This includes rotations, use of defensives, consumables, legendaries, specs, enchants, and the like.\n- Be proactive and prepared for every raid encounter. This means researching boss fights.\n- Be mature and friendly. Bonus points if you\'re funny.\n- Attend at least 90% of our scheduled raids within any given tier.\n- Be ready to receive criticism (where its warranted, of course).' },
      { key: 'recruitment_give', title: 'What We Can Give You', body: '- A stable mythic raiding guild with over 9 years of raiding at World of Warcraft\'s highest levels.\n- A platform where you can constantly learn and grow as a player.\n- A great social environment with an active Discord for WoW and even other gaming interests!\n- Memes. So many memes.\n\nIf you\'re an exceptional player and your class isn\'t listed, we still encourage you to apply. Exceptional players will always be considered regardless of class or spec.' },
      { key: 'recruitment_contact', title: 'Need to know more? Contact these guys!', body: 'Contact {{OVERLORDS}} if you have any questions.' },
    ];

    for (const section of recruitmentSections) {
      db.prepare('INSERT INTO guild_info_content (key, title, content) VALUES (?, ?, ?)').run(section.key, section.title, section.body);
    }

    // Schedule
    db.prepare('INSERT INTO schedule_config (key, value) VALUES (?, ?)').run('title', 'Raid Schedule');
    db.prepare('INSERT INTO schedule_config (key, value) VALUES (?, ?)').run('timezone', 'Server Time (CEST +1)');
    db.prepare('INSERT INTO schedule_days (day, time, sort_order) VALUES (?, ?, ?)').run('Wednesday', '20:00 - 23:00', 1);
    db.prepare('INSERT INTO schedule_days (day, time, sort_order) VALUES (?, ?, ?)').run('Sunday', '20:00 - 23:00', 2);

    // Guild info links
    db.prepare('INSERT INTO guild_info_links (label, url, emoji_id) VALUES (?, ?, ?)').run('RaiderIO', 'https://raider.io/guilds/eu/silvermoon/SeriouslyCasual', '858702994497208340');
    db.prepare('INSERT INTO guild_info_links (label, url, emoji_id) VALUES (?, ?, ?)').run('WoWProgress', 'https://www.wowprogress.com/guild/eu/silvermoon/SeriouslyCasual', '858703946302750740');
    db.prepare('INSERT INTO guild_info_links (label, url, emoji_id) VALUES (?, ?, ?)').run('Warcraft Logs', 'https://www.warcraftlogs.com/guild/id/486913', '858704238036123688');

    // Manual achievements
    const achievements = [
      { raid: 'Siege of Orgrimmar (10 man)', progress: '14/14HC', result: '**CE** WR 1997', expansion: 4, sort: 1 },
      { raid: 'Highmaul', progress: '7/7M', result: '**CE** WR 1252', expansion: 5, sort: 1 },
      { raid: 'Blackrock Foundry', progress: '8/10M', result: 'WR 1132', expansion: 5, sort: 2 },
      { raid: 'Hellfire Citadel', progress: '13/13M', result: '**CE** WR 1170', expansion: 5, sort: 3 },
    ];

    for (const a of achievements) {
      db.prepare('INSERT INTO achievements_manual (raid, progress, result, expansion, sort_order) VALUES (?, ?, ?, ?, ?)').run(a.raid, a.progress, a.result, a.expansion, a.sort);
    }

    // Default application messages
    db.prepare('INSERT INTO default_messages (key, message) VALUES (?, ?)').run(
      'application_accept',
      'Hey there! We would love to offer you a trial spot to raid with SeriouslyCasual. Please message @Warzania (warzania), @Bing (eclipsoid) or @Splo (splosion) on Discord for an invite. You have now been given the Raider role within our Discord that enables several new channels to be viewable. Please make sure to read the #welcome-to-sc channel in the raiders group as soon as possible as this will explain our trial period / raid signups / expectations and required addons. If you have any further questions, please feel free to contact Warzania, Bing or Splo on Discord.',
    );
    db.prepare('INSERT INTO default_messages (key, message) VALUES (?, ?)').run(
      'application_reject',
      'Thank you for your interest in raiding with us. However, in this instance, I\'m afraid we are unable to offer you a raid spot. We wish you luck on your guild search.',
    );

    // Default settings (all disabled)
    for (const key of ['alertSignup_Wednesday', 'alertSignup_Wednesday_48', 'alertSignup_Sunday', 'alertSignup_Sunday_48']) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, 0);
    }
  });

  tx();
}
