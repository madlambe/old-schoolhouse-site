
const { getBookingToken } = require('../lib/booking-auth.cjs');

const ALLOWED_ORIGINS = [
  'https://the-old-schoolhouse.webflow.io',
  'https://www.the-old-schoolhouse.com',
  'https://the-old-schoolhouse.com',
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function cleanString(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '');
}

function upper(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function guestyRequestId(response) {
  return response.headers.get('x-request-id') ||
    response.headers.get('x-guesty-request-id') || null;
}

function verifiedResult(data) {
  const reservation = data?.reservation || {};
  const payment = data?.payment || {};

  const reservationId = pickString(
    reservation._id, reservation.id, data?.reservationId, data?._id
  );
  const confirmationCode = pickString(
    reservation.confirmationCode, data?.confirmationCode
  );

  // Require explicit payment and reservation confirmation.
  // An HTTP 200 response alone is not sufficient.
  const reservationStatus = upper(
    reservation.status || data?.reservationStatus
  );
  const paymentStatus = upper(
    payment.status || data?.paymentStatus
  );

  const reservationConfirmed = [
    'CONFIRMED',
    'RESERVED'
  ].includes(reservationStatus);

  const paymentSucceeded = [
    'SUCCEEDED',
    'SUCCESS',
    'PAID',
    'CAPTURED',
    'COMPLETED'
  ].includes(paymentStatus);

  const needsAuthentication = [
    'PENDING_AUTH',
    'REQUIRES_ACTION',
    'REQUIRES_AUTHENTICATION'
  ].includes(upper(data?.status)) || [
    'PENDING_AUTH',
    'REQUIRES_ACTION',
    'REQUIRES_AUTHENTICATION'
  ].includes(paymentStatus);

  return {
    reservationId,
    confirmationCode,
    reservationStatus: reservationStatus || null,
    paymentStatus: paymentStatus || null,
    needsAuthentication,
    verified: Boolean(
      reservationId &&
      confirmationCode &&
      reservationConfirmed &&
      paymentSucceeded
    ),
  };
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      errorCode: 'METHOD_NOT_ALLOWED'
    });
  }

  // LIVE PAYMENT SAFETY SWITCH
  //
  // Live payments remain disabled unless the Vercel
  // environment variable ENABLE_LIVE_INSTANT_CHARGE
  // is explicitly set to the string 'true'.
  //
  // Do not enable until integration testing is complete.

  if (process.env.ENABLE_LIVE_INSTANT_CHARGE !== 'true') {
    return res.status(503).json({
      success: false,
      errorCode: 'LIVE_CHECKOUT_DISABLED',
      message: 'Live payments are not enabled.',
    });
  }

  const origin = req.headers.origin;

  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({
      success: false,
      errorCode: 'ORIGIN_NOT_ALLOWED'
    });
  }

  const {
    quoteId,
    ratePlanId,
    confirmationToken,
    guest
  } = req.body || {};

  const safeQuoteId = cleanString(quoteId, 100);
  const safeRatePlanId = cleanString(ratePlanId, 100);
  const safeConfirmationToken = cleanString(
    confirmationToken, 200
  );

  const firstName = cleanString(guest?.firstName, 100);
  const lastName = cleanString(guest?.lastName, 100);
  const email = cleanString(guest?.email, 254);
  const phone = cleanString(guest?.phone, 50);

  if (!safeQuoteId) {
    return res.status(400).json({
      success: false,
      errorCode: 'MISSING_QUOTE_ID'
    });
  }

  if (!safeRatePlanId) {
    return res.status(400).json({
      success: false,
      errorCode: 'MISSING_RATE_PLAN_ID'
    });
  }

  if (!safeConfirmationToken.startsWith('ctoken_')) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_CONFIRMATION_TOKEN'
    });
  }

  if (!firstName || !lastName || !validEmail(email)) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_GUEST_DETAILS'
    });
  }

  try {
    const token = await getBookingToken();

    const guestyResponse = await fetch(
      `https://booking.guesty.com/api/reservations/quotes/${encodeURIComponent(
        safeQuoteId
      )}/instant-charge`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json; charset=utf-8',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ratePlanId: safeRatePlanId,
          confirmationToken: safeConfirmationToken,

          // Request retention of the payment method
          // for future balance collection.
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

    const requestId = guestyRequestId(guestyResponse);
    const raw = await guestyResponse.text();

    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    const result = verifiedResult(data);

    if (!guestyResponse.ok) {
      console.error('Guesty instant-charge rejected', {
        httpStatus: guestyResponse.status,
        requestId,
        guestyCode: data?.error?.code || data?.code || null,
      });

      return res.status(502).json({
        success: false,
        errorCode: 'PAYMENT_OR_RESERVATION_FAILED',
        requiresVerification: result.needsAuthentication,
        requestId,
      });
    }

    if (result.needsAuthentication) {
      return res.status(200).json({
        success: false,
        errorCode: 'ADDITIONAL_AUTHENTICATION_REQUIRED',
        requiresVerification: true,
        requestId,
      });
    }

    if (!result.verified) {
      // Guesty might already have charged the card
      // or created a reservation.
      //
      // Do not tell the guest to retry until the
      // transaction has been reconciled.

      console.error(
        'Guesty instant-charge response needs reconciliation',
        {
          requestId,
          hasReservationId: Boolean(result.reservationId),
          hasConfirmationCode: Boolean(result.confirmationCode),
          reservationStatus: result.reservationStatus,
          paymentStatus: result.paymentStatus,
          responseKeys: Object.keys(data || {}),
        }
      );

      return res.status(200).json({
        success: false,
        errorCode: 'BOOKING_STATUS_UNVERIFIED',
        requiresVerification: true,
        doNotRetry: true,
        requestId,
      });
    }

    // Only return success when both payment and
    // reservation have been explicitly verified.

    return res.status(200).json({
      success: true,
      paymentVerified: true,
      reservationVerified: true,
      requiresVerification: false,
      reservationId: result.reservationId,
      confirmationCode: result.confirmationCode,
      requestId,
    });

  } catch (error) {
    console.error('Instant-charge request failed', {
      name: error?.name || 'Error',
      message: error?.message || 'Unknown error',
    });

    return res.status(503).json({
      success: false,
      errorCode: 'BOOKING_STATUS_UNKNOWN',
      requiresVerification: true,
      doNotRetry: true,
    });
  }
};
