
'use strict';

const crypto = require('node:crypto');

const ORIGINS = new Set([
  'https://the-old-schoolhouse.webflow.io',
  'https://www.the-old-schoolhouse.com',
  'https://the-old-schoolhouse.com'
]);

const SESSION_PREFIX = 'tosh:3ds-session:v1:';

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}

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

  const response = await fetch(url.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw Error('Redis HTTP failure');
  }

  const data = await response.json();

  if (data.error) {
    throw Error('Redis command failure');
  }

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

  const { authSession } = req.body || {};

  if (
    typeof authSession !== 'string' ||
    !/^[a-f0-9]{64}$/.test(authSession)
  ) {
    return res.status(400).json({
      errorCode: 'INVALID_SESSION'
    });
  }

  try {
    const sessionKey =
      SESSION_PREFIX + hash(authSession);

    const raw = await redis([
      'GET',
      sessionKey
    ]);

    if (!raw) {
      return res.status(410).json({
        errorCode: 'SESSION_EXPIRED'
      });
    }

    const session = JSON.parse(raw);

    if (
      !session.paymentIntentId ||
      !/^pi_[A-Za-z0-9]+$/.test(session.paymentIntentId)
    ) {
      return res.status(403).json({
        errorCode: 'INVALID_PAYMENT_SESSION'
      });
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;

    if (
      !stripeKey ||
      !/^sk_(test|live)_/.test(stripeKey)
    ) {
      return res.status(503).json({
        errorCode: 'STRIPE_KEY_NOT_CONFIGURED'
      });
    }

    const response = await fetch(
      'https://api.stripe.com/v1/payment_intents/' +
        encodeURIComponent(session.paymentIntentId),
      {
        headers: {
          Authorization: 'Bearer ' + stripeKey
        },
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        errorCode: 'STRIPE_LOOKUP_FAILED'
      });
    }

    const paymentIntent = await response.json();

    if (paymentIntent.id !== session.paymentIntentId) {
      return res.status(502).json({
        errorCode: 'INTENT_MISMATCH'
      });
    }

    if (
      paymentIntent.status === 'requires_action' &&
      paymentIntent.next_action?.type === 'use_stripe_sdk' &&
      typeof paymentIntent.client_secret === 'string'
    ) {
      return res.status(200).json({
        requiresAuthentication: true,
        clientSecret: paymentIntent.client_secret,
        attemptId: session.attemptId
      });
    }

    // Stripe success alone does not verify Guesty's payment.

    return res.status(200).json({
      requiresAuthentication: false,
      stripeStatus: paymentIntent.status,
      guestyVerified: false,
      attemptId: session.attemptId,
      reference: session.reference
    });

  } catch (error) {
    console.error('3DS authentication session error', {
      name: error.name
    });

    return res.status(503).json({
      errorCode: 'AUTH_SESSION_UNAVAILABLE'
    });
  }
};
