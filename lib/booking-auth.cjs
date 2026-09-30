// Shared Booking Engine authentication; separate from the Open API calendar token.
const TOKEN_KEY = 'guesty:booking-engine:access-token:v1';
const LOCK_KEY = 'guesty:booking-engine:auth-lock:v1';
const COOLDOWN_KEY = 'guesty:booking-engine:auth-cooldown:v1';
const DEFAULT_COOLDOWN_SECONDS = 24 * 60 * 60; // Conservative fallback for daily token limits.
let pending = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function redis(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Booking authentication storage is not configured');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('Booking authentication storage unavailable');
  return data.result;
}

function cooldownSeconds(response) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(86400, Math.max(60, Math.ceil(seconds)));
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) return Math.min(86400, Math.max(60, Math.ceil((retryDate - Date.now()) / 1000)));
  }
  // No server-provided reset time: avoid further auth requests for a full day.
  return DEFAULT_COOLDOWN_SECONDS;
}

async function checkCooldown() {
  if (await redis(['GET', COOLDOWN_KEY])) {
    throw new Error('Booking authentication is cooling down after a rate limit; no new token requested');
  }
}

async function generateToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials', scope: 'booking_engine:api',
    client_id: process.env.GUESTY_BE_CLIENT_ID,
    client_secret: process.env.GUESTY_BE_CLIENT_SECRET
  });
  const response = await fetch('https://booking.guesty.com/oauth2/token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  if (response.status === 429) {
    await redis(['SET', COOLDOWN_KEY, 'rate-limited', 'EX', String(cooldownSeconds(response))]);
    throw new Error('Booking authentication rate-limited; shared cooldown activated');
  }
  if (!response.ok) throw new Error(`Booking authentication unavailable (${response.status})`);
  const data = await response.json();
  if (!data.access_token) throw new Error('Booking authentication returned no token');
  const ttl = Math.max(60, Math.floor(Number(data.expires_in || 86400) - 600));
  await redis(['SET', TOKEN_KEY, data.access_token, 'EX', String(ttl)]);
  await redis(['DEL', COOLDOWN_KEY]);
  return data.access_token;
}

async function getToken() {
  // Reuse a valid token even if a previous failed attempt set a cooldown.
  const existing = await redis(['GET', TOKEN_KEY]);
  if (existing) return existing;
  await checkCooldown();
  const lockValue = `${Date.now()}-${Math.random()}`;
  const acquired = await redis(['SET', LOCK_KEY, lockValue, 'NX', 'PX', '30000']);
  if (acquired === 'OK') {
    try {
      const doubleCheck = await redis(['GET', TOKEN_KEY]);
      if (doubleCheck) return doubleCheck;
      await checkCooldown();
      return await generateToken();
    } finally {
      await redis(['EVAL', "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", '1', LOCK_KEY, lockValue]).catch(() => {});
    }
  }
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const token = await redis(['GET', TOKEN_KEY]);
    if (token) return token;
    await checkCooldown();
  }
  throw new Error('Booking authentication is temporarily busy; please retry shortly');
}

function getBookingToken() {
  if (!pending) pending = getToken().finally(() => { pending = null; });
  return pending;
}
module.exports = { getBookingToken };
