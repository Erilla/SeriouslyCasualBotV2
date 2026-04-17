import { getTrialLogs } from '../../services/warcraftlogs.js';

/**
 * Fetch WarcraftLogs attendance for a character and format as clickable links.
 * Returns null if no logs found.
 */
export async function generateTrialLogsContent(
  characterName: string,
): Promise<string | null> {
  const codes = await getTrialLogs(characterName);

  if (codes.length === 0) {
    return `**WarcraftLogs Attendance**\nNo raid logs found for **${characterName}**.`;
  }

  const links = codes
    .map(
      (code, i) =>
        `${i + 1}. [Report ${code}](https://www.warcraftlogs.com/reports/${code})`,
    )
    .join('\n');

  return `**WarcraftLogs Attendance** (${codes.length} reports)\n${links}`;
}
