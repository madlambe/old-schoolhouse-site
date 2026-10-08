const { getBookingToken } = require('../lib/booking-auth.cjs');

const ALLOWED_ORIGINS = [
  "https://the-old-schoolhouse.webflow.io",
  "https://www.the-old-schoolhouse.com",
  "https://the-old-schoolhouse.com",
];

function setCors(req, res) {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function cleanString(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      errorCode: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const {
      quoteId,
      ratePlanId,
      confirmationToken,
      guest,
    } = req.body || {};

    // --------------------------------------------------
    // Validate the booking identifiers
    // --------------------------------------------------

    if (!cleanString(quoteId, 100)) {
      return res.status(400).json({
        success: false,
        errorCode: "MISSING_QUOTE_ID",
      });
    }

    if (!cleanString(ratePlanId, 100)) {
      return res.status(400).json({
        success: false,
        errorCode: "MISSING_RATE_PLAN_ID",
      });
    }

    if (
      !cleanString(confirmationToken, 200) ||
      !String(confirmationToken).startsWith("ctoken_")
    ) {
      return res.status(400).json({
        success: false,
        errorCode: "INVALID_CONFIRMATION_TOKEN",
      });
    }

    // --------------------------------------------------
    // Validate guest details
    // --------------------------------------------------

    const firstName = cleanString(guest?.firstName, 100);
    const lastName = cleanString(guest?.lastName, 100);
    const email = cleanString(guest?.email, 254);
    const phone = cleanString(guest?.phone, 50);

    if (!firstName || !lastName || !validEmail(email)) {
      return res.status(400).json({
        success: false,
        errorCode: "INVALID_GUEST_DETAILS",
      });
    }

    // --------------------------------------------------
    // Authenticate with Guesty Booking Engine API
    // --------------------------------------------------

    const token = await getBookingToken();

    // --------------------------------------------------
    // Create reservation ONLY if Guesty successfully
    // charges the Stripe Confirmation Token.
    //
    // Guesty calculates/controls the amount from the quote
    // and selected rate plan. We deliberately do NOT accept
    // a payment amount supplied by the browser.
    // --------------------------------------------------

    const guestyResponse = await fetch(
      `https://booking.guesty.com/api/reservations/quotes/${encodeURIComponent(
        quoteId
      )}/instant-charge`,
      {
        method: "POST",
        headers: {
          Accept: "application/json; charset=utf-8",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ratePlanId,
          confirmationToken,

          // Allows Guesty to retain the payment method so
          // the later balance can be collected automatically.
          reuse: true,

          guest: {
            firstName,
            lastName,
            email,
            ...(phone ? { phone } : {}),
          },
        }),
      }
    );

    const responseText = await guestyResponse.text();

    let data;

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = {
        rawResponse: responseText,
      };
    }

    // --------------------------------------------------
    // Payment/reservation failed
    // --------------------------------------------------

    if (!guestyResponse.ok) {
      console.error(
        "Guesty instant-charge error:",
        guestyResponse.status,
        data
      );

      return res.status(guestyResponse.status).json({
        success: false,
        errorCode:
          data?.error?.code ||
          data?.code ||
          "PAYMENT_OR_RESERVATION_FAILED",
        requiresVerification:
          data?.status === "PENDING_AUTH" ||
          data?.payment?.status === "PENDING_AUTH",
        guestyStatus:
          data?.status ||
          data?.payment?.status ||
          null,
        details: data,
      });
    }

    // --------------------------------------------------
    // Guesty accepted the charge/reservation
    // --------------------------------------------------

    const guestyStatus =
      data?.status ||
      data?.payment?.status ||
      data?.reservation?.status ||
      null;

    // Do not tell the browser the booking is complete if
    // Guesty says further card authentication is required.
    if (guestyStatus === "PENDING_AUTH") {
      return res.status(200).json({
        success: false,
        requiresVerification: true,
        guestyStatus,
        data,
      });
    }

    return res.status(200).json({
      success: true,
      requiresVerification: false,
      reservationId:
        data?._id ||
        data?.reservationId ||
        data?.reservation?._id ||
        null,
      confirmationCode:
        data?.confirmationCode ||
        data?.reservation?.confirmationCode ||
        null,
      data,
    });

  } catch (error) {
    console.error("Instant charge request error:", error);

    return res.status(500).json({
      success: false,
      errorCode: "BOOKING_SERVICE_UNAVAILABLE",
    });
  }
};
