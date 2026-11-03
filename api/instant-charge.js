
'use strict';

const { getBookingToken } = require('../lib/booking-auth.cjs');
const crypto = require('node:crypto');

const ORIGINS = new Set([
  'https://the-old-schoolhouse.webflow.io',
  'https://www.the-old-schoolhouse.com',
  'https://the-old-schoolhouse.com'
]);

const PREFIX = 'tosh:instant-charge:v1:';
const TTL = 172800;

const str = (v, n = 200) =>
  typeof v === 'string' ? v.trim().slice(0, n) : '';

const hash = v =>
  crypto.createHash('sha256').update(v).digest('hex');

async function redis(command) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw Error('Redis unavailable');

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });

  if (!r.ok) throw Error('Redis HTTP failure');
  const j = await r.json();
  if (j.error) throw Error('Redis command failure');
  return j.result;
}

function analyze(data) {
  const reservation = data?.reservation || data?.reservationDetails || {};
  const attempts = Array.isArray(data?.payment?.attempts)
    ? data.payment.attempts : [];

  const statuses = attempts.map(a => String(
    a?.payload?.payment_intent?.status || a?.status || ''
  ).toLowerCase());

  const paymentStatus = String(data?.payment?.status || '').toLowerCase();
  const reservationStatus = String(reservation?.status || '').toLowerCase();
  const reference = str(
    reservation?.confirmationCode || reservation?.confirmation_code ||
    reservation?._id || reservation?.id, 100
  );

  const requiresAction =
    statuses.includes('requires_action') ||
    ['requires_action', 'requires_authentication', 'pending_auth']
      .includes(paymentStatus);

  const paid =
    statuses.some(s =>
      ['succeeded', 'success', 'captured', 'paid', 'completed'].includes(s)
    ) ||
    ['succeeded', 'success', 'captured', 'paid', 'completed']
      .includes(paymentStatus);

  const notConfirmed =
    ['cancelled', 'canceled', 'declined', 'failed', 'rejected', 'pending', 'inquiry']
      .includes(reservationStatus);

  return {
    reference,
    reservationExists: Boolean(reference),
    requiresAction,
    paid,
    notConfirmed,
    reservationStatus,
    paymentStatus,
    attemptStatuses: statuses
  };
}

// Log only field names and known, non-sensitive status/type values.
// Never log the full Guesty response, client secrets, URLs or tokens.
function diagnosticShape(data) {
  const safeKeys = value =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).slice(0, 30)
      : [];

  const attempts = Array.isArray(data?.payment?.attempts)
    ? data.payment.attempts.slice(0, 5) : [];

  const challenge = data?.threeDSChallenge;
  const paymentChallenge = data?.payment?.threeDSChallenge;

  const shape = value => ({
    present: value !== undefined && value !== null,
    type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    keys: safeKeys(value)
  });

  return {
    topLevelKeys: safeKeys(data),
    paymentKeys: safeKeys(data?.payment),
    threeDSChallenge: shape(challenge),
    paymentThreeDSChallenge: shape(paymentChallenge),
    attempts: attempts.map(a => ({
      keys: safeKeys(a),
      payloadKeys: safeKeys(a?.payload),
      paymentIntentKeys: safeKeys(a?.payload?.payment_intent),
      nextActionType: str(a?.payload?.payment_intent?.next_action?.type, 60) || null,
      nextActionKeys: safeKeys(a?.payload?.payment_intent?.next_action)
    }))
  };
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;

  if (ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED' });
  }

  if (process.env.ENABLE_LIVE_INSTANT_CHARGE !== 'true') {
    return res.status(503).json({
      success: false, errorCode: 'LIVE_CHECKOUT_DISABLED'
    });
  }

  if (!ORIGINS.has(origin)) {
    return res.status(403).json({ success: false, errorCode: 'ORIGIN_NOT_ALLOWED' });
  }

  const b = req.body || {};
  const quoteId = str(b.quoteId, 100);
  const ratePlanId = str(b.ratePlanId, 100);
  const confirmationToken = str(b.confirmationToken, 250);
  const guest = b.guest || {};

  const firstName = str(guest.firstName, 100);
  const lastName = str(guest.lastName, 100);
  const email = str(guest.email, 254);
  const phone = str(guest.phone, 50);

  if (
    !quoteId || !ratePlanId ||
    !/^ctoken_[A-Za-z0-9_]+$/.test(confirmationToken) ||
    !firstName || !lastName ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({
      success: false, errorCode: 'INVALID_BOOKING_REQUEST'
    });
  }

  const key = PREFIX + hash(quoteId);
  const attemptId = crypto.randomBytes(12).toString('hex');

  const record = async (state, details = {}) => {
    try {
      await redis([
        'SET', key,
        JSON.stringify({ state, attemptId, ...details }),
        'EX', TTL
      ]);
    } catch (e) {
      console.error('Redis update failed', {
        attemptId, message: e.message
      });
    }
  };

  try {
    const locked = await redis([
      'SET', key,
      JSON.stringify({ state: 'processing', attemptId }),
      'NX', 'EX', TTL
    ]);

    if (locked !== 'OK') {
      return res.status(409).json({
        success: false,
        errorCode: 'BOOKING_ATTEMPT_ALREADY_EXISTS',
        doNotRetry: true
      });
    }
  } catch {
    return res.status(503).json({
      success: false,
      errorCode: 'PAYMENT_PROTECTION_UNAVAILABLE',
      doNotRetry: true
    });
  }

  let sent = false;

  try {
    const token = await getBookingToken();
    if (!token) throw Error('Guesty token unavailable');

    const payload = {
      ratePlanId,
      confirmationToken,
      reuse: true,
      guest: {
        firstName, lastName, email, phone,
        ...(guest.address ? { address: guest.address } : {})
      }
    };

    sent = true;
    const r = await fetch(
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

    const data = await r.json().catch(() => null);
    const out = analyze(data);

    const detail = {
      httpStatus: r.status,
      requestId: r.headers.get('x-request-id') || null,
      reference: out.reference,
      reservationStatus: out.reservationStatus,
      paymentStatus: out.paymentStatus,
      attemptStatuses: out.attemptStatuses
    };

    console.log('Guesty instant-charge result', { attemptId, ...detail });

    // Only log response structure on 3DS or unsuccessful/unverified outcomes.
    // No guest details, card data, tokens, URLs or client secrets are logged.
    if (!r.ok || out.requiresAction || !out.paid || !out.reservationExists) {
      console.log('Guesty 3DS diagnostic shape', {
        attemptId,
        ...diagnosticShape(data)
      });
    }

    if (!r.ok) {
      console.error('Guesty API rejection', {
        attemptId,
        httpStatus: r.status,
        requestId: detail.requestId,
        errorKeys: data?.errors && typeof data.errors === 'object'
          ? Object.keys(data.errors).slice(0, 15) : []
      });
      await record('needs_reconciliation', detail);
      return res.status(502).json({
        success: false,
        errorCode: 'BOOKING_STATUS_UNKNOWN',
        doNotRetry: true,
        requiresVerification: true,
        attemptId
      });
    }

    if (out.requiresAction) {
      await record('3ds_requires_reconciliation', detail);
      return res.status(202).json({
        success: false,
        errorCode: 'ADDITIONAL_AUTHENTICATION_REQUIRED',
        doNotRetry: true,
        requiresVerification: true,
        attemptId
      });
    }

    if (!out.reservationExists || !out.paid || out.notConfirmed) {
      await record('needs_reconciliation', detail);
      return res.status(202).json({
        success: false,
        errorCode: 'BOOKING_STATUS_UNVERIFIED',
        doNotRetry: true,
        requiresVerification: true,
        attemptId
      });
    }

    await record('verified', detail);
    return res.status(200).json({
      success: true,
      paymentVerified: true,
      reservationVerified: true,
      confirmationCode: out.reference,
      checkInDate: str(b.checkIn, 10),
      checkOutDate: str(b.checkOut, 10),
      attemptId
    });
  } catch (e) {
    await record('needs_reconciliation', {
      sent, errorType: e.name || 'Error'
    });
    console.error('Instant charge outcome uncertain', {
      attemptId, message: e.message, sent
    });
    return res.status(503).json({
      success: false,
      errorCode: 'BOOKING_STATUS_UNKNOWN',
      doNotRetry: true,
      requiresVerification: true,
      attemptId
    });
  }
};
