// Backstop for the model: a code-ish word near a 4-8 digit number.
export const OTP_RE = /\b(code|passcode|otp|one[- ]time|verification|verify|2fa|login|sign[- ]in)\b[\s\S]{0,60}\b\d{4,8}\b|\b\d{4,8}\b[\s\S]{0,60}\b(code|passcode|otp|verification)\b/i;

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
