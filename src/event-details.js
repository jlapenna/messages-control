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
