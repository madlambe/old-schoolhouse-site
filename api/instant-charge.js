
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
const sessionHash = v => crypto.createHash('sha256').update(v).digest('hex');

const str = (v, n = 200) =>
  typeof v === 'string' ? v.trim().slice(0, n) : '';

const hash = v =>
  crypto.createHash('sha256').update(v).digest('hex');

async function redis(command) {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

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

async function findStripeIntent(payment, reference) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !/^sk_(test|live)_/.test(key)) {
    throw Error('Stripe key unavailable');
  }

  const paymentId = str(payment?._id, 100);
  const reservationId = str(payment?.reservationId, 100);
  if (!paymentId || !reservationId || !reference) return null;

  const query = `metadata['confirmationCode']:'${reference}'`;
  const url = 'https://api.stripe.com/v1/payment_intents/search?' +
    new URLSearchParams({query, limit: '20'}).toString();

  const response = await fetch(url, {
    headers: {Authorization: 'Bearer ' + key},
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) throw Error('Stripe intent search failed');

  const result = await response.json();
  if (result.has_more) return null;

  const matches = (result.data || []).filter(pi =>
    pi.status === 'requires_action' &&
    pi.metadata?.confirmationCode === reference &&
    pi.metadata?.paymentId === paymentId &&
    pi.metadata?.reservationId === reservationId &&
    pi.currency?.toLowerCase() === String(payment.currency || '').toLowerCase() &&
    Number(pi.amount) === Math.round(Number(payment.amount) * 100)
  );

  return matches.length === 1 ? matches[0] : null;
}

function analyze(data) {
  const reservation =
    data?.reservation || data?.reservationDetails || {};

  const attempts = Array.isArray(data?.payment?.attempts)
    ? data.payment.attempts
    : [];

  const statuses = attempts.map(a =>
    String(
      a?.payload?.payment_intent?.status ||
      a?.status ||
      ''
    ).toLowerCase()
  );

  const paymentStatus = String(
    data?.payment?.status || ''
  ).toLowerCase();

  const reservationStatus = String(
    reservation?.status || ''
  ).toLowerCase();

  const reference = str(
    reservation?.confirmationCode ||
    reservation?.confirmation_code ||
    reservation?._id ||
    reservation?.id,
    100
  );

  const reservationExists = Boolean(reference);

  const requiresAction =
    statuses.some(s =>
      [
        'requires_action',
        'authentication_required',
        'requires_authentication'
      ].includes(s)
    ) ||
    [
      'requires_action',
      'requires_authentication',
      'authentication_required',
      'pending_auth'
    ].includes(paymentStatus);

  const paid =
    statuses.some(s =>
      [
        'succeeded',
        'success',
        'captured',
        'paid',
        'completed'
      ].includes(s)
    ) ||
    [
      'succeeded',
      'success',
      'captured',
      'paid',
      'completed'
    ].includes(paymentStatus);

  const notConfirmed = [
    'cancelled',
    'canceled',
    'declined',
    'failed',
    'rejected',
    'pending',
    'inquiry'
  ].includes(reservationStatus);

  const challenge = data?.threeDSChallenge;

  const diagnostic = {
    threeDSChallengePresent:
      challenge !== undefined && challenge !== null,

    threeDSChallengeType:
      Array.isArray(challenge) ? 'array' : typeof challenge,

    threeDSChallengeFields:
      challenge &&
      typeof challenge === 'object' &&
      !Array.isArray(challenge)
        ? Object.keys(challenge)
            .filter(k => /^[a-zA-Z0-9_]{1,60}$/.test(k))
            .slice(0, 20)
        : [],

    paymentFields:
      data?.payment && typeof data.payment === 'object'
        ? Object.keys(data.payment)
            .filter(k => /^[a-zA-Z0-9_]{1,60}$/.test(k))
            .slice(0, 20)
        : []
  };

  return {
    diagnostic,
    reference,
    reservationExists,
    requiresAction,
    paid,
    notConfirmed,
    reservationStatus,
    paymentStatus,
    attemptStatuses: statuses
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
  const checkoutNonce = str(b.checkoutNonce, 128);

  const firstName = str(guest.firstName, 100);
  const lastName = str(guest.lastName, 100);
  const email = str(guest.email, 254);
  const phone = str(guest.phone, 50);

  if (
    !/^[a-f0-9]{64}$/.test(checkoutNonce) ||
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
    try {
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
    } catch (e) {
      console.error('Redis update failed', {
        attemptId,
        message: e.message
      });
    }
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

    if (!r.ok) {
      console.error(
        'Guesty API rejection',
        JSON.stringify({
          httpStatus: r.status,
          requestId: r.headers.get('x-request-id'),
          errors:
            data?.errors ||
            data?.error ||
            data?.message ||
            data?.details ||
            'No error details returned'
        }, null, 2)
      );
    }

    const out = analyze(data);

    const detail = {
      httpStatus: r.status,
      requestId: r.headers.get('x-request-id') || null,
      reference: out.reference,
      reservationStatus: out.reservationStatus,
      paymentStatus: out.paymentStatus,
      attemptStatuses: out.attemptStatuses,
      diagnostic: out.diagnostic
    };

    console.log('Guesty instant-charge result', {
      attemptId,
      ...detail
    });

    if (!r.ok) {
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
      const intents = (data?.payment?.attempts || [])
        .map(a => a?.payload?.payment_intent)
        .filter(Boolean);

      let intent = intents.find(i =>
        i.status === 'requires_action' &&
        /^pi_[A-Za-z0-9]+$/.test(i.id || '')
      );

      if (!intent) {
        try {
          intent = await findStripeIntent(
            data?.payment,
            out.reference
          );
        } catch (e) {
          console.error('Stripe intent identification failed', {
            attemptId,
            message: e.message
          });
        }
      }

      if (!intent) {
        await record('3ds_requires_reconciliation', detail);

        return res.status(202).json({
          success: false,
          errorCode: '3DS_INTENT_NOT_IDENTIFIED',
          doNotRetry: true,
          attemptId
        });
      }

      const session = crypto.randomBytes(32).toString('hex');
      const sessionKey =
        SESSION_PREFIX + sessionHash(session);

      try {
        await redis([
          'SET',
          sessionKey,
          JSON.stringify({
            paymentIntentId: intent.id,
            reference: out.reference,
            quoteHash: hash(quoteId),
            nonceHash: sessionHash(checkoutNonce),
            attemptId,
            createdAt: Date.now()
          }),
          'EX',
          1800
        ]);

        await record('3ds_pending', {
          ...detail,
          paymentIntentId: intent.id
        });
      } catch (e) {
        console.error('3DS session storage failed', {
          attemptId
        });

        return res.status(503).json({
          success: false,
          errorCode: '3DS_SESSION_UNAVAILABLE',
          doNotRetry: true,
          attemptId
        });
      }

      return res.status(202).json({
        success: false,
        errorCode: 'ADDITIONAL_AUTHENTICATION_REQUIRED',
        requiresAuthentication: true,
        authSession: session,
        attemptId,
        doNotRetry: true
      });
    }

    if (
      !out.reservationExists ||
      !out.paid ||
      out.notConfirmed
    ) {
      await record('needs_reconciliation', detail);

      return res.status(202).json({
        success: false,
        errorCode: 'BOOKING_STATUS_UNVERIFIED',
        diagnostic: out.diagnostic,
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
      sent,
      errorType: e.name || 'Error'
    });

    console.error('Instant charge outcome uncertain', {
      attemptId,
      message: e.message,
      sent
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
