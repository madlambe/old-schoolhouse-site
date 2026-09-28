const LISTING_ID = "6a9971cb2e53cb00111b27da";

let tokenCache = {
  token: null,
  expiresAt: 0
};

async function getOpenApiToken() {
  const now = Date.now();

  if (
    tokenCache.token &&
    tokenCache.expiresAt > now + 5 * 60 * 1000
  ) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "open-api",
    client_id: process.env.GUESTY_OPEN_CLIENT_ID,
    client_secret: process.env.GUESTY_OPEN_CLIENT_SECRET
  });

  const response = await fetch(
    "https://open-api.guesty.com/oauth2/token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Guesty authentication failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  tokenCache.token = data.access_token;
  tokenCache.expiresAt =
    now + (data.expires_in || 86400) * 1000;

  return tokenCache.token;
}

module.exports = async function handler(req, res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: "startDate and endDate are required"
      });
    }

    const token = await getOpenApiToken();

    const url =
      `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/${LISTING_ID}` +
      `?startDate=${encodeURIComponent(startDate)}` +
      `&endDate=${encodeURIComponent(endDate)}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: "Guesty calendar request failed",
        guesty: data
      });
    }

    return res.status(200).json({
      success: true,
      calendar: data
    });

  } catch (error) {
    console.error("Calendar error:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
