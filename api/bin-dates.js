/**
 * Vercel serverless function for The Old Schoolhouse bin dates.
 *
 * It requests property-level Local Info from Monmouthshire County
 * Council's Astun iShare service using the property's UPRN.
 *
 * The Guest Guide retains its embedded manual dates as a fallback.
 */

const UPRN = "10033358554";
const BASE_URL =
  "https://maps.monmouthshire.gov.uk/getdata.aspx";

const MAP_SOURCES = [
  "mapsources/Monmouthshire/Monmouth",
  "Monmouthshire/Monmouth",
  "mapsources/Monmouthshire/default",
  "mapsources/default"
];

const GROUP_NAMES = [
  "Waste Collections",
  "Waste Collection",
  "Recycling and Waste",
  "Recycling & Waste"
];

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};

const WASTE_TYPES = [
  {
    test: /household rubbish|general waste|refuse|black bin/i,
    label:
      "⬛ Black bin — General waste, sealed in plastic refuse bags."
  },
  {
    test: /green box|glass/i,
    label:
      "🟩 Green recycling box — Glass only. Please rinse and dry. No plastic refuse bags."
  },
  {
    test: /purple|hard plastic|plastics.*tins|cans.*plastic/i,
    label:
      "🟪 Purple recycling sack — Hard plastics & tins only. No plastic refuse bags."
  },
  {
    test: /red sack|paper|cardboard/i,
    label:
      "🟥 Red recycling sack — Paper & cardboard only. No plastic refuse bags."
  },
  {
    test: /food waste|food-compost|food compost|blue bin/i,
    label:
      "🟦 Blue food-compost bin — Food waste only, sealed in plastic food-compost bags."
  }
];

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function inferIsoDate(day, monthName, explicitYear) {
  const now = new Date();
  const month = MONTHS[String(monthName).toLowerCase()];

  if (month === undefined) return null;

  let year = explicitYear
    ? Number(explicitYear)
    : now.getFullYear();

  let date = new Date(year, month, Number(day), 12, 0, 0);

  // Collection pages often omit the year. If the inferred date is
  // more than six months in the past, it belongs to the next year.
  if (
    !explicitYear &&
    date.getTime() <
      now.getTime() - 183 * 24 * 60 * 60 * 1000
  ) {
    year += 1;
    date = new Date(year, month, Number(day), 12, 0, 0);
  }

  if (Number.isNaN(date.getTime())) return null;

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function extractDate(text) {
  const longDate = text.match(
    /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?/i
  );

  if (longDate) {
    return inferIsoDate(
      longDate[1],
      longDate[2],
      longDate[3]
    );
  }

  const iso = text.match(
    /\b(20\d{2})-(\d{2})-(\d{2})\b/
  );

  if (iso) return iso[0];

  const british = text.match(
    /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/
  );

  if (british) {
    return [
      british[3],
      String(british[2]).padStart(2, "0"),
      String(british[1]).padStart(2, "0")
    ].join("-");
  }

  return null;
}

function classify(text) {
  return WASTE_TYPES
    .filter((type) => type.test.test(text))
    .map((type) => type.label);
}

function collectCandidates(value, output = []) {
  if (value == null) return output;

  if (typeof value === "string") {
    output.push(stripHtml(value));
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCandidates(item, output);

      if (item && typeof item === "object") {
        output.push(
          stripHtml(JSON.stringify(item))
        );
      }
    }
    return output;
  }

  if (typeof value === "object") {
    output.push(stripHtml(JSON.stringify(value)));

    for (const item of Object.values(value)) {
      collectCandidates(item, output);
    }
  }

  return output;
}

function parseCollections(payload) {
  const candidates = collectCandidates(payload);
  const grouped = new Map();

  for (const candidate of candidates) {
    const date = extractDate(candidate);
    const types = classify(candidate);

    if (!date || !types.length) continue;

    if (!grouped.has(date)) grouped.set(date, new Set());

    for (const type of types) {
      grouped.get(date).add(type);
    }
  }

  return [...grouped.entries()]
    .map(([date, types]) => ({
      date,
      collections: [...types]
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchCouncilData() {
  const attempts = [];

  for (const mapSource of MAP_SOURCES) {
    for (const group of GROUP_NAMES) {
      const url = new URL(BASE_URL);
      url.searchParams.set("RequestType", "LocalInfo");
      url.searchParams.set("ms", mapSource);
      url.searchParams.set("format", "JSON");
      url.searchParams.set("group", group);
      url.searchParams.set("uid", UPRN);

      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json,text/plain,*/*",
            "User-Agent":
              "TheOldSchoolhouseGuestGuide/1.0"
          }
        });

        const raw = await response.text();
        let payload = raw;

        try {
          payload = JSON.parse(raw);
        } catch {
          // Some iShare installations return HTML fragments.
        }

        const collections = parseCollections(payload);

        attempts.push({
          url: url.toString(),
          status: response.status,
          found: collections.length,
          preview: stripHtml(raw).slice(0, 300)
        });

        if (response.ok && collections.length) {
          return {
            collections,
            upstream: url.toString(),
            attempts
          };
        }
      } catch (error) {
        attempts.push({
          url: url.toString(),
          error:
            error instanceof Error
              ? error.message
              : String(error)
        });
      }
    }
  }

  return {
    collections: [],
    upstream: null,
    attempts
  };
}

module.exports = async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "s-maxage=21600, stale-while-revalidate=86400"
  );
  res.setHeader(
    "X-Robots-Tag",
    "noindex, nofollow, noarchive"
  );

  try {
    const result = await fetchCouncilData();

    if (!result.collections.length) {
      return res.status(502).json({
        ok: false,
        collections: [],
        message:
          "The council feed was reached but no collection dates " +
          "could yet be parsed. The Guest Guide will continue to " +
          "use its saved fallback dates.",
        debug:
          req.query && req.query.debug === "1"
            ? result.attempts
            : undefined
      });
    }

    return res.status(200).json({
      ok: true,
      property: {
        uprn: UPRN,
        address:
          "The Old School House, Penrhos Road, Penrhos, NP15 2LE"
      },
      lastUpdated: new Date().toLocaleDateString(
        "en-GB",
        {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "Europe/London"
        }
      ),
      collections: result.collections
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      collections: [],
      message:
        "Automatic bin dates are temporarily unavailable. " +
        "The Guest Guide will use its saved fallback dates.",
      error:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
};
