let cachedToken = null;
let tokenExpiresAt = 0;

async function getGuestyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "booking_engine:api",
    client_id: process.env.GUESTY_BE_CLIENT_ID,
    client_secret: process.env.GUESTY_BE_CLIENT_SECRET,
  });

  const response = await fetch("https://booking.guesty.com/oauth2/token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Guesty auth failed: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  tokenExpiresAt =
    Date.now() + Math.max((data.expires_in || 86400) - 300, 60) * 1000;

  return cachedToken;
}

export default async function handler(req, res) {
  try {
    const quoteId = req.query.quoteId;

    if (!quoteId) {
      return res.status(400).json({
        success: false,
        error: "quoteId is required",
      });
    }

    const token = await getGuestyToken();

    // Apply Dog fee + Pool heating
    const applyResponse = await fetch(
      `https://booking.guesty.com/api/reservations/upsell/${quoteId}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          additionalFeeIds: [
            "6a9a72c18edf716db60d74bb", // Dog fee
            "6a9a761e8edf716db60d8cfc", // Pool heating
          ],
          ratePlanIds: ["default-rateplan-id"],
        }),
      }
    );

    const applyData = await applyResponse.json();

    if (!applyResponse.ok) {
      return res.status(applyResponse.status).json({
        success: false,
        stage: "apply-upsells",
        error: applyData,
      });
    }

    // Retrieve updated quote
    const quoteResponse = await fetch(
      `https://booking.guesty.com/api/reservations/quotes/${quoteId}`,
      {
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const quoteData = await quoteResponse.json();

    if (!quoteResponse.ok) {
      return res.status(quoteResponse.status).json({
        success: false,
        stage: "retrieve-updated-quote",
        error: quoteData,
      });
    }

    return res.status(200).json({
      success: true,
      applied: applyData,
      updatedQuote: quoteData,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
