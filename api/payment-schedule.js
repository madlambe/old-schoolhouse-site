
// Read-only Guesty Booking Engine payment-schedule diagnostic.
// Add this file as api/payment-schedule.js in the existing Vercel project.
// It does not charge a card or create a reservation.
const { getBookingToken } = require('../lib/booking-auth.cjs');

const LISTING_ID = '6a9971cb2e53cb00111b27da';
const ALLOWED_ORIGINS = [
  'https://the-old-schoolhouse.webflow.io',
  'https://www.the-old-schoolhouse.com',
  'https://the-old-schoolhouse.com',
];

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { checkIn, checkOut, total } = req.query || {};
  const amount = Number(total);
  if (!isDate(checkIn) || !isDate(checkOut) || checkOut <= checkIn ||
      typeof total !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(total) ||
      !Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res.status(400).json({
      success: false,
      error: 'Provide checkIn and checkOut as YYYY-MM-DD and total as a positive GBP amount, e.g. 2910.00.'
    });
  }

  try {
    const token = await getBookingToken();
    const params = new URLSearchParams({
      listingId: LISTING_ID,
      checkIn,
      checkOut,
      total: amount.toFixed(2),
      bookingType: 'INSTANT',
    });
    const upstream = await fetch(`https://booking.guesty.com/api/reservations/payouts/list?${params}`, {
      headers: { Accept: 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    });
    const raw = await upstream.text();
    let result;
    try { result = JSON.parse(raw); } catch { result = { message: 'Unexpected non-JSON response' }; }
    if (!upstream.ok) {
      console.error('Guesty payment schedule failed', upstream.status, result);
      return res.status(502).json({ success: false, guestyHttpStatus: upstream.status, error: 'Guesty could not retrieve the payment schedule.' });
    }
    return res.status(200).json({ success: true, checkIn, checkOut, total: amount, bookingType: 'INSTANT', schedule: result });
  } catch (error) {
    console.error('Payment schedule diagnostic error', error);
    return res.status(500).json({ success: false, error: 'Payment schedule unavailable.' });
  }
};
