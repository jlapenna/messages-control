// Backstop for the model: a code-ish word near a 4-8 digit number.
export const OTP_RE = /\b(code|passcode|otp|one[- ]time|verification|verify|2fa|login|sign[- ]in)\b[\s\S]{0,60}\b\d{4,8}\b|\b\d{4,8}\b[\s\S]{0,60}\b(code|passcode|otp|verification)\b/i;

const EXTRACT_KEYS = ['summary', 'date', 'amount', 'code'];
function extractOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of EXTRACT_KEYS) if (raw[k] != null && String(raw[k]).trim()) out[k] = String(raw[k]).trim().slice(0, 120);
  return Object.keys(out).length ? out : null;
}

export function parseVerdict(verdict, { text, threshold, pictures = 0 }) {
  // Custom prompts from before spam_probability may still answer with
  // {spam, confidence}.
  const score = Math.min(1, Math.max(0, Number(
    verdict.spam_probability ??
      (verdict.spam === true ? verdict.confidence ?? 1 : 1 - (verdict.confidence ?? 1)),
  ) || 0));
  const rawSpam = score >= 0.5;
  return {
    // Spam wins: sender-written text can always look like a code ("verify
    // your account, code 123456: http://..."), so OTP never overrides it.
    otp: !rawSpam && (verdict.otp === true || OTP_RE.test(text)),
    // The regex is only a labelling backstop; cleanup acts on the model's own
    // flag, since a person's "gate code is 4821" can match the regex.
    otpByModel: !rawSpam && verdict.otp === true,
    marketing: !rawSpam && verdict.marketing === true,
    notification: !rawSpam && verdict.notification === true,
    transactional: !rawSpam && verdict.transactional === true,
    // What the message is about, for the digest: only known keys, short.
    extract: extractOf(verdict.extract),
    spam: rawSpam && score >= threshold,
    rawSpam,
    score,
    reason: String(verdict.reason ?? ''),
    pictures,
  };
}

// One quick retry on network-level failures, which the gateway occasionally
// produces; HTTP errors are returned as-is.
async function fetchWithRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return fetch(url, init);
  }
}

export function classificationText(thread) {
  const body = thread.texts?.length ? thread.texts.join('\n---\n') : thread.text;
  const media = thread.media
    ? thread.images?.length
      ? `\n[${thread.images.length} picture(s) attached below]`
      : '\n[picture message; the picture could not be retrieved]'
    : '';
  return `From: ${thread.name}\n${body}${media}`.slice(0, 4000);
}

export async function requestVerdict(s, text, images) {
  const userContent = images.length
    ? [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : text;
  const res = await fetchWithRetry(s.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model: s.model,
      temperature: 0,
      // The default model reasons before answering; a tight cap can leave no
      // room for the JSON on harder messages.
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: s.prompt },
        { role: 'user', content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  if (!content && choice?.finish_reason === 'length') throw new Error('LLM ran out of tokens before answering');
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`Unparseable LLM reply: ${content.slice(0, 200)}`);
  return JSON.parse(json);
}
