let cachedToken = null;
let tokenExpiresAt = 0;

async function getGuestyToken() {
  // Reuse the token until 5 minutes before expiry
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
    throw new Error(`Guesty authentication failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  return cachedToken;
}
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await getGuestyToken();

    return res.status(200).json({
      success: true,
      message: "Guesty BEAPI authentication is working"
    });

  } catch (error) {
    console.error("Guesty authentication test error:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
