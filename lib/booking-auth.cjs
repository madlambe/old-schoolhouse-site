// Shared Guesty Booking Engine authentication. Separate from the Open API calendar token.
const TOKEN_KEY = 'guesty:booking-engine:access-token:v1';
const LOCK_KEY = 'guesty:booking-engine:auth-lock:v1';
let pending = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function redis(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Booking authentication storage is not configured');
  const response = await fetch(url, {method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(command)});
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('Booking authentication storage unavailable');
  return data.result;
}
async function generateToken() {
  const body = new URLSearchParams({grant_type:'client_credentials',scope:'booking_engine:api',client_id:process.env.GUESTY_BE_CLIENT_ID,client_secret:process.env.GUESTY_BE_CLIENT_SECRET});
  const response = await fetch('https://booking.guesty.com/oauth2/token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body});
  if (response.status === 429) throw new Error('Booking service temporarily rate-limited; please try later');
  if (!response.ok) throw new Error(`Booking authentication unavailable (${response.status})`);
  const data = await response.json();
  if (!data.access_token) throw new Error('Booking authentication returned no token');
  const ttl = Math.max(60, Math.floor(Number(data.expires_in || 86400) - 600));
  await redis(['SET',TOKEN_KEY,data.access_token,'EX',String(ttl)]);
  return data.access_token;
}
async function getToken() {
  const existing = await redis(['GET',TOKEN_KEY]);
  if (existing) return existing;
  const lockValue = `${Date.now()}-${Math.random()}`;
  const acquired = await redis(['SET',LOCK_KEY,lockValue,'NX','PX','30000']);
  if (acquired === 'OK') {
    try {
      const doubleCheck = await redis(['GET',TOKEN_KEY]);
      return doubleCheck || await generateToken();
    } finally {
      // Delete only our own lock (atomic Lua check-and-delete).
      await redis(['EVAL',"if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",'1',LOCK_KEY,lockValue]).catch(()=>{});
    }
  }
  for (let i=0; i<24; i++) {
    await sleep(500);
    const token = await redis(['GET',TOKEN_KEY]);
    if (token) return token;
  }
  throw new Error('Booking authentication is temporarily busy; please retry shortly');
}
function getBookingToken() {
  if (!pending) pending = getToken().finally(()=>{pending=null;});
  return pending;
}
module.exports = {getBookingToken};
