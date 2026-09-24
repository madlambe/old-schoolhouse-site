let cachedToken = null;
let tokenExpiresAt = 0;

// The Old Schoolhouse Guesty listing ID
const TOSH_LISTING_ID = "6a9971cb2e53cb00111b27da";

async function getGuestyToken() {
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

    throw new Error(
      `Guesty authentication failed: ${response.status} ${errorText}`
    );
  }

  const data = await response.json();

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  return cachedToken;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  const {
    checkIn,
    checkOut,
    adults = "2",
    children = "0",
    infants = "0",
    pets = "0",
  } = req.query;

  if (!validDate(checkIn) || !validDate(checkOut)) {
    return res.status(400).json({
      success: false,
      error: "Please provide checkIn and checkOut as YYYY-MM-DD",
    });
  }

  if (checkOut <= checkIn) {
    return res.status(400).json({
      success: false,
      error: "Check-out must be after check-in",
    });
  }

  const adultCount = Math.max(1, parseInt(adults, 10) || 1);
  const childCount = Math.max(0, parseInt(children, 10) || 0);
  const infantCount = Math.max(0, parseInt(infants, 10) || 0);
  const petCount = Math.max(0, parseInt(pets, 10) || 0);

  const guestsCount = adultCount + childCount;

  if (guestsCount > 8) {
    return res.status(400).json({
      success: false,
      error: "The Old Schoolhouse accommodates a maximum of 8 guests.",
    });
  }

  if (petCount > 2) {
    return res.status(400).json({
      success: false,
      error: "A maximum of 2 dogs is permitted.",
    });
  }

  try {
    const token = await getGuestyToken();

    const response = await fetch(
      "https://booking.guesty.com/api/reservations/quotes",
      {
        method: "POST",
        headers: {
          Accept: "application/json; charset=utf-8",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          checkInDateLocalized: checkIn,
          checkOutDateLocalized: checkOut,
          listingId: TOSH_LISTING_ID,
          guestsCount,
          numberOfGuests: {
            numberOfAdults: adultCount,
            numberOfChildren: childCount,
            numberOfInfants: infantCount,
            numberOfPets: petCount,
          },
        }),
      }
    );

    const responseText = await response.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }

    if (!response.ok) {
      console.error("Guesty quote error:", response.status, data);

      return res.status(response.status).json({
        success: false,
        status: response.status,
        error: data,
      });
    }

    return res.status(200).json({
      success: true,
      checkIn,
      checkOut,
      guests: {
        adults: adultCount,
        children: childCount,
        infants: infantCount,
        pets: petCount,
      },
      quote: data,
    });
  } catch (error) {
    console.error("Guesty quote request error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
