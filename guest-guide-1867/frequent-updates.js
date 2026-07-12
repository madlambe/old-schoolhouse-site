/*
  FREQUENT UPDATES ONLY
  =====================
  This is the only file you need to edit for routine bin collection updates.

  Add each collection once, in date order. Use the safe date format YYYY-MM-DD:

    {
      date: "2026-07-17",
      collections: [
        "Purple sack — hard plastic and tins",
        "Red sack — paper and cardboard"
      ]
    }

  The website automatically:
  • finds and highlights the next collection;
  • removes dates that have already passed;
  • moves to the following collection without a redeploy;
  • warns in owner preview when fewer than four future dates remain.

  IMPORTANT
  Keep quotation marks, commas and square brackets exactly as shown.
*/
window.GUEST_UPDATES = {
  bins: {
    lastUpdated: "12 July 2026",
    warningWhenFewerThan: 4,
    collections: [
      {
        date: "2026-07-17",
        collections: [
          "Purple sack — hard plastic and tins",
          "Red sack — paper and cardboard"
        ]
      },
      {
        date: "2026-07-20",
        collections: [
          "General waste — black bin",
          "Food waste — blue bin",
          "Green box — glass"
        ]
      },
      {
        date: "2026-07-24",
        collections: [
          "Purple sack — hard plastic and tins",
          "Red sack — paper and cardboard"
        ]
      },
      {
        date: "2026-07-27",
        collections: [
          "General waste — black bin",
          "Food waste — blue bin",
          "Green box — glass"
        ]
      }
    ]
  }
};
