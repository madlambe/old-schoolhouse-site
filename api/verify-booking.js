
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

  if (!response.ok) throw Error('Redis request failed');

  const data = await response.json();
  if (data.error) throw Error('Redis command failed');
  return data.result;
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
    return res.status(405).json({ errorCode: 'METHOD_NOT_ALLOWED' });
  }

  if (!ORIGINS.has(origin)) {
    return res.status(403).json({ errorCode: 'ORIGIN_NOT_ALLOWED' });
  }

  const { authSession, checkoutNonce } = req.body || {};

  if (
    typeof authSession !== 'string' ||
    !/^[a-f0-9]{64}$/.test(authSession) ||
    typeof checkoutNonce !== 'string' ||
    !/^[a-f0-9]{64}$/.test(checkoutNonce)
  ) {
    return res.status(400).json({ errorCode: 'INVALID_SESSION' });
  }

  try {
    const raw = await redis([
      'GET',
      'tosh:3ds-session:v1:' + hash(authSession)
    ]);

    if (!raw) {
      return res.status(410).json({ errorCode: 'SESSION_EXPIRED' });
    }

    const session = JSON.parse(raw);

    if (
      session.nonceHash !== hash(checkoutNonce) ||
      !/^pi_[A-Za-z0-9]+$/.test(session.paymentIntentId || '') ||
      !/^GY-[A-Za-z0-9]+$/.test(session.reference || '')
    ) {
      return res.status(403).json({ errorCode: 'SESSION_MISMATCH' });
    }

    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw Error('Stripe unavailable');

    const stripeResponse = await fetch(
      'https://api.stripe.com/v1/payment_intents/' +
      encodeURIComponent(session.paymentIntentId),
      {
        headers: { Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!stripeResponse.ok) throw Error('Stripe lookup failed');

    const payment = await stripeResponse.json();
    const metadata = payment.metadata || {};

    if (
      payment.id !== session.paymentIntentId ||
      metadata.confirmationCode !== session.reference ||
      !metadata.reservationId ||
      !metadata.paymentId
    ) {
      return res.status(409).json({
        verified: false,
        errorCode: 'PAYMENT_MATCH_UNVERIFIED'
      });
    }

    if (payment.status !== 'succeeded') {
      return res.status(202).json({
        verified: false,
        errorCode: 'PAYMENT_NOT_COMPLETE'
      });
    }

    const token = await getBookingToken();

    const guestyResponse = await fetch(
      'https://booking.guesty.com/api/reservations/' +
      encodeURIComponent(metadata.reservationId) + '/details',
      {
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!guestyResponse.ok) {
      throw Error('Reservation lookup failed');
    }

    const result = await guestyResponse.json();
    const reservation = result.reservation || result;

    const status = String(
      reservation.status || ''
    ).toLowerCase();

    const reference =
      reservation.confirmationCode ||
      reservation.confirmation_code;

    if (
      status !== 'confirmed' ||
      reference !== session.reference
    ) {
      return res.status(202).json({
        verified: false,
        errorCode: 'RESERVATION_NOT_VERIFIED'
      });
    }

    return res.status(200).json({
      verified: true,
      paymentVerified: true,
      reservationVerified: true,
      confirmationCode: session.reference
    });

  } catch (error) {
    console.error('Booking verification failed', {
      message: error.message
    });

    return res.status(503).json({
      verified: false,
      errorCode: 'VERIFICATION_UNAVAILABLE'
    });
  }
};
