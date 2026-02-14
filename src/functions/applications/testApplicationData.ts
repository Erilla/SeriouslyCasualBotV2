/**
 * Random WoW-themed application content generator for testing the legacy
 * application pipeline. Produces embeds in the exact format used by the
 * 3rd party "Application Bot Premium".
 */
import { EmbedBuilder } from 'discord.js';

// --- Data pools ---

const CHARACTER_NAMES = [
    'Stormcaller', 'Shadowmend', 'Thrallion', 'Moonfire', 'Ashbringer',
    'Felweaver', 'Nightwhisper', 'Ironhide', 'Blazefury', 'Frostbite',
    'Soulrender', 'Lightsworn', 'Darkholme', 'Thunderstrike', 'Voidwalker',
    'Starweaver', 'Doomhammer', 'Spiritclaw', 'Wyrmrest', 'Sunstrider',
];

const CLASS_SPECS = [
    'Fury Warrior, also comfortable tanking as Protection.',
    'Holy Paladin, with a Retribution off-spec for M+.',
    'Frost Mage, can also play Fire depending on the encounter.',
    'Affliction Warlock, happy to swap to Destruction on cleave fights.',
    'Restoration Druid, with Balance as an off-spec.',
    'Havoc Demon Hunter, willing to tank as Vengeance when needed.',
    'Elemental Shaman, can also play Restoration.',
    'Subtlety Rogue, also play Assassination on longer fights.',
    'Discipline Priest, comfortable with Holy as well.',
    'Beast Mastery Hunter, can swap to Marksmanship for raids.',
    'Brewmaster Monk, with a Windwalker DPS off-spec.',
    'Unholy Death Knight, comfortable playing Blood for M+ tanking.',
    'Devastation Evoker, also play Preservation for healing.',
    'Enhancement Shaman, can flex to Restoration.',
    'Survival Hunter, also geared as Marksmanship.',
];

const REALMS = [
    'Draenor', 'Silvermoon', 'Ravencrest', 'Kazzak', 'Tarren Mill',
    'Twisting Nether', 'Ragnaros', 'Stormscale', 'Outland', 'Argent Dawn',
];

const BIO_PARAGRAPHS = [
    "I'm 27, from Sweden. I've been playing WoW on and off since Cataclysm. Outside of gaming I work in IT support and enjoy hiking.",
    "25 year old from the UK, been playing since MoP. I'm a software developer by day and a mythic raider by night. Big fan of competitive PvE.",
    "I'm 32, living in Germany. Started playing WoW during Wrath. I work as a nurse so my schedule can vary, but I always make raid nights.",
    "22 from the Netherlands. Started in BFA and got hooked. Currently studying computer science. I spend most of my free time in WoW.",
    "29, from Ireland. Played since vanilla on and off, took it seriously from Legion onwards. I work in finance and raid as my main hobby.",
    "31, based in Norway. Been playing since TBC. I'm a teacher so I have evenings free for raiding. Love the social aspect of guild life.",
    "24 from Denmark, playing since WoD. Graphic designer IRL. I'm a competitive person and always push myself to improve my gameplay.",
    "28, from Poland. Started during Legion and have been mythic raiding since BFA. I work as a data analyst and enjoy min-maxing everything.",
];

const RAIDING_EXPERIENCE = [
    "I've been raiding mythic since Nighthold in Legion. Cleared CE in Tomb of Sargeras, Uldir, Ny'alotha, Castle Nathria, and Sepulcher. My previous guild disbanded after Dragonflight Season 1.",
    "Cutting Edge in every tier since Castle Nathria. Before that I was a heroic-only raider. My current guild is struggling with roster issues so I'm looking for something more stable.",
    "I achieved CE in Amirdrassil and Aberrus. Before Dragonflight I was mostly a M+ focused player who pugged heroic. Looking to commit to a stable mythic roster.",
    "Mythic raiding since BFA. CE in Eternal Palace, Ny'alotha, Sanctum of Domination, and every Dragonflight tier. My old guild had too many attendance issues.",
    "Started mythic raiding in Shadowlands. Got 8/10M in Sanctum, CE in Sepulcher, and CE in every tier since. Looking for a guild with a similar semi-hardcore mindset.",
    "CE in Vault of the Incarnates, Aberrus, and Amirdrassil. Also did some mythic in BFA but never finished a tier. I keep detailed logs of my performance.",
];

const OFFSPEC_ANSWERS = [
    "I play all specs of my class comfortably. I also have a geared Demon Hunter alt that I've done some mythic bosses on.",
    "My off-spec is well geared and I'm happy to swap whenever needed. I also maintain a healer alt for M+ with friends.",
    "I can play any spec of my class at a mythic level. I also have two alts that are heroic-geared and M+ ready.",
    "I keep my off-spec competitive and swap regularly in M+. No raid-ready alts at the moment but happy to level one if needed.",
    "My main alt is a different role entirely — I have a tank alt that I run keys on weekly. Happy to bring either character.",
    "I focus on my main spec but can swap to my off-spec if the raid needs it. I've also got a healer alt I'm gearing up.",
];

const WHY_THIS_GUILD = [
    "I've heard great things about your guild from friends on the server. The raid times work perfectly for me and I like the semi-hardcore approach — pushing CE without burning out.",
    "I looked at your Raider.IO profile and your progression pace matches what I'm looking for. I also like that you value a good atmosphere alongside competitive play.",
    "A friend of mine used to raid with you and recommended I apply. Your raid schedule fits my availability and I appreciate guilds that balance progression with having fun.",
    "I've been looking for a stable CE guild on this server for a while. Your WarcraftLogs rankings and consistent progress across tiers caught my eye.",
    "Your recruitment post mentioned you value consistency and showing up prepared — that's exactly my playstyle. I also love that you do M+ together outside of raids.",
];

const ADDITIONAL_INFO = [
    "I'm a reliable and dedicated player who shows up prepared every raid night. I always have consumables, know the fights beforehand, and I'm open to constructive feedback.",
    "I take raiding seriously but I also value the social side. I'm always happy to help guildies with M+ keys and I enjoy theorycrafting my class.",
    "I've been an officer and raid leader in previous guilds, so I understand what goes into running a roster. I'm low-maintenance and just want to raid at a high level.",
    "I'm very active outside of raid nights — I run high keys, do PvP for fun, and I'm always online if anyone needs help. I also bring snacks (figuratively).",
    "I keep detailed notes on my performance after every raid night and actively work on improving. I'm always open to feedback and happy to take direction from officers.",
];

const QUESTIONS = [
    'What class and (if you\'re a multi-role class) spec are you applying as?',
    'Please link your Raider.IO profile of the character you wish to apply with',
    'Tell us about yourself, this should include your age, location and any other aspects about your life that you are willing to share',
    'What is your raiding experience? Which notable bosses have you killed at the highest difficulty? If you were previously in a guild, let us know which one and why you left.',
    'Why do you want to join SeriouslyCasual? What makes us a good fit for you?',
    'Do you have an offspec or any other classes you\'d be able to play and willing to raid as? If so please provide logs (Mythic logs preferred)',
    'Would you like to include any further information to support your application? This is the final question after which you can submit all answers provided.',
    'We try to review and respond to applications as quick as we can. Please be warned that it can take up to a week for us to come to a decision. Would you like to submit your application?',
];

// --- Helpers ---

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function buildRaiderIoLink(name: string, realm: string): string {
    return `https://raider.io/characters/eu/${realm.toLowerCase().replace(/\s/g, '-')}/${name}`;
}

// --- Public API ---

export interface GeneratedApplication {
    characterName: string;
    embeds: EmbedBuilder[];
}

/**
 * Generate a random application in the 3rd party bot's exact embed format.
 * Returns the character name and an array of EmbedBuilder instances ready to send.
 */
export function generateRandomApplication(userId: string): GeneratedApplication {
    const characterName = pick(CHARACTER_NAMES);
    const realm = pick(REALMS);

    // Build answers corresponding to each question
    const answers: string[] = [
        pick(CLASS_SPECS),
        `${buildRaiderIoLink(characterName, realm)} I've been maining this character since Dragonflight and it's by far my most played.`,
        pick(BIO_PARAGRAPHS),
        pick(RAIDING_EXPERIENCE),
        pick(WHY_THIS_GUILD),
        pick(OFFSPEC_ANSWERS),
        pick(ADDITIONAL_INFO),
        'Yes',
    ];

    // Build the full Q&A body
    const header = `----------NEW-SeriouslyCasual-Silvermoon Mythic Raider Application----------`;
    const qaPairs = QUESTIONS.map((q, i) => `**${q}** -\n${answers[i]}`);
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const footer = `Date of Application: ${dateStr}\nName of Applicant: ${characterName.toLowerCase()} (<@${userId}>)`;

    const fullBody = [header, '', ...qaPairs, '', footer].join('\n');

    // Split into embeds at ~3900 chars to stay under the 4096 embed description limit
    const MAX_DESC = 3900;
    const embeds: EmbedBuilder[] = [];

    if (fullBody.length <= MAX_DESC) {
        embeds.push(new EmbedBuilder().setDescription(fullBody).setColor(0x2b2d31));
    } else {
        // Split at line boundaries
        const lines = fullBody.split('\n');
        let current = '';

        for (const line of lines) {
            const candidate = current ? `${current}\n${line}` : line;
            if (candidate.length > MAX_DESC && current) {
                embeds.push(new EmbedBuilder().setDescription(current).setColor(0x2b2d31));
                current = line;
            } else {
                current = candidate;
            }
        }
        if (current) {
            embeds.push(new EmbedBuilder().setDescription(current).setColor(0x2b2d31));
        }

        // Add pagination footers
        const total = embeds.length;
        for (let i = 0; i < total; i++) {
            const existing = embeds[i].data.description ?? '';
            embeds[i].setDescription(
                `${existing}\n\n*This application has been split into multiple messages*\nPage ${i + 1}/${total}`,
            );
        }
    }

    return { characterName, embeds };
}
