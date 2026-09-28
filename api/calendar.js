const LISTING_ID = "6a9971cb2e53cb00111b27da";
const TOKEN_KEY = "guesty:open-api:access-token";

/* ======================================================
   UPSTASH REDIS
====================================================== */

async function redisCommand(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error("Upstash environment variables are missing");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Upstash returned an invalid response: ${text}`);
  }

  if (!response.ok || data.error) {
    throw new Error(
      `Upstash request failed: ${data.error || response.status}`
    );
  }

  return data.result;
}


/* ======================================================
   GUESTY OPEN API AUTHENTICATION
====================================================== */

async function getOpenApiToken() {
  const cachedToken = await redisCommand([
    "GET",
    TOKEN_KEY,
  ]);

  if (cachedToken) {
    return cachedToken;
  }

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

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Guesty authentication returned an invalid response: ${text}`
    );
  }

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Guesty authentication failed: ${response.status} ${text}`
    );
  }

  /*
   * Guesty Open API tokens are long-lived.
   * Store the token slightly less than its stated lifetime.
   */
  const expiresIn = Math.max(
    60,
    Number(data.expires_in || 86400) - 600
  );

  await redisCommand([
    "SET",
    TOKEN_KEY,
    data.access_token,
    "EX",
    String(expiresIn),
  ]);

  return data.access_token;
}


/* ======================================================
   HELPERS
====================================================== */

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}


function getDate(day) {
  if (!day || typeof day !== "object") {
    return null;
  }

  return (
    day.date ||
    day.dateLocalized ||
    day.date_localized ||
    null
  );
}


function getReservationInfo(day) {
  if (!day || !day.reservation) {
    return null;
  }

  const reservation = day.reservation;

  const checkIn =
    reservation.checkInDateLocalized ||
    reservation.checkIn ||
    null;

  const checkOut =
    reservation.checkOutDateLocalized ||
    reservation.checkOut ||
    null;

  if (!checkIn || !checkOut) {
    return null;
  }

  return {
    checkIn,
    checkOut,
  };
}


/*
 * Extract ONLY safe Guesty block-type information.
 * No guest names, emails, notes, prices or IDs
 * are returned to the website.
 */
function getBlockTypes(day) {
  const types = new Set();

  if (!day || typeof day !== "object") {
    return [];
  }

  const blocks =
    day.blocks && typeof day.blocks === "object"
      ? day.blocks
      : {};

  Object.entries(blocks).forEach(([key, value]) => {
    if (value === true) {
      types.add(key);
    }
  });

  const possibleRefs = [
    blocks.blockRefs,
    blocks.refs,
    day.blockRefs,
  ];

  possibleRefs.forEach((refs) => {
    if (!Array.isArray(refs)) {
      return;
    }

    refs.forEach((ref) => {
      if (!ref || typeof ref !== "object") {
        return;
      }

      const type =
        ref.type ||
        ref.blockType ||
        ref.block_type;

      if (type) {
        types.add(String(type));
      }
    });
  });

  return Array.from(types);
}


/* ======================================================
   SANITISE GUESTY CALENDAR
====================================================== */

function sanitiseCalendar(data) {
  let rawDays = [];

  if (data && data.data && Array.isArray(data.data.days)) {
    rawDays = data.data.days;
  } else if (data && Array.isArray(data.data)) {
    rawDays = data.data;
  } else if (data && Array.isArray(data.days)) {
    rawDays = data.days;
  } else if (Array.isArray(data)) {
    rawDays = data;
  }

  const reservationArrivals = new Set();
  const reservationDepartures = new Set();

  rawDays.forEach((day) => {
    const reservation = getReservationInfo(day);

    if (!reservation) {
      return;
    }

    reservationArrivals.add(reservation.checkIn);
    reservationDepartures.add(reservation.checkOut);
  });

  const days = rawDays
    .map((day) => {
      const date = getDate(day);

      if (!date) {
        return null;
      }

      const status = String(
        day.status || "available"
      ).toLowerCase();

      const blockTypes = getBlockTypes(day);

      const booked = status === "booked";
      const reserved = status === "reserved";
      const unavailable = status === "unavailable";

      const reservationArrival =
        reservationArrivals.has(date);

      const reservationDeparture =
        reservationDepartures.has(date);

      /*
       * An explicitly unavailable Guesty day takes
       * precedence over half-day changeover styling.
       */
      const hardBlocked = unavailable;

      /*
       * Multiple block types indicate overlapping
       * Guesty restrictions on the same date.
       */
      const overlappingBlock =
        blockTypes.length > 1;

      return {
        date,
        status,
        booked,
        reserved,
        unavailable,
        hardBlocked,
        overlappingBlock,
        reservationArrival,
        reservationDeparture,
        blockTypes,
      };
    })
    .filter(Boolean);

  return { days };
}


/* ======================================================
   VERCEL SERVERLESS FUNCTION
====================================================== */

module.exports = async function handler(req, res) {
  const allowedOrigins = [
    "https://the-old-schoolhouse.webflow.io",
    "https://www.the-old-schoolhouse.com",
    "https://the-old-schoolhouse.com",
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  res.setHeader("Vary", "Origin");

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=60"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    const { startDate, endDate } = req.query;

    if (
      !validDate(startDate) ||
      !validDate(endDate)
    ) {
      return res.status(400).json({
        success: false,
        error:
          "startDate and endDate are required as YYYY-MM-DD",
      });
    }

    if (endDate < startDate) {
      return res.status(400).json({
        success: false,
        error:
          "endDate must be on or after startDate",
      });
    }

    const token = await getOpenApiToken();

    const guestyUrl =
      `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/${LISTING_ID}` +
      `?startDate=${encodeURIComponent(startDate)}` +
      `&endDate=${encodeURIComponent(endDate)}`;

    const response = await fetch(guestyUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const responseText = await response.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Guesty calendar returned an invalid response: ${responseText}`
      );
    }

    if (
      response.status === 401 ||
      response.status === 403
    ) {
      await redisCommand([
        "DEL",
        TOKEN_KEY,
      ]);

      throw new Error(
        `Guesty calendar authentication failed: ${response.status}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Guesty calendar request failed: ${response.status} ${responseText}`
      );
    }

    const calendar = sanitiseCalendar(data);

    return res.status(200).json({
      success: true,
      calendar,
    });
  } catch (error) {
    console.error("Calendar error:", error);

    /*
     * TEMPORARY debugging response.
     * This lets us identify the exact problem.
     * It does NOT expose the Guesty or Upstash secrets.
     */
    return res.status(500).json({
      success: false,
      error:
        error && error.message
          ? error.message
          : "Unknown calendar error",
    });
  }
};
