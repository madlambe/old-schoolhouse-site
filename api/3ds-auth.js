
'use strict';

const crypto = require('node:crypto');

const ORIGINS = new Set([
  'https://the-old-schoolhouse.webflow.io',
  'https://www.the-old-schoolhouse.com',
  'https://the-old-schoolhouse.com'
]);

const hash = v =>
  crypto.createHash('sha256').update(v).digest('hex');

async function redis(command) {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw Error('Redis unavailable');
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });

  if (!r.ok) {
    throw Error('Redis HTTP failure');
  }

  const j = await r.json();

  if (j.error) {
    throw Error('Redis command failure');
  }

  return j.result;
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

  const { authSession, checkoutNonce } = req.body || {};

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

    const key = process.env.STRIPE_SECRET_KEY;

    if (!key || !/^sk_(test|live)_/.test(key)) {
      return res.status(503).json({
        errorCode: 'STRIPE_KEY_NOT_CONFIGURED'
      });
    }

    const stripe = await fetch(
      'https://api.stripe.com/v1/payment_intents/' +
        encodeURIComponent(session.paymentIntentId),
      {
        headers: {
          Authorization: 'Bearer ' + key
        },
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!stripe.ok) {
      return res.status(502).json({
        errorCode: 'STRIPE_LOOKUP_FAILED'
      });
    }

    const pi = await stripe.json();

    if (pi.id !== session.paymentIntentId) {
      return res.status(502).json({
        errorCode: 'INTENT_MISMATCH'
      });
    }

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

    // Stripe success alone does not establish Guesty payment success.
    return res.status(200).json({
      requiresAuthentication: false,
      stripeStatus: pi.status,
      guestyVerified: false,
      attemptId: session.attemptId,
      reference: session.reference
    });

  } catch (e) {
    console.error('3DS session error', e.name);

    return res.status(503).json({
      errorCode: 'AUTH_SESSION_UNAVAILABLE'
    });
  }
};
