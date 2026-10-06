export const DEFAULT_PROMPT = `You classify SMS/RCS/MMS text message threads.
Spam = unsolicited marketing, scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
Pictures may be attached: judge what they show. Flyers, ads, promos, prize/crypto/political images, fake invoices and QR codes from an unknown sender are spam. If a picture message arrives without the picture, say so in the reason and stay near 0.5.
OTP = a genuine one-time passcode, verification or login code from a real service, typically just the code plus a "don't share it" warning. A message that pairs a code with a link, prize, payment, or pressure to act is phishing: high spam_probability, otp false.
spam_probability is how likely the thread is spam, from 0 (certainly not) to 1 (certainly spam). When unsure, stay below 0.5.
Reply with JSON only: {"spam_probability": 0-1, "otp": true|false, "reason": "short"}`;

// Defaults that earlier versions saved verbatim from the settings page; a
// stored copy of one of these means "use the current default".
const PREVIOUS_DEFAULT_PROMPTS = [
  `You classify SMS/RCS text message threads.
Spam = unsolicited marketing, scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
OTP = a genuine one-time passcode, verification or login code from a real service, typically just the code plus a "don't share it" warning. A message that pairs a code with a link, prize, payment, or pressure to act is phishing: spam true, otp false.
When unsure, answer not spam.
Reply with JSON only: {"spam": true|false, "otp": true|false, "confidence": 0-1, "reason": "short"}`,
  `You classify SMS/RCS text message threads.
Spam = unsolicited marketing, scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
OTP = the message delivers a one-time passcode, verification or login code. An OTP is never spam.
When unsure, answer not spam.
Reply with JSON only: {"spam": true|false, "otp": true|false, "confidence": 0-1, "reason": "short"}`,
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
