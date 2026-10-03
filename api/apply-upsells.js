import bookingAuth from '../lib/booking-auth.cjs';
const { getBookingToken } = bookingAuth;

const DOG_FEE_ID = "6a9a72c18edf716db60d74bb";
const POOL_FEE_ID = "6a9a761e8edf716db60d8cfc";

function poolEligible(checkIn, checkOut) {
  return /^\d{4}-\d{2}-\d{2}$/.test(checkIn || "") &&
    /^\d{4}-\d{2}-\d{2}$/.test(checkOut || "") &&
    checkIn.slice(0, 4) === checkOut.slice(0, 4) &&
    checkIn.slice(5) >= "04-01" && checkIn.slice(5) <= "09-30" &&
    checkOut.slice(5) > "04-01" && checkOut.slice(5) <= "10-01" &&
    checkIn < checkOut;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "POST required" });
  }

  try {
    const quoteId = req.query.quoteId;
    const { dogs = 0, poolHeating = false, checkIn, checkOut } = req.body || {};
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
        error: "Invalid extras selection"
      });
    }

    if (poolHeating && !poolEligible(checkIn, checkOut)) {
      return res.status(400).json({
        success: false,
        error: "Pool heating unavailable for these dates"
      });
    }

    if (dogCount === 0 && !poolHeating) {
      return res.status(400).json({
        success: false,
        error: "No extras selected"
      });
    }

    const token = await getBookingToken();

    const quoteUrl =
      `https://booking.guesty.com/api/reservations/quotes/${encodeURIComponent(quoteId)}`;

    const originalResponse = await fetch(quoteUrl, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    });

    const original = await originalResponse.json();

    if (!originalResponse.ok) {
      return res.status(originalResponse.status).json({
        success: false,
        stage: "get-quote",
        error: original
      });
    }

    const actualIn =
      original.checkInDateLocalized ||
      original.checkIn;

    const actualOut =
      original.checkOutDateLocalized ||
      original.checkOut;

    if (
      !actualIn ||
      !actualOut ||
      actualIn.slice(0, 10) !== checkIn ||
      actualOut.slice(0, 10) !== checkOut
    ) {
      return res.status(400).json({
        success: false,
        error: "Quote dates do not match selected dates"
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
        error: "Pool heating outside season"
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
        error: "Quote dog count does not match selection"
      });
    }

    /*
     * Read the actual rate-plan context from the Guesty quote
     * rather than hard-coding a rate-plan ID.
     */
    const ratePlanEntry =
      original.rates?.ratePlans?.find(
        entry => !entry.notApplicable
      ) ||
      original.rates?.ratePlans?.[0];

    const ratePlan =
      ratePlanEntry?.ratePlan || {};

    const ratePlanId =
      ratePlan._id ||
      ratePlan.id;

    const inquiryId =
      ratePlan.inquiryId ||
      ratePlanEntry?.inquiryId;

    const listingId =
      original.listingId ||
      original.unitTypeId ||
      original.unitId;

    if (!ratePlanId || !inquiryId || !listingId) {
      return res.status(502).json({
        success: false,
        stage: "quote-context",
        error:
          "Guesty quote did not provide the rate-plan context required for upsells"
      });
    }

    /*
     * Retrieve the upsells available for this exact
     * inquiry/listing before applying them.
     */
    const availableResponse = await fetch(
      `https://booking.guesty.com/api/reservations/upsell/` +
      `${encodeURIComponent(inquiryId)}/` +
      `${encodeURIComponent(listingId)}/fee`,
      {
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      }
    );

    const availableUpsells =
      await availableResponse.json();

    if (!availableResponse.ok) {
      return res.status(availableResponse.status).json({
        success: false,
        stage: "get-upsells",
        error: availableUpsells
      });
    }

    const availableIds = new Set(
      Array.isArray(availableUpsells)
        ? availableUpsells
            .map(fee => fee && fee._id)
            .filter(Boolean)
        : []
    );

    if (
      dogCount > 0 &&
      !availableIds.has(DOG_FEE_ID)
    ) {
      return res.status(400).json({
        success: false,
        stage: "validate-upsells",
        error:
          "Dog fee is not available for this Booking Engine API quote"
      });
    }

    if (
      poolHeating &&
      !availableIds.has(POOL_FEE_ID)
    ) {
      return res.status(400).json({
        success: false,
        stage: "validate-upsells",
        error:
          "Pool-heating fee is not available for this Booking Engine API quote"
      });
    }

    /*
     * Guesty represents quantity by repeating the same
     * additional-fee ID.
     */
    const additionalFeeIds = [];

    for (let i = 0; i < dogCount; i++) {
      additionalFeeIds.push(DOG_FEE_ID);
    }

    if (poolHeating) {
      additionalFeeIds.push(POOL_FEE_ID);
    }

    /*
     * Apply the selected upsells to the existing quote.
     */
    const applyResponse = await fetch(
      `https://booking.guesty.com/api/reservations/upsell/${encodeURIComponent(quoteId)}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          additionalFeeIds,
          ratePlanIds: [ratePlanId]
        })
      }
    );

    const applied =
      await applyResponse.json();

    if (!applyResponse.ok) {
      return res.status(applyResponse.status).json({
        success: false,
        stage: "apply-upsells",
        error: applied
      });
    }

    /*
     * Retrieve the updated quote so the website uses
     * Guesty's actual recalculated total.
     */
    const updatedResponse = await fetch(
      quoteUrl,
      {
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      }
    );

    const updatedQuote =
      await updatedResponse.json();

    if (!updatedResponse.ok) {
      return res.status(updatedResponse.status).json({
        success: false,
        stage: "updated-quote",
        error: updatedQuote
      });
    }

    return res.status(200).json({
      success: true,
      updatedQuote
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      errorCode: "BOOKING_SERVICE_UNAVAILABLE"
    });
  }
}
