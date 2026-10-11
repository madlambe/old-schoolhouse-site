
const { getBookingToken } = require('../lib/booking-auth.cjs');

const LISTING_ID = '6a9971cb2e53cb00111b27da';

const ALLOWED_ORIGINS = [
  'https://the-old-schoolhouse.webflow.io',
  'https://www.the-old-schoolhouse.com',
  'https://the-old-schoolhouse.com'
];

function isDate(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(value + 'T00:00:00Z');

  return !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  const { checkIn, checkOut, total } = req.query || {};
  const amount = Number(total);

  if (
    !isDate(checkIn) ||
    !isDate(checkOut) ||
    checkOut <= checkIn ||
    typeof total !== 'string' ||
    !/^\d+(?:\.\d{1,2})?$/.test(total) ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1000000
  ) {
    return res.status(400).json({
      success: false,
      error: 'Invalid dates or total amount.'
    });
  }

  const requestParameters = {
    listingId: LISTING_ID,
    checkIn,
    checkOut,
    total: amount.toFixed(2),
    bookingType: 'INSTANT'
  };

  try {
    const token = await getBookingToken();

    const params = new URLSearchParams(requestParameters);

    const upstream = await fetch(
      'https://booking.guesty.com/api/reservations/payouts/list?' +
      params.toString(),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json; charset=utf-8',
          Authorization: 'Bearer ' + token
        }
      }
    );

    const raw = await upstream.text();

    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      result = {
        message: 'Guesty returned a non-JSON response.'
      };
    }

    const requestId =
      upstream.headers.get('x-request-id') ||
      null;

    return res.status(upstream.ok ? 200 : 502).json({
      success: upstream.ok,
      guestyHttpStatus: upstream.status,
      guestyRequestId: requestId,
      request: {
        method: 'GET',
        endpoint: '/api/reservations/payouts/list',
        parameters: requestParameters
      },
      response: result
    });

  } catch (error) {
    console.error('Payment schedule diagnostic error:', error);

    return res.status(500).json({
      success: false,
      error: 'Payment schedule unavailable.'
    });
  }
};
