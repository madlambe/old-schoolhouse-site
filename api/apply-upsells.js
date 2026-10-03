import bookingAuth from '../lib/booking-auth.cjs';
const { getBookingToken } = bookingAuth;

const DOG_FEE_ID = "6a9a72c18edf716db60d74bb";
const POOL_FEE_ID = "6a9a761e8edf716db60d8cfc";

function poolEligible(checkIn, checkOut) {
  return /^\d{4}-\d{2}-\d{2}$/.test(checkIn || "") &&
    /^\d{4}-\d{2}-\d{2}$/.test(checkOut || "") &&
    checkIn.slice(0, 4) === checkOut.slice(0, 4) &&
    checkIn.slice(5) >= "04-01" &&
    checkIn.slice(5) <= "09-30" &&
    checkOut.slice(5) > "04-01" &&
    checkOut.slice(5) <= "10-01" &&
    checkIn < checkOut;
}

function log(stage, data = {}) {
  console.log(
    "[TOSH UPSELL DEBUG]",
    stage,
    JSON.stringify(data)
  );
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "POST required"
    });
  }

  try {

    const quoteId = req.query.quoteId;

    const {
      dogs = 0,
      poolHeating = false,
      checkIn,
      checkOut
    } = req.body || {};

    const dogCount = Number(dogs);

    log("REQUEST RECEIVED", {
      hasQuoteId: Boolean(quoteId),
      dogs: dogCount,
      poolHeating,
      checkIn,
      checkOut
    });

    if (
      !quoteId ||
      !Number.isInteger(dogCount) ||
      dogCount < 0 ||
      dogCount > 2 ||
      typeof poolHeating !== "boolean"
    ) {

      log("INVALID REQUEST", {
        hasQuoteId: Boolean(quoteId),
        dogs: dogCount,
        poolHeatingType: typeof poolHeating
      });

      return res.status(400).json({
        success: false,
        stage: "validation",
        error: "Invalid extras selection"
      });
    }


    if (
      poolHeating &&
      !poolEligible(checkIn, checkOut)
    ) {

      log("POOL DATE VALIDATION FAILED", {
        checkIn,
        checkOut
      });

      return res.status(400).json({
        success: false,
        stage: "pool-validation",
        error: "Pool heating unavailable for these dates"
      });
    }


    if (
      dogCount === 0 &&
      !poolHeating
    ) {

      return res.status(400).json({
        success: false,
        stage: "validation",
        error: "No extras selected"
      });
    }


    /*
     * GET GUESTY TOKEN
     */

    log("GETTING GUESTY TOKEN");

    const token = await getBookingToken();

    log("GUESTY TOKEN OK");


    /*
     * GET ORIGINAL QUOTE
     */

    const quoteUrl =
      `https://booking.guesty.com/api/reservations/quotes/${encodeURIComponent(quoteId)}`;

    log("GETTING ORIGINAL QUOTE");

    const originalResponse =
      await fetch(
        quoteUrl,
        {
          headers: {
            accept: "application/json",
            Authorization: `Bearer ${token}`
          }
        }
      );

    const originalText =
      await originalResponse.text();

    let original;

    try {
      original =
        originalText
          ? JSON.parse(originalText)
          : {};
    }
    catch {
      original = {
        rawResponse: originalText.slice(0, 500)
      };
    }

    log("ORIGINAL QUOTE RESPONSE", {
      status: originalResponse.status,
      ok: originalResponse.ok,
      topLevelKeys:
        original &&
        typeof original === "object"
          ? Object.keys(original)
          : []
    });


    if (!originalResponse.ok) {

      log("GET QUOTE FAILED", {
        status: originalResponse.status,
        response: original
      });

      return res.status(originalResponse.status).json({
        success: false,
        stage: "get-quote",
        error: original
      });
    }


    /*
     * VALIDATE QUOTE DATES
     */

    const actualIn =
      original.checkInDateLocalized ||
      original.checkIn;

    const actualOut =
      original.checkOutDateLocalized ||
      original.checkOut;

    log("QUOTE DATES", {
      requestedCheckIn: checkIn,
      requestedCheckOut: checkOut,
      guestyCheckIn: actualIn,
      guestyCheckOut: actualOut
    });


    if (
      !actualIn ||
      !actualOut ||
      actualIn.slice(0, 10) !== checkIn ||
      actualOut.slice(0, 10) !== checkOut
    ) {

      log("QUOTE DATE MISMATCH");

      return res.status(400).json({
        success: false,
        stage: "quote-dates",
        error:
          "Quote dates do not match selected dates"
      });
    }


    if (
      poolHeating &&
      !poolEligible(
        actualIn.slice(0, 10),
        actualOut.slice(0, 10)
      )
    ) {

      log("POOL SEASON CHECK FAILED");

      return res.status(400).json({
        success: false,
        stage: "pool-season",
        error: "Pool heating outside season"
      });
    }


    /*
     * CHECK PET COUNT
     */

    const actualPets =
      original.numberOfGuests?.numberOfPets;

    log("PET COUNT", {
      selectedDogs: dogCount,
      guestyPets: actualPets
    });


    if (
      actualPets !== undefined &&
      Number(actualPets) !== dogCount
    ) {

      log("PET COUNT MISMATCH", {
        selectedDogs: dogCount,
        guestyPets: actualPets
      });

      return res.status(400).json({
        success: false,
        stage: "pet-count",
        error:
          "Quote dog count does not match selection"
      });
    }


    /*
     * FIND RATE PLAN / INQUIRY / LISTING
     */

    const ratePlans =
      original.rates?.ratePlans;

    log("RATE PLAN ARRAY", {
      isArray: Array.isArray(ratePlans),
      count:
        Array.isArray(ratePlans)
          ? ratePlans.length
          : 0
    });


    const ratePlanEntry =
      Array.isArray(ratePlans)
        ? (
            ratePlans.find(
              entry => !entry.notApplicable
            ) ||
            ratePlans[0]
          )
        : null;


    const ratePlan =
      ratePlanEntry?.ratePlan || {};


    const ratePlanId =
      ratePlan._id ||
      ratePlan.id ||
      null;


    const inquiryId =
      ratePlan.inquiryId ||
      ratePlanEntry?.inquiryId ||
      original.inquiryId ||
      null;


    const listingId =
      original.listingId ||
      original.unitTypeId ||
      original.unitId ||
      null;


    log("QUOTE CONTEXT", {
      ratePlanId,
      inquiryId,
      listingId,
      ratePlanEntryKeys:
        ratePlanEntry &&
        typeof ratePlanEntry === "object"
          ? Object.keys(ratePlanEntry)
          : [],
      ratePlanKeys:
        ratePlan &&
        typeof ratePlan === "object"
          ? Object.keys(ratePlan)
          : []
    });


    if (
      !ratePlanId ||
      !inquiryId ||
      !listingId
    ) {

      log("QUOTE CONTEXT FAILED", {
        hasRatePlanId: Boolean(ratePlanId),
        hasInquiryId: Boolean(inquiryId),
        hasListingId: Boolean(listingId)
      });

      return res.status(502).json({
        success: false,
        stage: "quote-context",
        error:
          "Guesty quote did not provide the rate-plan context required for upsells"
      });
    }


    /*
     * GET AVAILABLE UPSELLS
     */

    const availableUrl =
      `https://booking.guesty.com/api/reservations/upsell/` +
      `${encodeURIComponent(inquiryId)}/` +
      `${encodeURIComponent(listingId)}/fee`;


    log("GETTING AVAILABLE UPSELLS", {
      inquiryId,
      listingId
    });


    const availableResponse =
      await fetch(
        availableUrl,
        {
          headers: {
            accept: "application/json",
            Authorization: `Bearer ${token}`
          }
        }
      );


    const availableText =
      await availableResponse.text();

    let availableUpsells;

    try {
      availableUpsells =
        availableText
          ? JSON.parse(availableText)
          : [];
    }
    catch {
      availableUpsells = {
        rawResponse:
          availableText.slice(0, 500)
      };
    }


    log("AVAILABLE UPSELL RESPONSE", {
      status: availableResponse.status,
      ok: availableResponse.ok,
      isArray:
        Array.isArray(availableUpsells),
      count:
        Array.isArray(availableUpsells)
          ? availableUpsells.length
          : null,
      feeIds:
        Array.isArray(availableUpsells)
          ? availableUpsells
              .map(fee => fee?._id)
              .filter(Boolean)
          : []
    });


    if (!availableResponse.ok) {

      log("GET UPSELLS FAILED", {
        status: availableResponse.status,
        response: availableUpsells
      });

      return res
        .status(availableResponse.status)
        .json({
          success: false,
          stage: "get-upsells",
          error: availableUpsells
        });
    }


    /*
     * CHECK OUR FEE IDs ARE AVAILABLE
     */

    const availableIds =
      new Set(
        Array.isArray(availableUpsells)
          ? availableUpsells
              .map(fee => fee && fee._id)
              .filter(Boolean)
          : []
      );


    log("CHECKING FEE IDS", {
      dogFeeWanted:
        dogCount > 0
          ? DOG_FEE_ID
          : null,
      poolFeeWanted:
        poolHeating
          ? POOL_FEE_ID
          : null,
      availableFeeIds:
        Array.from(availableIds)
    });


    if (
      dogCount > 0 &&
      !availableIds.has(DOG_FEE_ID)
    ) {

      log("DOG FEE NOT AVAILABLE", {
        dogFeeId: DOG_FEE_ID,
        availableFeeIds:
          Array.from(availableIds)
      });

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

      log("POOL FEE NOT AVAILABLE", {
        poolFeeId: POOL_FEE_ID,
        availableFeeIds:
          Array.from(availableIds)
      });

      return res.status(400).json({
        success: false,
        stage: "validate-upsells",
        error:
          "Pool-heating fee is not available for this Booking Engine API quote"
      });
    }


    /*
     * BUILD UPSELL REQUEST
     */

    const additionalFeeIds = [];


    for (
      let i = 0;
      i < dogCount;
      i++
    ) {
      additionalFeeIds.push(
        DOG_FEE_ID
      );
    }


    if (poolHeating) {
      additionalFeeIds.push(
        POOL_FEE_ID
      );
    }


    const applyPayload = {
      additionalFeeIds,
      ratePlanIds: [
        ratePlanId
      ]
    };


    log("APPLYING UPSELLS", {
      additionalFeeIds,
      ratePlanIds:
        applyPayload.ratePlanIds
    });


    /*
     * APPLY UPSELLS
     */

    const applyResponse =
      await fetch(
        `https://booking.guesty.com/api/reservations/upsell/${encodeURIComponent(quoteId)}`,
        {
          method: "POST",

          headers: {
            accept: "application/json",
            "content-type":
              "application/json",
            Authorization:
              `Bearer ${token}`
          },

          body:
            JSON.stringify(
              applyPayload
            )
        }
      );


    const appliedText =
      await applyResponse.text();

    let applied;

    try {
      applied =
        appliedText
          ? JSON.parse(appliedText)
          : {};
    }
    catch {
      applied = {
        rawResponse:
          appliedText.slice(0, 500)
      };
    }


    log("APPLY UPSELL RESPONSE", {
      status:
        applyResponse.status,
      ok:
        applyResponse.ok,
      response:
        applied
    });


    if (!applyResponse.ok) {

      return res
        .status(applyResponse.status)
        .json({
          success: false,
          stage: "apply-upsells",
          error: applied
        });
    }


    /*
     * GET UPDATED QUOTE
     */

    log("GETTING UPDATED QUOTE");


    const updatedResponse =
      await fetch(
        quoteUrl,
        {
          headers: {
            accept:
              "application/json",
            Authorization:
              `Bearer ${token}`
          }
        }
      );


    const updatedText =
      await updatedResponse.text();

    let updatedQuote;

    try {
      updatedQuote =
        updatedText
          ? JSON.parse(updatedText)
          : {};
    }
    catch {
      updatedQuote = {
        rawResponse:
          updatedText.slice(0, 500)
      };
    }


    log("UPDATED QUOTE RESPONSE", {
      status:
        updatedResponse.status,
      ok:
        updatedResponse.ok,
      hasRates:
        Boolean(updatedQuote?.rates)
    });


    if (!updatedResponse.ok) {

      return res
        .status(updatedResponse.status)
        .json({
          success: false,
          stage: "updated-quote",
          error: updatedQuote
        });
    }


    log("SUCCESS");


    return res.status(200).json({
      success: true,
      updatedQuote
    });


  }
  catch (error) {

    console.error(
      "[TOSH UPSELL DEBUG] UNHANDLED ERROR",
      {
        name: error?.name,
        message: error?.message,
        stack: error?.stack
      }
    );

    return res.status(500).json({
      success: false,
      stage: "unhandled-error",
      errorCode:
        "BOOKING_SERVICE_UNAVAILABLE"
    });
  }
}
