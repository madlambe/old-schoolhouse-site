
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

  if (!url || !token) throw Error('Redis unavailable');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) throw Error('Redis HTTP failure');

  const data = await response.json();
  if (data.error) throw Error('Redis command failure');

  return data.result;
}

function pending(res, errorCode) {
  return res.status(202).json({
    verified: false,
    paymentVerified: false,
    reservationVerified: false,
    errorCode
  });
}

async function getPaymentIntent(paymentIntentId) {
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key || !/^sk_(test|live)_/.test(key)) {
    throw Error('Stripe key unavailable');
  }

  const response = await fetch(
    'https://api.stripe.com/v1/payment_intents/' +
      encodeURIComponent(paymentIntentId),
    {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(12000)
    }
  );

  if (!response.ok) throw Error('Stripe lookup failed');

  return response.json();
}

async function getReservation(reservationId) {
  const token = await getBookingToken();

  const response = await fetch(
    'https://booking.guesty.com/api/reservations/' +
      encodeURIComponent(reservationId) + '/details',
    {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(12000)
    }
  );

  if (!response.ok) {
    console.error('Reservation details lookup HTTP', response.status);
    throw Error('Reservation lookup unavailable');
  }

  const data = await response.json();
  return data.reservation || data;
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
      errorCode: 'METHOD_NOT_ALLOWED'
    });
  }

  if (!ORIGINS.has(origin)) {
    return res.status(403).json({
      errorCode: 'ORIGIN_NOT_ALLOWED'
    });
  }

  if (process.env.ENABLE_LIVE_INSTANT_CHARGE !== 'true') {
    return res.status(503).json({
      errorCode: 'LIVE_CHECKOUT_DISABLED'
    });
  }

  const {
    authSession,
    checkoutNonce,
    action
  } = req.body || {};

  if (
    typeof authSession !== 'string' ||
    !/^[a-f0-9]{64}$/.test(authSession) ||
    typeof checkoutNonce !== 'string' ||
    !/^[a-f0-9]{64}$/.test(checkoutNonce)
  ) {
    return res.status(400).json({
      errorCode: 'INVALID_SESSION'
    });
  }

  try {
    const raw = await redis([
      'GET',
      'tosh:3ds-session:v1:' + hash(authSession)
    ]);

    if (!raw) {
      return res.status(410).json({
        errorCode: 'SESSION_EXPIRED'
      });
    }

    const session = JSON.parse(raw);

    if (session.nonceHash !== hash(checkoutNonce)) {
      return res.status(403).json({
        errorCode: 'SESSION_MISMATCH'
      });
    }

    if (
      typeof session.paymentIntentId !== 'string' ||
      !/^pi_[A-Za-z0-9]+$/.test(session.paymentIntentId)
    ) {
      return res.status(409).json({
        errorCode: 'INVALID_PAYMENT_SESSION'
      });
    }

    const pi = await getPaymentIntent(session.paymentIntentId);

    if (pi.id !== session.paymentIntentId) {
      return res.status(502).json({
        errorCode: 'INTENT_MISMATCH'
      });
    }

    // Preserve the existing bank authentication behaviour.
    if (action !== 'verify') {
      if (
        pi.status === 'requires_action' &&
        pi.next_action?.type === 'use_stripe_sdk' &&
        typeof pi.client_secret === 'string'
      ) {
        return res.status(200).json({
          requiresAuthentication: true,
          clientSecret: pi.client_secret,
          attemptId: session.attemptId
        });
      }

      return res.status(200).json({
        requiresAuthentication: false,
        stripeStatus: pi.status,
        guestyVerified: false,
        attemptId: session.attemptId,
        reference: session.reference
      });
    }

    // Verification never creates or retries a payment.
    if (pi.status !== 'succeeded') {
      return pending(res, 'PAYMENT_NOT_COMPLETE');
    }

    const metadata = pi.metadata || {};

    // Match Stripe's payment to the exact reservation
    // and payment identified during checkout.
    if (
      metadata.confirmationCode !== session.reference ||
      typeof metadata.reservationId !== 'string' ||
      !metadata.reservationId ||
      typeof metadata.paymentId !== 'string' ||
      !metadata.paymentId
    ) {
      return res.status(409).json({
        verified: false,
        errorCode: 'PAYMENT_MATCH_UNVERIFIED'
      });
    }

    const reservation = await getReservation(metadata.reservationId);

    const reservationId =
      reservation._id || reservation.id || reservation.reservationId;

    const reference =
      reservation.confirmationCode ||
      reservation.confirmation_code;

    const status = String(
      reservation.status || ''
    ).toLowerCase();

    if (
      reservationId !== metadata.reservationId ||
      reference !== session.reference ||
      status !== 'confirmed'
    ) {
      return pending(res, 'RESERVATION_NOT_VERIFIED');
    }

    // Check the matching payment if the reservation details
    // include payment records.
    const payments =
      reservation.money?.payments ||
      reservation.payments ||
      [];

    if (Array.isArray(payments) && payments.length) {
      const matchingPayment = payments.find(payment =>
        (payment._id || payment.id) === metadata.paymentId
      );

      if (!matchingPayment) {
        return pending(res, 'RESERVATION_PAYMENT_NOT_FOUND');
      }

      const paymentStatus = String(
        matchingPayment.status || ''
      ).toLowerCase();

      if (
        !['succeeded', 'success', 'paid',
          'completed', 'captured'].includes(paymentStatus)
      ) {
        return pending(res, 'RESERVATION_PAYMENT_PENDING');
      }
    }

    return res.status(200).json({
      verified: true,
      paymentVerified: true,
      reservationVerified: true,
      confirmationCode: session.reference,
      attemptId: session.attemptId
    });

  } catch (error) {
    console.error('3DS verification error:', error.message);

    return res.status(503).json({
      verified: false,
      errorCode: 'VERIFICATION_UNAVAILABLE'
    });
  }
};
