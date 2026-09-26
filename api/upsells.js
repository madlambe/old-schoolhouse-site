let cachedToken = null;
let tokenExpiresAt = 0;

async function getGuestyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

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

  // Refresh a little before Guesty's actual expiry time.
  tokenExpiresAt =
    Date.now() + Math.max((data.expires_in || 86400) - 300, 60) * 1000;

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
    const { inquiryId, listingId } = req.query;

    if (!inquiryId || !listingId) {
      return res.status(400).json({
        success: false,
        error: "inquiryId and listingId are required",
      });
    }

    const token = await getGuestyToken();

    const url =
      `https://booking.guesty.com/api/reservations/upsell/` +
      `${encodeURIComponent(inquiryId)}/` +
      `${encodeURIComponent(listingId)}/fee`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        status: response.status,
        error: data,
      });
    }

    return res.status(200).json({
      success: true,
      upsells: data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
