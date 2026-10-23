
'use strict';
const { getBookingToken } = require('../lib/booking-auth.cjs');
const crypto = require('node:crypto');

const ORIGINS = new Set([
  'https://the-old-schoolhouse.webflow.io',
  'https://www.the-old-schoolhouse.com',
  'https://the-old-schoolhouse.com'
]);
const KEY_PREFIX = 'tosh:instant-charge:v1:';
const LOCK_SECONDS = 60 * 60 * 48;

function reply(res, status, body) {
  return res.status(status).json(body);
}
function redisReady() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
async function redis(command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error('Redis request failed');
  const data = await response.json();
  if (data.error) throw new Error('Redis command failed');
  return data.result;
}
async function claim(key) {
  return (await redis(['SET', key, 'processing', 'NX', 'EX', LOCK_SECONDS])) === 'OK';
}
async function mark(key, state) {
  await redis(['SET', key, state, 'EX', LOCK_SECONDS]);
}
async function release(key) {
  await redis(['DEL', key]);
}
function hasReservationEvidence(data) {
  const reservation = data?.reservation || data?.reservationDetails;
  return Boolean(
    reservation &&
    typeof reservation === 'object' &&
    (reservation._id || reservation.id || reservation.confirmationCode)
  );
}
function hasPaymentEvidence(data) {
  const payment = data?.payment;
  if (!payment || typeof payment !== 'object') return false;
  const attempts = Array.isArray(payment.attempts) ? payment.attempts : [];
  return attempts.some(attempt => {
    const status = String(attempt?.status || attempt?.payload?.payment_intent?.status || '').toLowerCase();
    return status === 'succeeded' || status === 'success';
  });
}
function needsAuthentication(data) {
  const attempts = Array.isArray(data?.payment?.attempts) ? data.payment.attempts : [];
  return attempts.some(attempt => {
    const status = String(attempt?.payload?.payment_intent?.status || '').toLowerCase();
    return status === 'requires_action';
  });
}
function safeReference(data) {
  const reservation = data?.reservation || data?.reservationDetails || {};
  return String(reservation.confirmationCode || reservation._id || reservation.id || '');
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return reply(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' });
  }

  // Fail closed until live checkout is explicitly approved.
  if (process.env.ENABLE_LIVE_INSTANT_CHARGE !== 'true') {
    return reply(res, 503, { success: false, error: 'LIVE_CHECKOUT_DISABLED' });
  }
  if (!redisReady()) {
    return reply(res, 503, { success: false, error: 'PAYMENT_PROTECTION_UNAVAILABLE' });
  }

  const body = req.body || {};
  const quoteId = typeof body.quoteId === 'string' ? body.quoteId.trim() : '';
  const ratePlanId = typeof body.ratePlanId === 'string' ? body.ratePlanId.trim() : '';
  const confirmationToken = typeof body.confirmationToken === 'string' ? body.confirmationToken.trim() : '';
  const guest = body.guest;
  const checkIn = body.checkIn;
  const checkOut = body.checkOut;

  if (
    !quoteId || !ratePlanId ||
    !confirmationToken.startsWith('ctoken_') ||
    !guest || typeof guest !== 'object' ||
    !guest.firstName || !guest.lastName || !guest.email ||
    !validDate(checkIn) || !validDate(checkOut) || checkOut <= checkIn
  ) {
    return reply(res, 400, { success: false, error: 'INVALID_BOOKING_REQUEST' });
  }

  const lockKey = KEY_PREFIX + hash(quoteId);
  let locked = false;
  let sentToGuesty = false;

  try {
    locked = await claim(lockKey);
    if (!locked) {
      return reply(res, 409, {
        success: false,
        error: 'BOOKING_ALREADY_PROCESSING',
        message: 'This booking is already being processed. Please contact us before trying again.'
      });
    }

    const token = await getBookingToken();
    if (!token) throw new Error('Guesty authentication unavailable');

    const payload = {
      quoteId,
      ratePlanId,
      guest: {
        firstName: String(guest.firstName).trim(),
        lastName: String(guest.lastName).trim(),
        email: String(guest.email).trim(),
        phone: String(guest.phone || '').trim(),
        address: guest.address || undefined
      },
      payment: {
        method: 'STRIPE',
        confirmationToken,
        reuse: true
      }
    };

    sentToGuesty = true;
    const response = await fetch(
      `https://booking.guesty.com/api/reservations/quotes/${encodeURIComponent(quoteId)}/instant-charge`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000)
      }
    );

    const data = await response.json().catch(() => null);

    if (needsAuthentication(data)) {
      await mark(lockKey, 'authentication_required_manual_review');
      return reply(res, 202, {
        success: false,
        error: 'AUTHENTICATION_REQUIRED',
        message: 'Your bank requires additional authentication. Please contact us before trying again.'
      });
    }

    if (!response.ok) {
      // An unsuccessful HTTP response does not prove that no payment was taken.
      await mark(lockKey, 'guest_response_uncertain');
      return reply(res, 502, {
        success: false,
        error: 'PAYMENT_STATUS_UNCERTAIN',
        message: 'We could not verify the result. Please contact us before trying again.'
      });
    }

    if (!hasReservationEvidence(data) || !hasPaymentEvidence(data)) {
      await mark(lockKey, 'verification_required');
      return reply(res, 202, {
        success: false,
        error: 'PAYMENT_VERIFICATION_REQUIRED',
        message: 'We are verifying your booking. Please contact us before trying again.'
      });
    }

    await mark(lockKey, 'confirmed');
    return reply(res, 200, {
      success: true,
      paymentVerified: true,
      reservationVerified: true,
      reference: safeReference(data),
      checkIn,
      checkOut
    });

  } catch (error) {
    console.error('Instant-charge processing failed:', {
      message: error?.message || 'Unknown error',
      sentToGuesty
    });

    if (locked && !sentToGuesty) {
      try { await release(lockKey); } catch (_) {}
    } else if (locked) {
      try { await mark(lockKey, 'outcome_uncertain'); } catch (_) {}
    }

    return reply(res, 503, {
      success: false,
      error: sentToGuesty ? 'PAYMENT_STATUS_UNCERTAIN' : 'PAYMENT_SERVICE_UNAVAILABLE',
      message: sentToGuesty
        ? 'We could not verify the result. Please contact us before trying again.'
        : 'The payment service is temporarily unavailable. Please try again later.'
    });
  }
};
