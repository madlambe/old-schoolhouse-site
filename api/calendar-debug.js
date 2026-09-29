// TEMPORARY Guesty calendar diagnostic
// Safe diagnostic endpoint for 2–4 November 2026.
// Delete this file after testing.

const LISTING_ID = "6a9971cb2e53cb00111b27da";
const TOKEN_KEY = "guesty:open-api:access-token";

async function redis(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error("Upstash Redis environment variables are missing.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    throw new Error(
      `Redis request failed: ${response.status} ${await response.text()}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Redis error: ${data.error}`);
  }

  return data.result;
}

async function getGuestyToken() {
  // Use the SAME cached token as calendar.js.
  const cachedToken = await redis(["GET", TOKEN_KEY]);

  if (cachedToken) {
    return cachedToken;
  }

  // Only request a new token if the shared cache is genuinely empty.
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.GUESTY_OPEN_CLIENT_ID,
    client_secret: process.env.GUESTY_OPEN_CLIENT_SECRET,
  });

  const response = await fetch(
    "https://open-api.guesty.com/oauth2/token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    }
  );

  if (!response.ok) {
    throw new Error(
      `Guesty authentication failed: ${response.status} ${await response.text()}`
    );
  }

  const data = await response.json();

  const expiresIn = Math.max(
    Number(data.expires_in || 86400) - 300,
    60
  );

  await redis([
    "SET",
    TOKEN_KEY,
    data.access_token,
    "EX",
    String(expiresIn),
  ]);

  return data.access_token;
}

export default async function handler(req, res) {
  try {
    const token = await getGuestyToken();

    const url =
      `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/` +
      `${LISTING_ID}?startDate=2026-11-02&endDate=2026-11-04`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Guesty calendar failed: ${response.status} ${rawText}`
      );
    }

    const raw = JSON.parse(rawText);

    /*
      IMPORTANT:
      Return the Guesty calendar objects essentially intact so we can see
      the structure Guesty is actually providing.

      Recursively remove fields that could expose guest identity/contact
      information before sending the diagnostic response to the browser.
    */

    const PRIVATE_KEYS = new Set([
      "guest",
      "guests",
      "guestId",
      "guestIds",
      "guestName",
      "firstName",
      "lastName",
      "fullName",
      "email",
      "emails",
      "phone",
      "phones",
      "phoneNumber",
      "address",
      "confirmationCode",
      "confirmation_code",
      "notes",
      "note"
    ]);

    function sanitise(value) {
      if (Array.isArray(value)) {
        return value.map(sanitise);
      }

      if (value && typeof value === "object") {
        const clean = {};

        for (const [key, item] of Object.entries(value)) {
          if (PRIVATE_KEYS.has(key)) continue;
          clean[key] = sanitise(item);
        }

        return clean;
      }

      return value;
    }

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      diagnostic: "Guesty raw calendar structure — 2 to 4 November 2026",
      data: sanitise(raw),
    });
  } catch (error) {
    console.error("Calendar debug error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
