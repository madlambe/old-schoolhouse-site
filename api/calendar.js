const LISTING_ID = "6a9971cb2e53cb00111b27da";

const TOKEN_KEY = "guesty:open-api:access-token";

/* -------------------------------------------------------
   UPSTASH
------------------------------------------------------- */

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
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      `Upstash request failed: ${data.error || response.status}`
    );
  }

  return data.result;
}


/* -------------------------------------------------------
   GUESTY OPEN API TOKEN
------------------------------------------------------- */

async function getOpenApiToken() {

  /*
   * First try the persistent token stored in Upstash.
   */

  const cachedToken = await redisCommand([
    "GET",
    TOKEN_KEY
  ]);

  if (cachedToken) {
    return cachedToken;
  }


  /*
   * Only request a new Guesty token if Redis
   * genuinely does not contain one.
   */

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
      `Guesty authentication failed: ${response.status}`
    );
  }


  /*
   * Guesty Open API tokens normally last 24 hours.
   * Store slightly less than the actual expiry so
   * we never try to use an expired token.
   */

  const expiresIn =
    Math.max(
      60,
      (data.expires_in || 86400) - 600
    );

  await redisCommand([
    "SET",
    TOKEN_KEY,
    data.access_token,
    "EX",
    expiresIn
  ]);

  return data.access_token;
}


/* -------------------------------------------------------
   HELPERS
------------------------------------------------------- */

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


/*
 * Guesty can represent blocks in several ways.
 * We retain ONLY the block TYPES.
 *
 * We deliberately do not return:
 * guest names
 * emails
 * phone numbers
 * reservation IDs
 * notes
 * prices
 * confirmation codes
 * creator details
 */

function getBlockTypes(day) {

  const types = new Set();

  const blocks = day.blocks || {};


  /*
   * Boolean block flags returned by Guesty.
   */

  [
    "m",
    "b",
    "r",
    "an",
    "abl",
    "a",
    "o"
  ].forEach(type => {

    if (blocks[type] === true) {
      types.add(type);
    }

  });


  /*
   * Also inspect blockRefs, where available.
   */

  const refs =
    Array.isArray(blocks.blockRefs)
      ? blocks.blockRefs
      : [];

  refs.forEach(ref => {

    const type =
      ref.type ||
      ref.blockType;

    if (type) {
      types.add(String(type));
    }

  });

  return Array.from(types);
}


/* -------------------------------------------------------
   SANITISE GUESTY CALENDAR
------------------------------------------------------- */

function sanitiseCalendar(data) {

  /*
   * Guesty responses can wrap days differently.
   * Support the shapes we've encountered without
   * exposing the original response publicly.
   */

  let rawDays = [];

  if (
    data &&
    data.data &&
    Array.isArray(data.data.days)
  ) {

    rawDays = data.data.days;

  } else if (
    data &&
    Array.isArray(data.data)
  ) {

    rawDays = data.data;

  } else if (
    data &&
    Array.isArray(data.days)
  ) {

    rawDays = data.days;
  }


  /*
   * Build reservation boundaries.
   */

  const reservations = new Map();

  rawDays.forEach(day => {

    const reservation =
      getReservationInfo(day);

    if (!reservation) {
      return;
    }

    const key =
      reservation.checkIn +
      "|" +
      reservation.checkOut;

    reservations.set(
      key,
      reservation
    );
  });


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
   * Return ONLY the fields the Webflow calendar
   * actually needs.
   */

  const days =
    rawDays
      .map(day => {

        const date =
          getDate(day);

        if (!date) {
          return null;
        }

        const status =
          String(
            day.status || "available"
          ).toLowerCase();

        const blockTypes =
          getBlockTypes(day);

        const booked =
          status === "booked";

        const reserved =
          status === "reserved";

        const unavailable =
          status === "unavailable";

        const reservationArrival =
          reservationArrivals.has(date);

        const reservationDeparture =
          reservationDepartures.has(date);


        /*
         * HARD BLOCK
         *
         * If Guesty says unavailable, that always
         * takes precedence over half-day styling.
         *
         * This fixes 10 November.
         */

        const hardBlocked =
          unavailable;


        /*
         * OVERLAPPING BLOCK
         *
         * More than one Guesty block type on a date
         * means the date should not be represented
         * as a simple reservation changeover.
         *
         * This is what we need for dates such as
         * 3 November where another Guesty block
         * overlaps the reservation arrival.
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
          blockTypes
        };

      })
      .filter(Boolean);


  return {
    days
  };
}


/* -------------------------------------------------------
   VERCEL HANDLER
------------------------------------------------------- */

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


  /*
   * Five-minute calendar cache.
   */

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
      await fetch(
        url,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,
            Accept:
              "application/json"
          }
        }
      );


    const data =
      await response.json();


    /*
     * If the stored token has unexpectedly become
     * invalid, remove it so the NEXT request can
     * obtain a fresh token.
     */

    if (
      response.status === 401 ||
      response.status === 403
    ) {

      await redisCommand([
        "DEL",
        TOKEN_KEY
      ]);

      return res.status(503).json({
        success: false,
        error:
          "Guesty authentication is being refreshed. Please try again."
      });
    }


    if (!response.ok) {

      console.error(
        "Guesty calendar request failed:",
        response.status
      );

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

  }

  catch (error) {

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
