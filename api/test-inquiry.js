let cachedToken = null;
let tokenExpiresAt = 0;

async function getGuestyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const response = await fetch(
    "https://booking.guesty.com/api/auth/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.GUESTY_BE_CLIENT_ID,
        client_secret: process.env.GUESTY_BE_CLIENT_SECRET,
        scope: "booking_engine:api",
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Guesty authentication failed: ${JSON.stringify(data)}`
    );
  }

  cachedToken = data.access_token;

  // Guesty tokens last 24 hours; refresh slightly early.
  tokenExpiresAt =
    Date.now() + ((data.expires_in || 86400) - 300) * 1000;

  return cachedToken;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    const token = await getGuestyToken();

    const quoteId = "6ab619ddf86e6c460c36cacd";
    const ratePlanId = "default-rateplan-id";

    const response = await fetch(
      `https://booking.guesty.com/api/reservations/quotes/${quoteId}/inquiry`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ratePlanId: ratePlanId,

          // Do not hold/block these dates for the test inquiry.
          reservedUntil: -1,

          guest: {
            firstName: "BEAPI",
            lastName: "Test",
            email: "hello@the-old-schoolhouse.com"
          }
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        guestyStatus: response.status,
        guestyResponse: data,
      });
    }

    return res.status(200).json({
      success: true,
      message: "BEAPI test inquiry created",
      reservation: data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
