// Minimal fetch wrapper: sliding-window rate limiting, retry with backoff, 429 handling.

export function createLimiter({ maxRequests, windowMs, minGapMs = 0 }) {
  const stamps = [];
  let last = 0;
  return async function acquire() {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] > windowMs) stamps.shift();
      const gapWait = minGapMs ? Math.max(0, last + minGapMs - now) : 0;
      if (stamps.length < maxRequests && gapWait === 0) {
        stamps.push(now);
        last = now;
        return;
      }
      const windowWait = stamps.length >= maxRequests ? stamps[0] + windowMs - now + 5 : 0;
      await sleep(Math.max(gapWait, windowWait, 10));
    }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * Fetch a URL and parse JSON. Retries on 429/5xx/network errors.
 * Returns null for 404 when `allow404` is set.
 */
export async function fetchJson(url, { headers = {}, limiter, retries = 4, allow404 = false, label = '', timeoutMs = 30000, retryAfterCapMs = 5 * 60 * 1000 } = {}) {
  let attempt = 0;
  for (;;) {
    if (limiter) await limiter();
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt++ >= retries) throw err;
      await sleep(backoff(attempt));
      continue;
    }
    if (res.status === 404 && allow404) return null;
    if (res.ok) {
      const text = await res.text();
      try { return JSON.parse(text); } catch { throw new HttpError(res.status, url, text.slice(0, 200)); }
    }
    const body = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      attempt++;
      const ra = Number(res.headers.get('retry-after'));
      const wait = res.status === 429 ? Math.min(retryAfterCapMs, ra > 0 ? ra * 1000 : 60000 * attempt) : backoff(attempt);
      console.warn(`[http] ${label || url} -> ${res.status}; waiting ${Math.round(wait / 1000)}s (attempt ${attempt}/${retries})`);
      await sleep(wait);
      continue;
    }
    throw new HttpError(res.status, url, body.slice(0, 300));
  }
}

function backoff(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
}
