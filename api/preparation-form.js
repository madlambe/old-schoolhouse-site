export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      confirmation_code,
      guest_name,
      checkin,
      adults,
      children,
      infants,
      pink_room,
      duck_egg_room,
      navy_room,
      travel_cot,
      cot_pillow,
      cot_duvet,
      requests
    } = req.body || {};

    // Basic validation
    if (
      !confirmation_code ||
      !adults ||
      children === undefined ||
      infants === undefined ||
      !pink_room ||
      !duck_egg_room ||
      !navy_room ||
      !travel_cot
    ) {
      return res.status(400).json({
        error: "Required information is missing"
      });
    }

    const adultCount = Number(adults);
    const childCount = Number(children);
    const infantCount = Number(infants);

    if (
      adultCount < 1 ||
      adultCount > 8 ||
      childCount < 0 ||
      childCount > 7 ||
      infantCount < 0 ||
      infantCount > 4 ||
      adultCount + childCount > 8
    ) {
      return res.status(400).json({
        error: "Invalid guest numbers"
      });
    }

    const clean = (value) =>
      String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

    const guest = clean(guest_name || "Guest");
    const reference = clean(confirmation_code);
    const arrival = clean(checkin || "Not supplied");
    const otherRequests = clean(requests || "None");

    const subject =
      `PREPARATION FOR STAY – ${guest} – ${arrival} – ${reference}`;

    const html = `
      <div style="
        font-family: Arial, Helvetica, sans-serif;
        color: #231f20;
        max-width: 650px;
        margin: 0 auto;
        line-height: 1.6;
      ">

        <h1 style="
          color: #23447c;
          font-size: 24px;
          margin-bottom: 6px;
        ">
          Preparation for Stay
        </h1>

        <p style="margin-top:0;">
          A guest has completed their preparation form for
          <strong>The Old Schoolhouse</strong>.
        </p>

        <hr style="
          border:0;
          border-top:1px solid #ddd;
          margin:24px 0;
        ">

        <h2 style="
          color:#23447c;
          font-size:18px;
        ">
          Reservation
        </h2>

        <p>
          <strong>Guest:</strong> ${guest}<br>
          <strong>Arrival:</strong> ${arrival}<br>
          <strong>Booking reference:</strong> ${reference}
        </p>

        <h2 style="
          color:#23447c;
          font-size:18px;
        ">
          Guest Numbers
        </h2>

        <p>
          <strong>Adults:</strong> ${adultCount}<br>
          <strong>Children (2–17):</strong> ${childCount}<br>
          <strong>Infants (under 2):</strong> ${infantCount}
        </p>

        <h2 style="
          color:#23447c;
          font-size:18px;
        ">
          Bedroom Arrangements
        </h2>

        <p>
          <strong>Pink Room:</strong> ${clean(pink_room)}<br>
          <strong>Duck Egg Room:</strong> ${clean(duck_egg_room)}<br>
          <strong>Navy Room:</strong> ${clean(navy_room)}
        </p>

        <h2 style="
          color:#23447c;
          font-size:18px;
        ">
          Travel Cot
        </h2>

         <p>
          <strong>Travel Cot:</strong> ${clean(travel_cot)}${travel_cot === "Yes" ? `<br>
          <strong>Cot Pillow:</strong> ${cot_pillow === "Yes" ? "Yes" : "No"}<br>
          <strong>Cot Duvet:</strong> ${cot_duvet === "Yes" ? "Yes" : "No"}` : ""}
        </p>

        <h2 style="
          color:#23447c;
          font-size:18px;
        ">
          Other Requests
        </h2>

        <p>${otherRequests}</p>

        <hr style="
          border:0;
          border-top:1px solid #ddd;
          margin:24px 0;
        ">

        <p style="
          color:#666;
          font-size:13px;
        ">
          Copy the relevant preparation details into the
          Guesty reservation Notes for Cleaner.
        </p>

      </div>
    `;

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.PREPARATION_FROM_EMAIL,
        to: [process.env.PREPARATION_TO_EMAIL],
        subject,
        html
      })
    });

    const result = await emailResponse.json();

    if (!emailResponse.ok) {
      console.error("Resend error:", result);

      return res.status(500).json({
        error: "Email could not be sent"
      });
    }

    return res.status(200).json({
      success: true
    });

  } catch (error) {
    console.error("Preparation form error:", error);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
