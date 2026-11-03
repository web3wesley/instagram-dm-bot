import { parseTriggers, type TriggerSet } from '../../src/config/triggers.ts';

export const DEFAULTS = {
  intro: "Hey {username}! Reply to this message and I'll send you the {keyword} link 👇 (automated)",
  linkMessage: 'Here you go {username}: {link}',
  publicReplies: [
    '{Sent|Just sent} you a DM {username} 📩',
    'Check your DMs {username} {👀|🙌}',
    'Link is in your inbox {username}',
    "DM'd you {username} 🔥",
  ],
};

export const TEST_LINK = 'https://www.skool.com/test-community';

export function makeTriggers(
  triggers: Array<Record<string, unknown>>,
  defaults: Record<string, unknown> = DEFAULTS,
): TriggerSet {
  return parseTriggers({ defaults, triggers: triggers.map((t) => ({ link: TEST_LINK, ...t })) });
}
