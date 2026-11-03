
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
const SESSION_PREFIX = 'tosh:3ds-session:v1:';
const SESSION_TTL = 1800;

function str(value, max = 200) {
  return typeof value === 'string'
    ? value.trim().slice(0, max)
    : '';
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function redis(command) {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw Error('Redis configuration missing');
  }

  const r = await fetch(url.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  if (!r.ok) {
    throw Error(`Redis HTTP ${r.status}`);
  }

  const data = await r.json();

  if (data.error) {
    throw Error(`Redis error: ${data.error}`);
  }

  return data.result;
}

function safeKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).slice(0, 30)
    : [];
}

function diagnosticShape(data) {
  const attempts = Array.isArray(data?.payment?.attempts)
    ? data.payment.attempts.slice(0, 5)
    : [];

  return {
    topLevelKeys: safeKeys(data),
    paymentKeys: safeKeys(data?.payment),
    attempts: attempts.map(a => ({
      keys: safeKeys(a),
      payloadKeys: safeKeys(a?.payload),
      paymentIntentKeys: safeKeys(a?.payload?.payment_intent),
      nextActionType:
        str(a?.payload?.payment_intent?.next_action?.type, 60) || null,
      nextActionKeys:
        safeKeys(a?.payload?.payment_intent?.next_action)
    }))
  };
}

function analyze(data) {
  const reservation =
    data?.reservation ||
    data?.reservationDetails ||
    {};

  const payment = data?.payment || {};

  const attempts = Array.isArray(payment.attempts)
    ? payment.attempts
    : [];

  const statuses = attempts
    .map(a =>
      str(
        a?.payload?.payment_intent?.status ||
        a?.status,
        80
      ).toLowerCase()
    )
    .filter(Boolean);

  const reservationStatus = str(
    reservation.status ||
    reservation.reservationStatus,
    80
  ).toLowerCase();

  const paymentStatus = str(payment.status, 80).toLowerCase();

  const reference = str(
    reservation.confirmationCode ||
    reservation.confirmation_code ||
    payment.confirmationCode,
    100
  );

  const reservationExists = Boolean(
    reservation._id ||
    reservation.id ||
    reference
  );

  const requiresAction =
    paymentStatus === 'pending_auth' ||
    paymentStatus === 'requires_action' ||
    paymentStatus === 'requires_authentication' ||
    statuses.some(s =>
      s === 'requires_action' ||
      s === 'requires_authentication'
    );

  const paid =
    ['paid', 'succeeded', 'completed', 'successful'].includes(paymentStatus) ||
    statuses.includes('succeeded');

  const notConfirmed =
    ['cancelled', 'canceled', 'expired', 'declined'].includes(reservationStatus);

  const paymentIntent = attempts
    .map(a => a?.payload?.payment_intent)
    .find(pi => pi && typeof pi === 'object' &&
      typeof pi.id === 'string' &&
      pi.id.startsWith('pi_'));

  return {
    reference,
    reservationExists,
    requiresAction,
    paid,
    notConfirmed,
    reservationStatus,
    paymentStatus,
    attemptStatuses: statuses,
    paymentIntentId: paymentIntent?.id || null
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

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      errorCode: 'METHOD_NOT_ALLOWED'
    });
  }

  if (process.env.ENABLE_LIVE_INSTANT_CHARGE !== 'true') {
    return res.status(503).json({
      success: false,
      errorCode: 'LIVE_CHECKOUT_DISABLED'
    });
  }

  if (!ORIGINS.has(origin)) {
    return res.status(403).json({
      success: false,
      errorCode: 'ORIGIN_NOT_ALLOWED'
    });
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
    !quoteId ||
    !ratePlanId ||
    !/^ctoken_[A-Za-z0-9_]+$/.test(confirmationToken) ||
    !firstName ||
    !lastName ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_BOOKING_REQUEST'
    });
  }

  const key = PREFIX + hash(quoteId);

  const attemptId = crypto
    .randomBytes(12)
    .toString('hex');

  const record = async (state, details = {}) => {
    await redis([
      'SET',
      key,
      JSON.stringify({
        state,
        attemptId,
        ...details
      }),
      'EX',
      TTL
    ]);
  };

  try {
    const locked = await redis([
      'SET',
      key,
      JSON.stringify({
        state: 'processing',
        attemptId
      }),
      'NX',
      'EX',
      TTL
    ]);

    if (locked !== 'OK') {
      return res.status(409).json({
        success: false,
        errorCode: 'BOOKING_ATTEMPT_ALREADY_EXISTS',
        doNotRetry: true
      });
    }
  } catch (e) {
    return res.status(503).json({
      success: false,
      errorCode: 'PAYMENT_PROTECTION_UNAVAILABLE',
      doNotRetry: true
    });
  }

  let sent = false;

  try {
    const token = await getBookingToken();

    if (!token) {
      throw Error('Guesty token unavailable');
    }

    const payload = {
      ratePlanId,
      confirmationToken,
      reuse: true,
      guest: {
        firstName,
        lastName,
        email,
        phone,
        ...(guest.address
          ? { address: guest.address }
          : {})
      }
    };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      30000
    );

    let r;

    try {
      r = await fetch(
        `https://booking.guesty.com/api/reservations/quotes/${encodeURIComponent(quoteId)}/instant-charge`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const data = await r.json().catch(() => null);
    const out = analyze(data);

    const detail = {
      httpStatus: r.status,
      reference: out.reference,
      reservationStatus: out.reservationStatus,
      paymentStatus: out.paymentStatus,
      attemptStatuses: out.attemptStatuses
    };

    console.log('Guesty instant-charge result', {
      attemptId,
      ...detail
    });

    if (!r.ok) {
      console.log('Guesty 3DS diagnostic shape', {
        attemptId,
        ...diagnosticShape(data)
      });

      await record('guesty_request_failed', detail);

      return res.status(502).json({
        success: false,
        errorCode: 'GUESTY_PAYMENT_UNVERIFIED',
        doNotRetry: true,
        attemptId
      });
    }

    if (out.requiresAction) {
      console.log('Guesty 3DS diagnostic shape', {
        attemptId,
        ...diagnosticShape(data)
      });

      if (!out.paymentIntentId) {
        await record('3ds_missing_payment_intent', detail);

        return res.status(202).json({
          success: false,
          errorCode: 'ADDITIONAL_AUTHENTICATION_REQUIRED',
          requiresVerification: true,
          doNotRetry: true,
          attemptId
        });
      }

      const sessionToken = crypto
        .randomBytes(32)
        .toString('hex');

      const sessionKey = SESSION_PREFIX + hash(sessionToken);

      const session = {
        attemptId,
        quoteHash: hash(quoteId),
        paymentIntentId: out.paymentIntentId,
        reference: out.reference,
        createdAt: Date.now()
      };

      await redis([
        'SET',
        sessionKey,
        JSON.stringify(session),
        'EX',
        SESSION_TTL
      ]);

      await record('3ds_authentication_required', {
        ...detail,
        paymentIntentId: out.paymentIntentId
      });

      sent = true;

      return res.status(202).json({
        success: false,
        errorCode: 'ADDITIONAL_AUTHENTICATION_REQUIRED',
        requiresAuthentication: true,
        doNotRetry: true,
        attemptId,
        authSession: sessionToken
      });
    }

    if (
      out.paid &&
      out.reservationExists &&
      !out.notConfirmed
    ) {
      await record('payment_verified', detail);

      sent = true;

      return res.status(200).json({
        success: true,
        paymentVerified: true,
        reservationVerified: true,
        confirmationCode: out.reference,
        attemptId
      });
    }

    console.log('Guesty 3DS diagnostic shape', {
      attemptId,
      ...diagnosticShape(data)
    });

    await record('payment_unverified', detail);

    sent = true;

    return res.status(202).json({
      success: false,
      errorCode: 'PAYMENT_NOT_YET_VERIFIED',
      requiresVerification: true,
      doNotRetry: true,
      attemptId
    });
  } catch (e) {
    console.error('Instant-charge error', {
      attemptId,
      message: e.message
    });

    try {
      await record('uncertain_outcome', {
        error: e.message
      });
    } catch (recordError) {
      console.error('Redis update failed', {
        attemptId,
        message: recordError.message
      });
    }

    if (!sent) {
      return res.status(503).json({
        success: false,
        errorCode: 'PAYMENT_OUTCOME_UNCERTAIN',
        doNotRetry: true,
        attemptId
      });
    }
  }
};
