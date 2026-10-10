// The policy engine: what happens to a thread with a given verdict. Plain
// script, no chrome.* and no module syntax, so the same file runs in the
// Messages page (before content.js) and in Node (`policy show|test`).
//
// A policy is { name, match, action, ... }. Rules are tried in order; the
// first whose match fits the verdict decides. match: { label: [...],
// minScore (a number, or "threshold" for settings.threshold), byModel }.
// action: "block_report" | "trash" | "archive_after" (+ hours) | "keep" |
// "hold" (label it for review; `messages-control review` lists them).
// modes: which settings.mode values enable the rule (default: all).
(() => {
  const DEFAULT_POLICIES = [
    // Spam goes by settings.spamAction unless a config rule says otherwise.
    { name: 'spam-block', match: { label: ['spam'], minScore: 'threshold' }, action: 'spamAction', modes: ['spam', 'full'] },
    // Spam-ish but under the threshold: hold it for a person to look at.
    { name: 'spam-review', match: { label: ['spam'], minScore: 0.5 }, action: 'hold', modes: ['full'] },
    // Marketing is not spam: deleted, never reported.
    { name: 'marketing-delete', match: { label: ['marketing'] }, action: 'trash', modes: ['spam', 'full'] },
    // One-time codes stop mattering after a few hours, notices after a day.
    // Archiving keeps the history and Messages brings the thread back on a
    // new message, so dry run doesn't apply. Only the model's own code label
    // counts: the regex backstop can match a person's "gate code is 4821".
    { name: 'otp-archive', match: { label: ['otp'], byModel: true }, action: 'archive_after', hours: 6, modes: ['full'] },
    { name: 'notice-archive', match: { label: ['notice'] }, action: 'archive_after', hours: 24, modes: ['full'] },
  ];

  const pct = (x) => `${Math.round(x * 100)}%`;
  const KIND = { otp: 'one-time code', notice: 'notification' };

  // Minimum possible age in hours of the thread's latest message. Before
  // today the list shows only a day ("Yesterday", "Monday", "Sep 29"), so
  // assume the message came at the very end of that day: never archive early.
  function minAgeHours(t, now = Date.now()) {
    if (t.msgTime == null) return null;
    // End of that calendar day (not +24 h, which is off on DST-change days).
    const d = new Date(t.msgTime);
    const end = t.recent ? t.msgTime : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    return Math.max(0, (now - end) / 3600000);
  }
  const fmtHours = (h) => (h < 48 ? `${Math.floor(h)} hours old` : `${Math.floor(h / 24)} days old`);

  // The rules in force for these settings: the config's own list or the
  // defaults, minus rules the mode or archiveOldNotices turn off.
  function rules(settings) {
    const list = Array.isArray(settings.policies) && settings.policies.length ? settings.policies : DEFAULT_POLICIES;
    return list.filter((r) => {
      if (r.enabled === false) return false;
      if (r.modes && settings.mode && !r.modes.includes(settings.mode)) return false;
      if (r.action === 'archive_after' && settings.archiveOldNotices === false) return false;
      return true;
    });
  }

  function matches(rule, v, settings) {
    const m = rule.match ?? {};
    if (m.label && !m.label.includes(v.label)) return false;
    if (m.byModel === true && v.byModel !== true) return false;
    const min = m.minScore === 'threshold' ? settings.threshold : m.minScore;
    if (typeof min === 'number' && !((v.score ?? 0) >= min)) return 'score';
    return true;
  }

  function actionOf(rule, settings) {
    if (rule.action === 'spamAction') return settings.spamAction === 'trash' ? 'trash' : 'block_report';
    return rule.action;
  }

  // Pure: the caller performs the action when this says so. Returns
  // { rule, action, outcome, del, trash, archive }.
  function decide(v, { isNew, settings, thread, now = Date.now() }) {
    let belowScore = null;
    for (const rule of rules(settings)) {
      const fit = matches(rule, v, settings);
      if (fit === 'score') {
        belowScore ??= rule;
        continue;
      }
      if (!fit) continue;
      const action = actionOf(rule, settings);
      const base = { rule: rule.name, action };
      if (action === 'keep') return { ...base, outcome: 'kept' };
      if (action === 'hold') return { ...base, outcome: 'held for review', hold: true };
      if (action === 'archive_after') {
        const kind = KIND[v.label] ?? v.label;
        const age = minAgeHours(thread, now);
        if (age == null) return { ...base, outcome: `kept: ${kind}, age unknown` };
        if (age < rule.hours) return { ...base, outcome: `kept: ${kind}, under ${rule.hours === 24 ? 'a day' : `${rule.hours} hours`} old` };
        return { ...base, outcome: `archiving (${kind}, at least ${fmtHours(age)})`, archive: true };
      }
      if (!isNew) return { ...base, outcome: 'not deleted: existing thread' };
      if (settings.dryRun) return { ...base, outcome: 'not deleted: dry run' };
      return { ...base, outcome: 'deleting…', del: true, trash: action === 'trash' };
    }
    if (belowScore) {
      const min = belowScore.match.minScore === 'threshold' ? settings.threshold : belowScore.match.minScore;
      return { rule: null, outcome: `kept: below ${pct(min)} threshold` };
    }
    if (v.label === 'otp' || v.label === 'notice') return { rule: null, outcome: `kept: ${KIND[v.label]}` };
    return { rule: null, outcome: 'kept' };
  }

  globalThis.MessagesPolicy = { DEFAULT_POLICIES, rules, decide, minAgeHours };
})();
