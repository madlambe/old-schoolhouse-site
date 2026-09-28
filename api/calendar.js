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

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

function getDate(day) {
  return day.date || day.dateLocalized || null;
}

function getReservationInfo(day) {
  const reservation = day.reservation;

  if (!reservation) {
    return null;
  }

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
    checkOut
  };
}

function getManualBlockIds(day) {
  const refs =
    day.blocks &&
    Array.isArray(day.blocks.blockRefs)
      ? day.blocks.blockRefs
      : [];

  return refs
    .filter(ref => {
      const type = ref.type || ref.blockType;
      return type === "m";
    })
    .map(ref =>
      String(
        ref._id ||
        ref.id ||
        ref.blockId ||
        ref.note ||
        ref.reason ||
        ""
      )
    )
    .filter(Boolean);
}

function sanitiseCalendar(data) {
  const rawDays =
    data &&
    data.data &&
    Array.isArray(data.data.days)
      ? data.data.days
      : [];

  const reservations = new Map();
  const manualBlocks = new Map();

  /*
   * First pass:
   * collect only the date boundaries we need.
   */
  rawDays.forEach(day => {
    const date = getDate(day);

    if (!date) {
      return;
    }

    const reservation =
      getReservationInfo(day);

    if (reservation) {
      const key =
        reservation.checkIn +
        "|" +
        reservation.checkOut;

      reservations.set(key, reservation);
    }

    const manualIds =
      getManualBlockIds(day);

    manualIds.forEach(id => {
      if (!manualBlocks.has(id)) {
        manualBlocks.set(id, []);
      }

      manualBlocks.get(id).push(date);
    });
  });

  /*
   * Reservation boundaries.
   */
  const reservationArrivals =
    new Set();

  const reservationDepartures =
    new Set();

  reservations.forEach(reservation => {
    reservationArrivals.add(
      reservation.checkIn
    );

    reservationDepartures.add(
      reservation.checkOut
    );
  });

  /*
   * Manual block boundaries.
   *
   * First day = start of block
   * Day after last blocked night = end of block
   */
  const manualBlockStarts =
    new Set();

  const manualBlockEnds =
    new Set();

  manualBlocks.forEach(dates => {
    const sorted =
      [...new Set(dates)].sort();

    if (!sorted.length) {
      return;
    }

    manualBlockStarts.add(
      sorted[0]
    );

    const last =
      new Date(sorted[sorted.length - 1] + "T12:00:00");

    last.setDate(
      last.getDate() + 1
    );

    const endDate =
      [
        last.getFullYear(),
        String(last.getMonth() + 1).padStart(2, "0"),
        String(last.getDate()).padStart(2, "0")
      ].join("-");

    manualBlockEnds.add(endDate);
  });

  /*
   * Produce a deliberately small public response.
   */
  const days =
    rawDays.map(day => {
      const date =
        getDate(day);

      if (!date) {
        return null;
      }

      const status =
        day.status || "available";

      const isBooked =
        status === "booked";

      const isUnavailable =
        status === "unavailable";

      const hasManualBlock =
        getManualBlockIds(day).length > 0;

      const reservationArrival =
        reservationArrivals.has(date);

      const reservationDeparture =
        reservationDepartures.has(date);

      const manualStart =
        manualBlockStarts.has(date);

      const manualEnd =
        manualBlockEnds.has(date);

      return {
        date,
        status,
        booked: isBooked,
        unavailable: isUnavailable,
        manualBlock: hasManualBlock,
        reservationArrival,
        reservationDeparture,
        manualStart,
        manualEnd
      };
    })
    .filter(Boolean);

  return {
    days
  };
}

module.exports = async function handler(req, res) {

  const allowedOrigins = [
    "https://the-old-schoolhouse.webflow.io",
    "https://www.the-old-schoolhouse.com",
    "https://the-old-schoolhouse.com"
  ];

  const origin =
    req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  res.setHeader(
    "Vary",
    "Origin"
  );

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
      error: "Method not allowed"
    });
  }

  try {
    const {
      startDate,
      endDate
    } = req.query;

    if (
      !validDate(startDate) ||
      !validDate(endDate)
    ) {
      return res.status(400).json({
        success: false,
        error:
          "startDate and endDate are required as YYYY-MM-DD"
      });
    }

    if (endDate < startDate) {
      return res.status(400).json({
        success: false,
        error:
          "endDate must be on or after startDate"
      });
    }

    const token =
      await getOpenApiToken();

    const url =
      `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/${LISTING_ID}` +
      `?startDate=${encodeURIComponent(startDate)}` +
      `&endDate=${encodeURIComponent(endDate)}`;

    const response =
      await fetch(url, {
        headers: {
          Authorization:
            `Bearer ${token}`,
          Accept:
            "application/json"
        }
      });

    const data =
      await response.json();

    if (!response.ok) {
      return res
        .status(response.status)
        .json({
          success: false,
          error:
            "Guesty calendar request failed"
        });
    }

    const calendar =
      sanitiseCalendar(data);

    return res.status(200).json({
      success: true,
      calendar
    });

  } catch (error) {

    console.error(
      "Calendar error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "Calendar availability could not be loaded"
    });
  }
};
