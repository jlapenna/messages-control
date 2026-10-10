export const DEFAULT_PROMPT = `You classify SMS/RCS/MMS text message threads.
Spam = scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content, and promotions from senders that are not a real business.
MARKETING = a promotion, sale, coupon, loyalty or newsletter text from a real, identifiable business, store, brand, app or service, typically with a STOP footer. Marketing is not spam: spam_probability low, marketing true. A promotion that is really a scam (prize, crypto, fake brand, link to an odd domain, pressure to act) is spam, marketing false. Alerts and notices from a utility, bank, carrier, insurer, pharmacy or government agency are not marketing even when they carry tips or a STOP footer: marketing false.
Political campaign texts, donation asks and get-out-the-vote blasts are spam, whatever the party and even if the candidate is real.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
Pictures may be attached: judge what they show. Flyers, ads, promos, prize/crypto/political images, fake invoices and QR codes from an unknown sender are spam. If a picture message arrives without the picture, say so in the reason and stay near 0.5.
OTP = a genuine one-time passcode, verification or login code from a real service, typically just the code plus a "don't share it" warning. A message that pairs a code with a link, prize, payment, or pressure to act is phishing: high spam_probability, otp false.
NOTIFICATION = an automated, legitimate status notice whose usefulness ends within about a day: food or order ready for pickup, out for delivery or delivered, driver or ride arriving, table ready, service or repair finished, charging or parking session ended. Only notice-only messages count: nothing to read, keep or act on later. Not notifications: event invitations and updates (Partiful, Evite, Paperless Post, host announcements), bills or payments due, appointments or reminders for a future date, fraud or account-security alerts, anything a person wrote. A notification is not spam; one-time codes are OTP, not notifications.
spam_probability is how likely the thread is spam, from 0 (certainly not) to 1 (certainly spam). When unsure, stay below 0.5.
Reply with JSON only: {"spam_probability": 0-1, "marketing": true|false, "otp": true|false, "notification": true|false, "reason": "short"}`;

// Defaults that earlier versions saved verbatim from the settings page; a
// stored copy of one of these means "use the current default".
const PREVIOUS_DEFAULT_PROMPTS = [
  `You classify SMS/RCS/MMS text message threads.
Spam = scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content, and promotions from senders that are not a real business.
MARKETING = a promotion, sale, coupon, loyalty or newsletter text from a real, identifiable business, store, brand, app or service, typically with a STOP footer. Marketing is not spam: spam_probability low, marketing true. A promotion that is really a scam (prize, crypto, fake brand, link to an odd domain, pressure to act) is spam, marketing false.
Political campaign texts, donation asks and get-out-the-vote blasts are spam, whatever the party and even if the candidate is real.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
Pictures may be attached: judge what they show. Flyers, ads, promos, prize/crypto/political images, fake invoices and QR codes from an unknown sender are spam. If a picture message arrives without the picture, say so in the reason and stay near 0.5.
OTP = a genuine one-time passcode, verification or login code from a real service, typically just the code plus a "don't share it" warning. A message that pairs a code with a link, prize, payment, or pressure to act is phishing: high spam_probability, otp false.
NOTIFICATION = an automated, legitimate status notice whose usefulness ends within about a day: food or order ready for pickup, out for delivery or delivered, driver or ride arriving, table ready, service or repair finished, charging or parking session ended. Only notice-only messages count: nothing to read, keep or act on later. Not notifications: event invitations and updates (Partiful, Evite, Paperless Post, host announcements), bills or payments due, appointments or reminders for a future date, fraud or account-security alerts, anything a person wrote. A notification is not spam; one-time codes are OTP, not notifications.
spam_probability is how likely the thread is spam, from 0 (certainly not) to 1 (certainly spam). When unsure, stay below 0.5.
Reply with JSON only: {"spam_probability": 0-1, "marketing": true|false, "otp": true|false, "notification": true|false, "reason": "short"}`,
  `You classify SMS/RCS/MMS text message threads.
Spam = unsolicited marketing, scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content.
Political campaign texts, donation asks and get-out-the-vote blasts are spam, whatever the party and even if the candidate is real.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
Pictures may be attached: judge what they show. Flyers, ads, promos, prize/crypto/political images, fake invoices and QR codes from an unknown sender are spam. If a picture message arrives without the picture, say so in the reason and stay near 0.5.
OTP = a genuine one-time passcode, verification or login code from a real service, typically just the code plus a "don't share it" warning. A message that pairs a code with a link, prize, payment, or pressure to act is phishing: high spam_probability, otp false.
NOTIFICATION = an automated, legitimate status notice whose usefulness ends within about a day: food or order ready for pickup, out for delivery or delivered, driver or ride arriving, table ready, service or repair finished, charging or parking session ended. Only notice-only messages count: nothing to read, keep or act on later. Not notifications: event invitations and updates (Partiful, Evite, Paperless Post, host announcements), bills or payments due, appointments or reminders for a future date, fraud or account-security alerts, anything a person wrote. A notification is not spam; one-time codes are OTP, not notifications.
spam_probability is how likely the thread is spam, from 0 (certainly not) to 1 (certainly spam). When unsure, stay below 0.5.
Reply with JSON only: {"spam_probability": 0-1, "otp": true|false, "notification": true|false, "reason": "short"}`,
  `You classify SMS/RCS/MMS text message threads.
Spam = unsolicited marketing, scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content.
Political campaign texts, donation asks and get-out-the-vote blasts are spam, whatever the party and even if the candidate is real.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
Pictures may be attached: judge what they show. Flyers, ads, promos, prize/crypto/political images, fake invoices and QR codes from an unknown sender are spam. If a picture message arrives without the picture, say so in the reason and stay near 0.5.
OTP = a genuine one-time passcode, verification or login code from a real service, typically just the code plus a "don't share it" warning. A message that pairs a code with a link, prize, payment, or pressure to act is phishing: high spam_probability, otp false.
NOTIFICATION = an automated, legitimate status notice whose usefulness ends within about a day: food or order ready for pickup, out for delivery or delivered, driver or ride arriving, table ready, service or repair finished, charging or parking session ended. Not notifications: bills or payments due, appointments or reminders for a future date, fraud or account-security alerts, anything a person wrote. A notification is not spam; one-time codes are OTP, not notifications.
spam_probability is how likely the thread is spam, from 0 (certainly not) to 1 (certainly spam). When unsure, stay below 0.5.
Reply with JSON only: {"spam_probability": 0-1, "otp": true|false, "notification": true|false, "reason": "short"}`,
  `You classify SMS/RCS/MMS text message threads.
Spam = unsolicited marketing, scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content.
Political campaign texts, donation asks and get-out-the-vote blasts are spam, whatever the party and even if the candidate is real.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
Pictures may be attached: judge what they show. Flyers, ads, promos, prize/crypto/political images, fake invoices and QR codes from an unknown sender are spam. If a picture message arrives without the picture, say so in the reason and stay near 0.5.
OTP = a genuine one-time passcode, verification or login code from a real service, typically just the code plus a "don't share it" warning. A message that pairs a code with a link, prize, payment, or pressure to act is phishing: high spam_probability, otp false.
spam_probability is how likely the thread is spam, from 0 (certainly not) to 1 (certainly spam). When unsure, stay below 0.5.
Reply with JSON only: {"spam_probability": 0-1, "otp": true|false, "reason": "short"}`,
  `You classify SMS/RCS/MMS text message threads.
Spam = unsolicited marketing, scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, "wrong number" or "hi, is this X?" openers from strangers, gambling, adult content.
NOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.
Pictures may be attached: judge what they show. Flyers, ads, promos, prize/crypto/political images, fake invoices and QR codes from an unknown sender are spam. If a picture message arrives without the picture, say so in the reason and stay near 0.5.
OTP = a genuine one-time passcode, verification or login code from a real service, typically just the code plus a "don't share it" warning. A message that pairs a code with a link, prize, payment, or pressure to act is phishing: high spam_probability, otp false.
spam_probability is how likely the thread is spam, from 0 (certainly not) to 1 (certainly spam). When unsure, stay below 0.5.
Reply with JSON only: {"spam_probability": 0-1, "otp": true|false, "reason": "short"}`,
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
  // 'spam': only new threads are checked; spam is blocked and marketing
  // deleted, nothing else is touched. 'full': also labels existing threads
  // and archives old one-time codes and notices.
  mode: 'spam',
  enabled: true,
  // Never trash or block anything; log what would happen instead. Turn off
  // once the log looks right. (Archiving old notices still happens.)
  dryRun: true,
  // What happens to spam: 'block' (block the sender and report the thread as
  // spam; it moves to Spam & blocked) or 'trash'.
  spamAction: 'block',
  // Any OpenAI-compatible chat completions endpoint.
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  apiKey: '',
  threshold: 0.8,
  // A thread whose name has no digits or "@" is assumed to be a saved contact.
  skipNamedContacts: true,
  // Open picture threads so the model can see the pictures. Opening marks the
  // thread read, which sends an RCS read receipt if those are enabled.
  openPictureThreads: true,
  // Archive one-time codes after 6 hours and notices (order ready,
  // delivered, ...) after a day. Archiving keeps the history, so dry run (which
  // only forbids trashing) doesn't apply.
  archiveOldNotices: true,
  // Only threads this close to the top of the list count as newly arrived.
  topN: 20,
  // Label existing threads for display (badge, side panel). Off in spam mode.
  labelExisting: true,
  prompt: DEFAULT_PROMPT,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  if (PREVIOUS_DEFAULT_PROMPTS.includes(stored.prompt)) delete stored.prompt;
  return { ...DEFAULTS, ...stored };
}
