export const DEFAULT_PROMPT = `You classify SMS/RCS text message threads.
Spam = unsolicited marketing, scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
OTP = the message delivers a one-time passcode, verification or login code. An OTP is never spam.
When unsure, answer not spam.
Reply with JSON only: {"spam": true|false, "otp": true|false, "confidence": 0-1, "reason": "short"}`;

// Defaults that earlier versions saved verbatim from the settings page; a
// stored copy of one of these means "use the current default".
const PREVIOUS_DEFAULT_PROMPTS = [
  `You classify SMS/RCS text message threads as spam or not.
Spam = unsolicited marketing, scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
When unsure, answer not spam.
Reply with JSON only: {"spam": true|false, "confidence": 0-1, "reason": "short"}`,
];

export const DEFAULTS = {
  enabled: true,
  // Log what would be deleted without deleting. Turn off once the log looks right.
  dryRun: true,
  endpoint: 'https://llm.jlapenna.net/v1/chat/completions',
  model: 'default',
  apiKey: '',
  threshold: 0.8,
  // A thread whose name has no digits or "@" is assumed to be a saved contact.
  skipNamedContacts: true,
  // Only threads this close to the top of the list count as newly arrived.
  topN: 20,
  prompt: DEFAULT_PROMPT,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  if (PREVIOUS_DEFAULT_PROMPTS.includes(stored.prompt)) delete stored.prompt;
  return { ...DEFAULTS, ...stored };
}
