
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

  const response = await fetch(
    "https://booking.guesty.com/oauth2/token",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Guesty auth failed: ${JSON.stringify(data)}`
    );
  }

  cachedToken = data.access_token;
  tokenExpiresAt =
    Date.now() +
    Math.max((data.expires_in || 86400) - 300, 60) * 1000;

  return cachedToken;
}

const DOG_FEE_ID = "6a9a72c18edf716db60d74bb";
const POOL_FEE_ID = "6a9a761e8edf716db60d8cfc";

function poolEligible(checkIn, checkOut) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(checkIn || "") &&
    /^\d{4}-\d{2}-\d{2}$/.test(checkOut || "") &&
    checkIn.slice(0, 4) === checkOut.slice(0, 4) &&
    checkIn.slice(5) >= "04-01" &&
    checkIn.slice(5) <= "09-30" &&
    checkOut.slice(5) > "04-01" &&
    checkOut.slice(5) <= "10-01" &&
    checkIn < checkOut
  );
}

export default async function handler(req, res) {
  
  // Allow requests from the Webflow staging site and live website.
  const allowedOrigins = [
    "https://the-old-schoolhouse.webflow.io",
    "https://www.the-old-schoolhouse.com",
    "https://the-old-schoolhouse.com",
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  // Safari sends this request before the actual POST.
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "POST required",
    });
  }

  try {
    const quoteId = req.query.quoteId;

    const {
      dogs = 0,
      poolHeating = false,
      checkIn,
      checkOut,
    } = req.body || {};

    const dogCount = Number(dogs);

    if (
      !quoteId ||
      !Number.isInteger(dogCount) ||
      dogCount < 0 ||
      dogCount > 2 ||
      typeof poolHeating !== "boolean"
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid extras selection",
      });
    }

    if (
      poolHeating &&
      !poolEligible(checkIn, checkOut)
    ) {
      return res.status(400).json({
        success: false,
        error: "Pool heating unavailable for these dates",
      });
    }

    if (dogCount === 0 && !poolHeating) {
      return res.status(400).json({
        success: false,
        error: "No extras selected",
      });
    }

    const token = await getGuestyToken();

    const quoteUrl =
      "https://booking.guesty.com/api/reservations/quotes/" +
      encodeURIComponent(quoteId);

    // Retrieve the original quote to verify the selected dates.
    const originalResponse = await fetch(quoteUrl, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const original = await originalResponse.json();

    if (!originalResponse.ok) {
      return res.status(originalResponse.status).json({
        success: false,
        stage: "get-quote",
        error: original,
      });
    }

    const actualIn =
      original.checkInDateLocalized || original.checkIn;

    const actualOut =
      original.checkOutDateLocalized || original.checkOut;

    if (
      !actualIn ||
      !actualOut ||
      actualIn.slice(0, 10) !== checkIn ||
      actualOut.slice(0, 10) !== checkOut
    ) {
      return res.status(400).json({
        success: false,
        error: "Quote dates do not match selected dates",
      });
    }

    if (
      poolHeating &&
      !poolEligible(
        actualIn.slice(0, 10),
        actualOut.slice(0, 10)
      )
    ) {
      return res.status(400).json({
        success: false,
        error: "Pool heating outside season",
      });
    }

    const actualPets =
      original.numberOfGuests?.numberOfPets;

    if (
      actualPets !== undefined &&
      Number(actualPets) !== dogCount
    ) {
      return res.status(400).json({
        success: false,
        error: "Quote dog count does not match selection",
      });
    }

    // Identify the selected Guesty optional fees.
    const additionalFeeIds = [];

    if (dogCount) {
      additionalFeeIds.push(DOG_FEE_ID);
    }

    if (poolHeating) {
      additionalFeeIds.push(POOL_FEE_ID);
    }

    // Read the rate-plan ID from this quote rather than
    // relying on a permanently hard-coded value.
    const ratePlanIds = [
      ...new Set(
        (original.rates?.ratePlans || [])
          .map(
            (item) =>
              item.ratePlan?.id ||
              item.ratePlan?._id ||
              item.ratePlanId
          )
          .filter(Boolean)
      ),
    ];

    if (!ratePlanIds.length) {
      return res.status(502).json({
        success: false,
        error: "Guesty quote did not contain a rate-plan ID",
      });
    }

    // Apply the selected optional fees in Guesty.
    const applyResponse = await fetch(
      "https://booking.guesty.com/api/reservations/upsell/" +
        encodeURIComponent(quoteId),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          additionalFeeIds,
          ratePlanIds,
        }),
      }
    );

    const applied = await applyResponse.json();

    if (!applyResponse.ok) {
      return res.status(applyResponse.status).json({
        success: false,
        stage: "apply-upsells",
        error: applied,
      });
    }

    // Fetch the updated quote, including the optional fees.
    const updatedResponse = await fetch(quoteUrl, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const updatedQuote = await updatedResponse.json();

    if (!updatedResponse.ok) {
      return res.status(updatedResponse.status).json({
        success: false,
        stage: "updated-quote",
        error: updatedQuote,
      });
    }

    return res.status(200).json({
      success: true,
      updatedQuote,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
