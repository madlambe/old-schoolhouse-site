
// Temporary, read-only Stripe PaymentIntent diagnostic endpoint.
// Save as api/stripe-3ds-diagnostics.js in Vercel.
// Requires STRIPE_DIAGNOSTICS_KEY and STRIPE_DIAGNOSTICS_ACCESS_TOKEN.
// Never returns client_secret, card data, customer data or next_action payload.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedToken = process.env.STRIPE_DIAGNOSTICS_ACCESS_TOKEN;
  const providedToken = req.headers['x-diagnostics-token'];

  if (!expectedToken || !providedToken || providedToken !== expectedToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const key = process.env.STRIPE_DIAGNOSTICS_KEY;

  if (!key || !key.startsWith('rk_')) {
    return res.status(503).json({
      error: 'Restricted Stripe key unavailable'
    });
  }

  const paymentIntentId = req.body?.paymentIntentId;

  if (
    typeof paymentIntentId !== 'string' ||
    !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)
  ) {
    return res.status(400).json({
      error: 'Invalid PaymentIntent ID'
    });
  }

  try {
    const response = await fetch(
      `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        error: 'Stripe lookup failed',
        stripeHttpStatus: response.status
      });
    }

    const pi = await response.json();

    return res.status(200).json({
      paymentIntentId: pi.id,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      captureMethod: pi.capture_method || null,
      confirmationMethod: pi.confirmation_method || null,
      nextActionType: pi.next_action?.type || null,
      hasClientSecret: Boolean(pi.client_secret),
      latestChargePresent: Boolean(pi.latest_charge),
      lastPaymentErrorCode: pi.last_payment_error?.code || null
    });

  } catch {
    return res.status(502).json({
      error: 'Stripe lookup unavailable'
    });
  }
}
