// Recover historical previews from the original log, never the mutable
// verdict cache. Old undo records have no snapshot or exact source ID; show
// a clearly identified earlier action as context, rather than claim it was
// necessarily the action reversed.
export function eventDetails(db, store, event) {
  const { log = [] } = store.get('log');
  const originalText = (e) => {
    if (e.text != null) return e.text;
    const matches = log.filter((entry) => entry.threadId === e.thread_id &&
      (entry.name ?? null) === e.name && (entry.label ?? null) === e.label &&
      (entry.rule ?? null) === e.rule && (entry.outcome ?? null) === e.outcome &&
      Math.abs((entry.time ?? 0) - e.time) <= 1000);
    return matches.length === 1 && matches[0].text != null ? String(matches[0].text).slice(0, 500) : null;
  };
  const text = originalText(event);
  if (text != null || (event.rule !== 'undo' && event.label !== 'undo')) return { ...event, text };
  const kind = event.outcome === 'unarchived' ? 'archived' :
    /^(unblocked|marked not spam)$/.test(event.outcome ?? '') ? 'blocked' : null;
  const earlier = db.previousAction(event, kind);
  const context = earlier && originalText(earlier);
  if (context == null) return { ...event, text: null };
  return { ...event, text: context, previewSource: { id: earlier.id, time: earlier.time, outcome: earlier.outcome } };
}

// Threads the rules hold for a person: cached verdicts whose decision is
// "hold" and that nobody has acted on since, with the sender name from events.
export function heldForReview(db, store, policy, settings) {
  const { verdicts = {} } = store.get('verdicts');
  const names = db.threadNames();
  const decided = db.decided();
  const live = { ...settings, dryRun: false };
  return Object.entries(verdicts)
    .filter(([id, v]) => !(decided.get(id) >= (v.time ?? 0)))
    .map(([id, v]) => ({ id, name: names.get(id) ?? null, ...v, decision: policy.decide(v, { isNew: true, settings: live, thread: { msgTime: v.msgTime, recent: false } }) }))
    .filter((x) => x.decision.hold)
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .map(({ text, ...rest }) => rest); // message text stays local
}

// Resolve a recorded event id to the page's undo payload, or classify why it
// cannot be undone.
export function undoTarget(db, store, eventId) {
  const event = db.event(Number(eventId));
  if (!event) return { error: 'not_found' };
  const kind = /^blocked/.test(event.outcome ?? '') ? 'blocked' : /^archived/.test(event.outcome ?? '') ? 'archived' : null;
  if (!kind) return { error: 'not_undoable', event };
  if (!event.name) return { error: 'no_name', event };
  return { ok: true, msg: { type: 'undo', kind, name: event.name, threadId: event.thread_id, text: eventDetails(db, store, event).text } };
}
