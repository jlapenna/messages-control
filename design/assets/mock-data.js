/* Embedded mock data for the Messages Control prototype. Nothing here is fetched;
   phone numbers use the fictional 555-01xx range. Config keys and the default
   prompt mirror ~/.config/messages-control/config.json and settings.js. */
window.MC_DATA = {
  now: '2026-10-12T09:30:00',
  lastSweep: '2026-10-12T09:28:00',

  config: {
    apiKeyLast4: '7f2c',
    endpoint: 'http://127.0.0.1:4000/v1/chat/completions',
    model: 'default',
    threshold: 0.8,
    spamAction: 'block',
    skipNamedContacts: true,
    openPictureThreads: true,
    archiveOldNotices: true,
    topN: 20,
    prompt: "You classify SMS/RCS/MMS text message threads.\nSpam = scams, phishing, fake toll/package/delivery/DMV notices, political fundraising, crypto/job/loan/debt offers, \"wrong number\" or \"hi, is this X?\" openers from strangers, gambling, adult content, and promotions from senders that are not a real business.\nMARKETING = a promotion, sale, coupon, loyalty or newsletter text from a real, identifiable business, store, brand, app or service, typically with a STOP footer. Marketing is not spam: spam_probability low, marketing true. A promotion that is really a scam (prize, crypto, fake brand, link to an odd domain, pressure to act) is spam, marketing false. Alerts and notices from a utility, bank, carrier, insurer, pharmacy or government agency are not marketing even when they carry tips or a STOP footer: marketing false.\nPolitical campaign texts, donation asks and get-out-the-vote blasts are spam, whatever the party and even if the candidate is real.\nNOT spam = personal messages, 2FA/verification codes, appointment and pharmacy reminders, bank/carrier/utility alerts, real delivery updates without suspicious links, group chats with friends.\nPictures may be attached: judge what they show. Flyers, ads, promos, prize/crypto/political images, fake invoices and QR codes from an unknown sender are spam. If a picture message arrives without the picture, judge the text on its own (a fundraising ask, a sales pitch or a scam reads the same without its picture) and say the picture was missing in the reason; stay near 0.5 only when the text alone says nothing.\nOTP = a genuine one-time passcode, verification or login code from a real service, typically just the code plus a \"don't share it\" warning. A message that pairs a code with a link, prize, payment, or pressure to act is phishing: high spam_probability, otp false.\nNOTIFICATION = an automated, legitimate status notice whose usefulness ends within about a day: food or order ready for pickup, out for delivery or delivered, driver or ride arriving, table ready, service or repair finished, charging or parking session ended. Only notice-only messages count: nothing to read, keep or act on later. Not notifications: event invitations and updates (Partiful, Evite, Paperless Post, host announcements), bills or payments due, appointments or reminders for a future date, fraud or account-security alerts, anything a person wrote. A notification is not spam; one-time codes are OTP, not notifications.\nTRANSACTIONAL = a legitimate message with something to keep or act on later: a receipt or order confirmation, a bill or payment due, an appointment or reservation, a shipment with a tracking number, a flight or ticket. Not spam, not marketing, not a one-day notice. For a transactional message fill \"extract\": {\"summary\": one line, \"date\": \"YYYY-MM-DD\" if a date matters, \"amount\": \"$12.34\" if money is involved, \"code\": a confirmation, order or tracking number if there is one}; otherwise leave \"extract\" empty.\nspam_probability is how likely the thread is spam, from 0 (certainly not) to 1 (certainly spam). When unsure, stay below 0.5.\nReply with JSON only: {\"spam_probability\": 0-1, \"marketing\": true|false, \"otp\": true|false, \"notification\": true|false, \"transactional\": true|false, \"extract\": {}, \"reason\": \"short\"}",
  },

  runner: {
    configPath: '~/.config/messages-control/config.json',
    profileDir: '~/.local/state/messages-control/profile',
    stateFile: '~/.local/state/messages-control/state.json',
    pairedAt: '2026-09-28T18:40:00',
    page: 'messages.google.com/web/conversations',
    mode: 'full',
    api: '127.0.0.1:7373',
    reloadMinutes: 20,
    lastReload: '2026-10-12T09:10:00',
    heartbeat: '2026-10-12T09:29:40',
    offlineSince: '2026-10-12T08:52:00',
    latencyMs: 1380,
  },

  // spam_probability (p) plus the prompt's flags, as the model returned them.
  threads: [
    { id: 't01', at: '2026-10-12T09:26', sender: '+1 (209) 555-0187', snippet: 'USPS: Your package is held at our facility due to an incomplete address. Update within 24 hours: usps-redelivery-help.com/track', p: 0.97, reason: 'Fake USPS redelivery notice pointing to a lookalike domain.', pendingOnError: true },
    { id: 't02', at: '2026-10-12T09:21', sender: '22000', snippet: 'G-482913 is your Google verification code. Don\'t share it with anyone.', p: 0.02, otp: true, reason: 'Genuine Google verification code with a do-not-share warning.', pendingOnError: true },
    { id: 't03', at: '2026-10-12T09:17', sender: '+1 (213) 555-0155', snippet: 'Amazon: unusual sign-in attempt on your account. If this wasn\'t you, verify at amzn-secure-login.co within 12 hours.', p: 0.76, reason: 'Security alert links to amzn-secure-login.co, not an Amazon domain; could be a badly formatted real alert.', pendingOnError: true },
    { id: 't04', at: '2026-10-12T09:12', sender: '+1 (628) 555-0119', snippet: 'Hi, is this Daniel? We met at the conference last month, you said to text about the investment group', p: 0.84, reason: '"Is this Daniel?" opener from a stranger that pivots to an investment pitch.' },
    { id: 't05', at: '2026-10-12T09:05', sender: '89203', snippet: 'Your Dasher is approaching with your order. Meet them at the door.', p: 0.03, notification: true, reason: 'Delivery status notice; useful for about an hour.' },
    { id: 't06', at: '2026-10-12T08:58', sender: 'Mom', named: true, snippet: 'Are you still coming Sunday? Dad is making ribs, bring the folding chairs', p: 0.01, reason: 'Personal message from family.' },
    { id: 't07', at: '2026-10-12T08:44', sender: '72166', snippet: 'FINAL DEADLINE: we\'re $4,812 short before midnight. Chip in $15 now to keep the majority. Reply STOP to quit', p: 0.88, reason: 'Political fundraising blast with a midnight deadline.' },
    { id: 't08', at: '2026-10-12T08:31', sender: '+1 (510) 555-0163', snippet: 'Kaiser Permanente: Your prescription is ready for pickup at the Oakland pharmacy.', p: 0.04, notification: true, reason: 'Pharmacy pickup notice from a real provider.' },
    { id: 't09', at: '2026-10-12T08:12', sender: '+1 (737) 555-0131', snippet: '[Picture] you need to see this', p: 0.55, picture: true, reason: 'The picture did not download; the text alone says nothing, so staying near 0.5.' },
    { id: 't10', at: '2026-10-12T07:55', sender: '33733', snippet: '739104 is your Amazon one-time password. Do not share it.', p: 0.03, otp: true, reason: 'Genuine one-time password, no link.' },
    { id: 't11', at: '2026-10-12T07:40', sender: '+1 (346) 555-0108', snippet: 'Remote position available: earn $300-$500/day reviewing products from home. Reply YES to get started', p: 0.91, reason: 'Unsolicited job offer with implausible pay.' },
    { id: 't12', at: '2026-10-12T07:22', sender: '+1 (650) 555-0176', snippet: 'Reminder: dental cleaning Tue Oct 14 at 3:30 PM. Reply C to confirm or R to reschedule.', p: 0.02, transactional: true, extract: { summary: 'Dental cleaning', date: '2026-10-14' }, reason: 'Appointment reminder for a future date.' },
    { id: 't13', at: '2026-10-12T06:48', sender: '+1 (909) 555-0124', snippet: 'Your wallet received 0.42 BTC. Claim before it expires: btc-claim-portal.net/r/88213', p: 0.99, reason: 'Crypto claim scam with a link.' },
    { id: 't14', at: '2026-10-12T06:30', sender: '21354', snippet: 'Charging session ended at 6:29 AM. 18.4 kWh delivered. Please move your vehicle.', p: 0.02, notification: true, reason: 'Charging-session notice; nothing to keep.' },
    { id: 't15', at: '2026-10-12T05:10', sender: '+1 (415) 555-0142', snippet: 'FasTrak: You have an unpaid toll balance of $6.95. Pay now to avoid a $50 late fee: fastrak-pay.top', p: 0.95, reason: 'Fake toll notice on a .top domain.' },
    { id: 't16', at: '2026-10-12T02:10', sender: '24273', snippet: 'Your verification code is 551208. We will never call you to ask for this code.', p: 0.04, otp: true, reason: 'Bank verification code, no link.' },
  ],

  // Arrives on the first simulated sweep.
  reserve: [
    { id: 't17', sender: '+1 (480) 555-0170', snippet: 'E-ZPass: Final notice. Your account has an outstanding balance of $4.15. Avoid suspension: ezpass-billing.help', p: 0.96, reason: 'Fake toll notice; E-ZPass does not bill by text link.' },
  ],

  history: [
    { at: '2026-10-11T21:12', sender: '+1 (917) 555-0104', cls: 'unsure', p: 0.63, mode: 'live', manual: true, action: 'keep', actionText: 'You kept it', done: true, reason: 'Short "call me back" from an unknown number; could be personal.', preview: 'Hey it\'s Jordan from Saturday, call me back when you can' },
    { at: '2026-10-11T21:08', system: true, mode: 'dry', text: 'Switched to dry run' },
    { at: '2026-10-11T21:07', system: true, mode: 'live', text: 'Live sweep finished · 9 threads · 4 blocked & reported · 2 archived · 1 held · 2 left alone' },
    { at: '2026-10-11T21:06', sender: '+1 (917) 555-0104', cls: 'unsure', p: 0.63, mode: 'live', action: 'hold', actionText: 'Held for review', done: true, tone: 'unsure', reason: 'Short "call me back" from an unknown number; could be personal.', preview: 'Hey it\'s Jordan from Saturday, call me back when you can' },
    { at: '2026-10-11T21:06', sender: '69877', cls: 'notice', p: 0.03, mode: 'live', action: 'archive', actionText: 'Labelled · archived', done: true, reason: 'Delivered notice, more than a day old.', preview: 'UPS: Your package was delivered at 2:14 PM. Left at front door.' },
    { at: '2026-10-11T21:06', sender: '+1 (408) 555-0111', cls: 'important', p: 0.05, mode: 'live', action: 'leave', actionText: 'Left alone', reason: 'A neighbour asking about a package; personal.', preview: 'Hi, it\'s Priya next door, I think your box got left at ours' },
    { at: '2026-10-11T21:05', sender: '+1 (612) 555-0181', cls: 'spam', p: 0.93, mode: 'live', action: 'block', actionText: 'Blocked & reported', done: true, tone: 'spam', reason: 'Debt-relief offer from an unknown number.', preview: 'Approved: you qualify to cut your credit card debt by 60%. Reply YES for a free call.' },
    { at: '2026-10-11T21:05', sender: '58123', cls: 'otp', p: 0.02, mode: 'live', action: 'archive', actionText: 'Labelled · archived', done: true, reason: 'Verification code older than 6 hours.', preview: 'Your Venmo code is 204815. Never share it.' },
    { at: '2026-10-11T21:05', sender: '+1 (702) 555-0133', cls: 'spam', p: 0.98, mode: 'live', action: 'block', actionText: 'Blocked & reported', done: true, tone: 'spam', reason: 'Casino bonus with a shortened link.', preview: 'You have $250 in free spins waiting! Claim now: bit.ly/3xSpinz' },
    { at: '2026-10-11T21:05', sender: '+1 (424) 555-0149', cls: 'spam', p: 0.95, mode: 'live', action: 'block', actionText: 'Blocked & reported', done: true, tone: 'spam', reason: 'Fake DMV suspension notice.', preview: 'DMV: Your license will be suspended on 10/13. Settle outstanding fees at dmv-ca-renew.info' },
    { at: '2026-10-11T21:05', sender: '+1 (562) 555-0116', cls: 'spam', p: 0.9, mode: 'live', action: 'block', actionText: 'Blocked & reported', done: true, tone: 'spam', reason: 'Gift-card survey bait.', preview: 'Congrats! You were selected for a $100 gift card survey. Start: surv-reward.co' },
    { at: '2026-10-11T21:05', sender: '27222', cls: 'important', p: 0.06, mode: 'live', action: 'leave', actionText: 'Left alone', reason: 'Utility outage alert; not marketing.', preview: 'PG&E: Power has been restored in your area. Thank you for your patience.' },
    { at: '2026-10-11T21:04', system: true, mode: 'live', text: 'Switched to live (--live sweep)' },
    { at: '2026-10-11T14:20', sender: '+1 (469) 555-0192', cls: 'spam', p: 0.89, mode: 'dry', action: 'block', actionText: 'Would block & report', reason: 'Wrong-number opener from a stranger.', preview: 'Hello, is this Mrs. Chen? I got your number from Linda about the dog walking' },
    { at: '2026-10-11T12:02', sender: '+1 (240) 555-0128', cls: 'important', p: 0.04, mode: 'dry', action: 'leave', actionText: 'Leave alone', reason: 'Contractor confirming a visit; personal and expected.', preview: 'Hi this is Marco, confirming 9am tomorrow for the faucet.' },
    { at: '2026-10-10T07:41', system: true, mode: 'dry', firstScan: true, text: 'First scan · marked 142 existing threads as seen (not classified)' },
    { at: '2026-10-10T07:40', system: true, mode: 'dry', text: 'Watcher started · mode full · dry run · top 20' },
    { at: '2026-09-28T18:40', system: true, mode: 'dry', text: 'Paired with phone (pair --headed)' },
  ],

  runnerEvents: [
    { at: '2026-10-12T09:28', text: 'Sweep · dry run · 20 threads checked · 1 new' },
    { at: '2026-10-12T09:10', text: 'Page reload (every 20 min) · session still paired' },
    { at: '2026-10-12T08:50', text: 'Page reload · session still paired' },
    { at: '2026-10-11T21:07', text: 'Live sweep finished · 9 threads' },
    { at: '2026-10-10T07:41', text: 'First scan · marked 142 existing threads as seen', first: true },
    { at: '2026-10-10T07:40', text: 'Watcher started (systemd user unit)' },
    { at: '2026-09-28T18:40', text: 'Paired with phone · QR approved' },
  ],

  lastLive: {
    at: '2026-10-11T21:05',
    checked: 9,
    rows: { spam: [4, 'blocked & reported'], otp: [1, 'archived'], notice: [1, 'archived'], important: [2, 'left alone'], unsure: [1, 'held'] },
  },

  samples: [
    { label: 'Toll scam', text: 'FasTrak: unpaid toll of $6.95. Pay today to avoid a $50 fee: fastrak-pay.top' },
    { label: 'Verification code', text: '482913 is your verification code. Don\'t share it with anyone.' },
    { label: 'Order ready', text: 'Your order is ready for pickup at the front counter.' },
    { label: 'Wrong number', text: 'Hi, is this Daniel? We met at the conference last month.' },
    { label: 'Appointment', text: 'Reminder: dental cleaning Tue Oct 14 at 3:30 PM. Reply C to confirm.' },
  ],
};
