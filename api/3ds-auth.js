
'use strict';

const crypto = require('node:crypto');
const { getBookingToken } = require('../lib/booking-auth.cjs');

const ORIGINS = new Set([
  'https://the-old-schoolhouse.webflow.io',
  'https://www.the-old-schoolhouse.com',
  'https://the-old-schoolhouse.com'
]);

const hash = value =>
  crypto.createHash('sha256').update(value).digest('hex');

async function redis(command) {
  const url = process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) throw Error('Redis not configured');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) throw Error('Redis request failed');

  const data = await response.json();
  return data.result;
}

async function stripeGet(path) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw Error('Stripe not configured');

  const response = await fetch(
    `https://api.stripe.com/v1/${path}`,
    {
      headers: {
        Authorization: `Bearer ${secret}`
      }
    }
  );

  if (!response.ok) throw Error('Stripe lookup failed');
  return response.json();
}

async function guestyReservation(id) {
  const token = await getBookingToken();

  const response = await fetch(
    `https://booking.guesty.com/api/reservations/${encodeURIComponent(id)}/details`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    }
  );

  const raw = await response.text();
  let data = null;

  try {
    data = JSON.parse(raw);
  } catch (_) {}

  return {
    httpStatus: response.status,
    ok: response.ok,
    data
  };
}

const TEST_RESERVATION = '6aeacb8fb6e3d458ad8f1135';
const TEST_PAYMENT = '6aeacb90cc69260b5fb18735';
const TEST_REFERENCE = 'GY-dv5Pwq5t';

function diagnosticSummary(result) {
  const root = result.data;

  if (!result.ok || !root || typeof root !== 'object') {
    return {
      guestyHttpStatus: result.httpStatus,
      guestyResponseValid: false
    };
  }

  const reservation =
    root.reservation && typeof root.reservation === 'object'
      ? root.reservation
      : root;

  const money =
    reservation.money &&
    typeof reservation.money === 'object'
      ? reservation.money
      : {};

  const payments = Array.isArray(money.payments)
    ? money.payments
    : Array.isArray(reservation.payments)
      ? reservation.payments
      : [];

  const safeFields = [
    '_id',
    'id',
    'reservationId',
    'confirmationCode',
    'confirmation_code',
    'status'
  ];

  const fields = {};

  for (const key of safeFields) {
    if (Object.prototype.hasOwnProperty.call(reservation, key)) {
      fields[key] = reservation[key];
    }
  }

  const paymentSummaries = payments.map(payment => ({
    id: payment._id || payment.id || null,
    status: payment.status || null,
    paymentStatus: payment.paymentStatus || null
  }));

  const reservationId =
    reservation._id ||
    reservation.id ||
    reservation.reservationId;

  const reference =
    reservation.confirmationCode ||
    reservation.confirmation_code;

  const status = String(reservation.status || '').toLowerCase();

  const matchingPayment = paymentSummaries.find(
    payment => payment.id === TEST_PAYMENT
  );

  const acceptedPaymentStatuses = new Set([
    'succeeded',
    'success',
    'paid',
    'completed',
    'captured'
  ]);

  const paymentStatus = matchingPayment
    ? String(
        matchingPayment.status ||
        matchingPayment.paymentStatus ||
        ''
      ).toLowerCase()
    : '';

  return {
    guestyHttpStatus: result.httpStatus,
    guestyResponseValid: true,
    responseWrapperKeys: Object.keys(root),
    reservationKeys: Object.keys(reservation),
    fields,
    paymentLocation: Array.isArray(money.payments)
      ? 'money.payments'
      : Array.isArray(reservation.payments)
        ? 'payments'
        : 'not found',
    paymentCount: payments.length,
    paymentSummaries,
    checks: {
      reservationIdMatches: reservationId === TEST_RESERVATION,
      confirmationCodeMatches: reference === TEST_REFERENCE,
      reservationConfirmed: status === 'confirmed',
      paymentFound: Boolean(matchingPayment),
      paymentStatusAccepted: acceptedPaymentStatuses.has(paymentStatus)
    }
  };
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length &&
    crypto.timingSafeEqual(left, right);
}

async function runDiagnostic(req, res) {
  const configuredSecret = process.env.TOSH_DIAGNOSTIC_SECRET;
  const suppliedSecret = req.headers['x-diagnostic-secret'];

  if (
    !configuredSecret ||
    configuredSecret.length < 32 ||
    !safeEqual(configuredSecret, suppliedSecret)
  ) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await guestyReservation(TEST_RESERVATION);

    return res.status(200).json({
      diagnostic: true,
      reservationReference: TEST_REFERENCE,
      ...diagnosticSummary(result)
    });
  } catch (error) {
    console.error('Guesty diagnostic failed:', error.message);

    return res.status(503).json({
      diagnostic: true,
      error: 'Guesty lookup failed'
    });
  }
}

async function getSession(authSession, checkoutNonce) {
  if (
    typeof authSession !== 'string' ||
    typeof checkoutNonce !== 'string' ||
    authSession.length < 20 ||
    checkoutNonce.length < 20
  ) {
    return null;
  }

  const raw = await redis([
    'GET',
    `tosh:3ds-session:v1:${hash(authSession)}`
  ]);

  if (!raw) return null;

  let session;

  try {
    session = JSON.parse(raw);
  } catch (_) {
    return null;
  }

  if (
    !session ||
    session.nonceHash !== hash(checkoutNonce) ||
    !session.paymentIntentId
  ) {
    return null;
  }

  return session;
}

async function verifyBooking(session) {
  const intent = await stripeGet(
    `payment_intents/${encodeURIComponent(session.paymentIntentId)}`
  );

  if (intent.status !== 'succeeded') {
    return {
      verified: false,
      reason: 'payment_pending'
    };
  }

  const metadata = intent.metadata || {};

  if (
    !metadata.reservationId ||
    !metadata.paymentId ||
    metadata.confirmationCode !== session.reference
  ) {
    return {
      verified: false,
      reason: 'payment_metadata_mismatch'
    };
  }

  const lookup = await guestyReservation(metadata.reservationId);

  if (!lookup.ok || !lookup.data) {
    return {
      verified: false,
      reason: 'reservation_lookup_failed'
    };
  }

  const reservation = lookup.data;

  const reservationId =
    reservation._id ||
    reservation.id ||
    reservation.reservationId;

  const reference =
    reservation.confirmationCode ||
    reservation.confirmation_code;

  if (
    reservationId !== metadata.reservationId ||
    reference !== session.reference ||
    String(reservation.status || '').toLowerCase() !== 'confirmed'
  ) {
    return {
      verified: false,
      reason: 'reservation_not_confirmed'
    };
  }

  const payments = Array.isArray(reservation.money?.payments)
    ? reservation.money.payments
    : Array.isArray(reservation.payments)
      ? reservation.payments
      : null;

  if (payments) {
    const payment = payments.find(
      item => (item._id || item.id) === metadata.paymentId
    );

    if (
      !payment ||
      ![
        'succeeded',
        'success',
        'paid',
        'completed',
        'captured'
      ].includes(String(payment.status || '').toLowerCase())
    ) {
      return {
        verified: false,
        reason: 'reservation_payment_not_confirmed'
      };
    }
  }

  return {
    verified: true,
    paymentVerified: true,
    reservationVerified: true,
    confirmationCode: session.reference,
    attemptId: session.attemptId
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.body?.action === 'diagnostic') {
    return runDiagnostic(req, res);
  }

  const origin = req.headers.origin;

  if (origin && !ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const { authSession, checkoutNonce } = req.body || {};

  let session;

  try {
    session = await getSession(authSession, checkoutNonce);
  } catch (error) {
    console.error('3DS session lookup failed:', error.message);
    return res.status(503).json({ errorCode: 'SESSION_UNAVAILABLE' });
  }

  if (!session) {
    return res.status(403).json({ errorCode: 'INVALID_SESSION' });
  }

  if (req.body.action === 'verify') {
    try {
      const result = await verifyBooking(session);

      if (result.verified) {
        return res.status(200).json(result);
      }

      return res.status(202).json({
        verified: false,
        errorCode: result.reason,
        attemptId: session.attemptId
      });
    } catch (error) {
      console.error('Booking verification failed:', error.message);

      return res.status(503).json({
        verified: false,
        errorCode: 'VERIFICATION_UNAVAILABLE',
        attemptId: session.attemptId
      });
    }
  }

  try {
    const intent = await stripeGet(
      `payment_intents/${encodeURIComponent(session.paymentIntentId)}`
    );

    if (intent.status === 'succeeded') {
      return res.status(200).json({
        authenticated: true,
        authSession,
        attemptId: session.attemptId
      });
    }

    if (intent.status !== 'requires_action') {
      return res.status(202).json({
        authenticated: false,
        authSession,
        attemptId: session.attemptId,
        paymentStatus: intent.status
      });
    }

    const nextAction = intent.next_action || {};
    const redirect = nextAction.redirect_to_url;

    if (!redirect?.url) {
      return res.status(202).json({
        authenticated: false,
        authSession,
        attemptId: session.attemptId,
        paymentStatus: intent.status
      });
    }

    return res.status(200).json({
      authenticated: false,
      requiresAction: true,
      redirectUrl: redirect.url,
      authSession,
      attemptId: session.attemptId
    });
  } catch (error) {
    console.error('3DS authentication failed:', error.message);

    return res.status(503).json({
      errorCode: 'AUTHENTICATION_UNAVAILABLE',
      attemptId: session.attemptId
    });
  }
};
