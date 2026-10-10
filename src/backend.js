// What background.js does for the extension: answer the page's messages
// (settings, classify, log). Pictures the page couldn't read are fetched with
// the browser's cookies and downscaled inside the page.
const LOG_LIMIT = 300;
const FAILURE_LIMIT = 5;
// Backstop for the model: a code-ish word near a 4-8 digit number.
const OTP_RE = /\b(code|passcode|otp|one[- ]time|verification|verify|2fa|login|sign[- ]in)\b[\s\S]{0,60}\b\d{4,8}\b|\b\d{4,8}\b[\s\S]{0,60}\b(code|passcode|otp|verification)\b/i;

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

// The page hands over picture URLs; only Google's own picture hosts (what the
// extension's host_permissions allow) are fetched with the browser's cookies.
function isPictureHost(src) {
  try {
    const { protocol, hostname } = new URL(src);
    return protocol === 'https:' && (hostname.endsWith('.googleusercontent.com') || hostname === 'messages.google.com');
  } catch {
    return false;
  }
}

const EXTRACT_KEYS = ['summary', 'date', 'amount', 'code'];
function extractOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of EXTRACT_KEYS) if (raw[k] != null && String(raw[k]).trim()) out[k] = String(raw[k]).trim().slice(0, 120);
  return Object.keys(out).length ? out : null;
}

export class Backend {
  constructor({ store, settings, context = null, page = null, onLog = () => {}, onFatal = () => {} }) {
    this.store = store;
    this.settings = settings;
    this.context = context;
    this.page = page;
    this.onLog = onLog;
    // Consecutive classify failures; a run of them means the endpoint is
    // down, not one bad message.
    this.onFatal = onFatal;
    this.failures = 0;
    // For /metrics: classifier calls since the process started.
    this.stats = { calls: 0, failures: 0, ms: 0 };
    // Log writes are read-modify-write, so run them one at a time.
    this.logQueue = Promise.resolve();
  }

  async handle(msg) {
    try {
      switch (msg.type) {
        case 'getSettings':
          return { ok: true, settings: this.settings };
        case 'classify': {
          let verdict;
          const t0 = Date.now();
          this.stats.calls++;
          try {
            verdict = await this.classify(msg.thread);
          } catch (err) {
            this.stats.failures++;
            if (++this.failures >= FAILURE_LIMIT) this.onFatal(`LLM endpoint failing: ${err.message}`);
            throw err;
          } finally {
            this.stats.ms += Date.now() - t0;
          }
          this.failures = 0;
          return { ok: true, verdict };
        }
        case 'log':
          await this.appendLog(msg.entry);
          return { ok: true };
        case 'clearLog':
          await this.withLog(() => {
            this.store.set({ log: [] });
            this.store.remove('lastScan');
          });
          return { ok: true };
        default:
          return { ok: false, error: `unknown message ${msg.type}` };
      }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  withLog(fn) {
    const run = this.logQueue.then(fn);
    this.logQueue = run.catch(() => {});
    return run;
  }

  appendLog(entry) {
    return this.withLog(() => {
      const { log = [] } = this.store.get('log');
      log.unshift({ time: Date.now(), ...entry });
      this.store.set({ log: log.slice(0, LOG_LIMIT) });
      this.onLog(entry);
    });
  }

  // Pictures arrive as data URLs, or as plain URLs when the page wouldn't let
  // the script read the pixels; fetch those with the browser's cookies (no
  // CORS outside the page) and downscale them in the page's canvas.
  async toDataUrl(src) {
    if (!src || src.startsWith('data:')) return src || null;
    if (!this.context || !this.page || !isPictureHost(src)) return null;
    try {
      const res = await this.context.request.get(src, { timeout: 15000 });
      if (!res.ok()) return null;
      const b64 = (await res.body()).toString('base64');
      const type = res.headers()['content-type'] ?? 'image/jpeg';
      return await this.page.evaluate(
        async ([b64, type]) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type }));
          const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(bitmap.width * scale);
          canvas.height = Math.round(bitmap.height * scale);
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', 0.8);
        },
        [b64, type],
      );
    } catch (err) {
      console.warn('picture fetch failed', src, err.message);
      return null;
    }
  }

  async classify(thread) {
    const s = this.settings;
    if (!s.apiKey) throw new Error('No API key: set LITELLM_API_KEY or "apiKey" in the config file.');
    const body = thread.texts?.length ? thread.texts.join('\n---\n') : thread.text;
    const media = thread.media
      ? thread.images?.length
        ? `\n[${thread.images.length} picture(s) attached below]`
        : '\n[picture message; the picture could not be retrieved]'
      : '';
    const text = `From: ${thread.name}\n${body}${media}`.slice(0, 4000);
    const images = (await Promise.all((thread.images ?? []).map((src) => this.toDataUrl(src)))).filter(Boolean);
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
    const verdict = JSON.parse(json);
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
      spam: rawSpam && score >= s.threshold,
      rawSpam,
      score,
      reason: String(verdict.reason ?? ''),
      pictures: images.length,
    };
  }
}
