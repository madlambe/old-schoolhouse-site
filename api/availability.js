let cachedToken = null;
let tokenExpiresAt = 0;

async function getGuestyToken() {
  // Reuse the Guesty token until 5 minutes before expiry
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "booking_engine:api",
    client_id: process.env.GUESTY_BE_CLIENT_ID,
    client_secret: process.env.GUESTY_BE_CLIENT_SECRET,
  });

  const response = await fetch("https://booking.guesty.com/oauth2/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Guesty authentication failed: ${response.status} ${errorText}`
    );
  }

  const data = await response.json();

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  return cachedToken;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  const { checkIn, checkOut } = req.query;

  if (!validDate(checkIn) || !validDate(checkOut)) {
    return res.status(400).json({
      success: false,
      error: "Please provide checkIn and checkOut as YYYY-MM-DD",
    });
  }

  if (checkOut <= checkIn) {
    return res.status(400).json({
      success: false,
      error: "Check-out must be after check-in",
    });
  }

  try {
    const token = await getGuestyToken();

    const params = new URLSearchParams({
      checkIn,
      checkOut,
      fields: "_id nickname title accommodates totalPrice",
      limit: "10",
    });

    const response = await fetch(
      `https://booking.guesty.com/api/listings?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: data,
      });
    }

    const listing = Array.isArray(data.results)
      ? data.results.find(
          (item) => item.nickname === "The Old Schoolhouse"
        )
      : null;

    if (!listing) {
      return res.status(200).json({
        success: true,
        available: false,
        checkIn,
        checkOut,
        message: "The Old Schoolhouse is not available for these dates.",
      });
    }

    return res.status(200).json({
      success: true,
      available: true,
      checkIn,
      checkOut,
      property: {
        id: listing._id,
        name: listing.nickname || listing.title,
        accommodates: listing.accommodates,
      },
      totalPrice: listing.totalPrice,
    });
  } catch (error) {
    console.error("Guesty availability error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
