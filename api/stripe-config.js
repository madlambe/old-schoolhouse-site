const ALLOWED_ORIGINS = [
  "https://the-old-schoolhouse.webflow.io",
  "https://www.the-old-schoolhouse.com",
  "https://the-old-schoolhouse.com",
];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

  if (!publishableKey) {
    return res.status(500).json({
      success: false,
      error: "Stripe configuration unavailable",
    });
  }

  return res.status(200).json({
    success: true,
    publishableKey,
  });
};
