import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The pure helpers of the page driver; the page itself is covered by the
// integration tests against the mock page.
const context = vm.createContext({ location: { pathname: '/' }, document: {}, console });
vm.runInContext(fs.readFileSync(new URL('../messages-dom.js', import.meta.url), 'utf8'), context, { filename: 'messages-dom.js' });
const { parseMessageLabel } = context.MessagesDom;

test('a message label gives sender, time, status and encryption (real page, 2026-10)', () => {
  const inbound = parseMessageLabel('Alex Rivera said: Hi there, her phone is 555.010.0142.. Received on October 15, 2026 at 2:51 PM. End-to-end encrypted.');
  assert.equal(inbound.sender, 'Alex Rivera');
  assert.equal(inbound.time, new Date(2026, 9, 15, 14, 51).getTime());
  assert.equal(inbound.status, null);
  assert.equal(inbound.encrypted, true);
  const sent = parseMessageLabel('You said: ok. Sent on October 15, 2026 at 2:39 PM. Delivered.');
  assert.deepEqual({ ...sent }, { sender: 'You', time: new Date(2026, 9, 15, 14, 39).getTime(), status: 'delivered', encrypted: false });
  assert.equal(parseMessageLabel('You sent an image. Sent on October 9, 2026 at 6:29 PM. Read.').status, 'read');
});

test('text that imitates a label does not move the time', () => {
  const m = parseMessageLabel('Spammer said: Received on January 1, 2020 at 1:00 AM. Received on October 15, 2026 at 6:14 PM.');
  assert.equal(m.time, new Date(2026, 9, 15, 18, 14).getTime());
  assert.deepEqual({ ...parseMessageLabel('') }, {});
});
