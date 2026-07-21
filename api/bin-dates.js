/**
 * The Old Schoolhouse — automatic Monmouthshire bin dates
 * Vercel route: /api/bin-dates
 */

const LOCAL_INFO_URL =
  "https://maps.monmouthshire.gov.uk/localinfo.aspx";

const PROPERTY = {
  uprn: "10033358554",
  address:
    "The Old School House, Penrhos Road, Penrhos, NP15 2LE",
  x: "341563.9900",
  y: "211753.8700"
};

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
    key: "black",
    patterns: [
      /household rubbish(?: bag)?/i,
      /general waste/i,
      /residual waste/i,
      /black bin/i
    ],
    label:
      "⬛ Black bin — General waste, sealed in plastic refuse bags."
  },
  {
    key: "green",
    patterns: [
      /\bglass\b/i,
      /green recycling box/i,
      /green box/i
    ],
    label:
      "🟩 Green recycling box — Glass only. Please rinse and dry. No plastic refuse bags."
  },
  {
    key: "purple",
    patterns: [
      /purple recycling sack/i,
      /purple sack/i,
      /hard plastics?(?:\s*(?:and|&)\s*tins)?/i,
      /plastics?(?:\s*(?:and|&)\s*(?:cans|tins|cartons))?/i
    ],
    label:
      "🟪 Purple recycling sack — Hard plastics & tins only. No plastic refuse bags."
  },
  {
    key: "red",
    patterns: [
      /red recycling sack/i,
      /red sack/i,
      /paper(?:\s*(?:and|&)\s*cardboard)?/i,
      /cardboard/i
    ],
    label:
      "🟥 Red recycling sack — Paper & cardboard only. No plastic refuse bags."
  },
  {
    key: "blue",
    patterns: [
      /food waste/i,
      /food compost/i,
      /food-compost/i,
      /blue food-compost bin/i,
      /blue bin/i
    ],
    label:
      "🟦 Blue food-compost bin — Food waste only, sealed in plastic food-compost bags."
  }
];

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(
        /<\/(?:p|div|li|h1|h2|h3|h4|section|article|tr)>/gi,
        "\n"
      )
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inferIsoDate(day, monthName, explicitYear) {
  const now = new Date();
  const month = MONTHS[String(monthName).toLowerCase()];

  if (month === undefined) return null;

  let year = explicitYear
    ? Number(explicitYear)
    : now.getFullYear();

  let date = new Date(
    year,
    month,
    Number(day),
    12,
    0,
    0
  );

  if (
    !explicitYear &&
    date.getTime() <
      now.getTime() - 183 * 24 * 60 * 60 * 1000
  ) {
    year += 1;
    date = new Date(
      year,
      month,
      Number(day),
      12,
      0,
      0
    );
  }

  if (Number.isNaN(date.getTime())) return null;

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function extractDates(value) {
  const text = String(value || "");
  const results = [];

  const longDate =
    /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?/gi;

  let match;

  while ((match = longDate.exec(text)) !== null) {
    const iso = inferIsoDate(
      match[1],
      match[2],
      match[3]
    );

    if (iso) results.push(iso);
  }

  const british =
    /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/g;

  while ((match = british.exec(text)) !== null) {
    results.push(
      [
        match[3],
        String(match[2]).padStart(2, "0"),
        String(match[1]).padStart(2, "0")
      ].join("-")
    );
  }

  return [...new Set(results)];
}

function firstPatternIndex(text, patterns) {
  let best = -1;

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (
      match &&
      (best === -1 || match.index < best)
    ) {
      best = match.index;
    }
  }

  return best;
}

function parseCollections(html) {
  const text = htmlToText(html);
  const found = [];

  for (const type of WASTE_TYPES) {
    let searchFrom = 0;

    while (searchFrom < text.length) {
      const remaining = text.slice(searchFrom);
      const relativeIndex =
        firstPatternIndex(
          remaining,
          type.patterns
        );

      if (relativeIndex === -1) break;

      const absoluteIndex =
        searchFrom + relativeIndex;

      const nearby = text.slice(
        absoluteIndex,
        absoluteIndex + 1000
      );

      const dates = extractDates(nearby);

      if (dates.length) {
        found.push({
          key: type.key,
          label: type.label,
          date: dates[0]
        });
        break;
      }

      searchFrom = absoluteIndex + 1;
    }
  }

  const grouped = new Map();

  for (const item of found) {
    if (!grouped.has(item.date)) {
      grouped.set(item.date, new Map());
    }

    grouped
      .get(item.date)
      .set(item.key, item.label);
  }

  return [...grouped.entries()]
    .map(([date, types]) => ({
      date,
      collections: [...types.values()]
    }))
    .sort(
      (a, b) => a.date.localeCompare(b.date)
    );
}

function buildCookieHeader() {
  const locationValue = [
    `locAddress=${encodeURIComponent(
      PROPERTY.address
    )}`,
    `locUID=${PROPERTY.uprn}`,
    `locX=${PROPERTY.x}`,
    `locY=${PROPERTY.y}`
  ].join("&");

  return [
    "atMyCouncil=tabSelected=atTabMonmouthshire_-_MyHouse",
    "astun=version=6.0.8.21095",
    `atLocation=${locationValue}`
  ].join("; ");
}

async function fetchCouncilPage() {
  const response = await fetch(
    LOCAL_INFO_URL,
    {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "en-GB,en;q=0.8",
        "Cache-Control": "no-cache",
        Cookie: buildCookieHeader(),
        Pragma: "no-cache",
        Referer: LOCAL_INFO_URL,
        "User-Agent":
          "Mozilla/5.0 (compatible; TheOldSchoolhouseGuestGuide/1.0)"
      }
    }
  );

  const html = await response.text();

  if (!response.ok) {
    throw new Error(
      `Council Local Info returned ${response.status}`
    );
  }

  return html;
}

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control":
          "s-maxage=21600, stale-while-revalidate=86400",
        "X-Robots-Tag":
          "noindex, nofollow, noarchive, nosnippet"
      }
    }
  );
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const debug =
      url.searchParams.get("debug") === "1";

    try {
      const html =
        await fetchCouncilPage();

      const collections =
        parseCollections(html);

      if (!collections.length) {
        return jsonResponse(
          {
            ok: false,
            collections: [],
            message:
              "The council page loaded, but no waste dates could be parsed. The Guest Guide will continue to use its saved fallback dates.",
            debug: debug
              ? {
                  property: PROPERTY,
                  pageLength: html.length,
                  containsAddress:
                    html.includes(
                      "The Old School House"
                    ) ||
                    html.includes(
                      PROPERTY.uprn
                    ),
                  textPreview:
                    htmlToText(html).slice(
                      0,
                      3000
                    )
                }
              : undefined
          },
          502
        );
      }

      return jsonResponse({
        ok: true,
        property: PROPERTY,
        source:
          "Monmouthshire County Council",
        lastUpdated:
          new Date().toLocaleDateString(
            "en-GB",
            {
              day: "numeric",
              month: "long",
              year: "numeric",
              timeZone:
                "Europe/London"
            }
          ),
        collections,
        debug: debug
          ? {
              pageLength: html.length,
              collectionGroups:
                collections.length
            }
          : undefined
      });
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          collections: [],
          message:
            "Automatic bin dates are temporarily unavailable. The Guest Guide will use its saved fallback dates.",
          error:
            error instanceof Error
              ? error.message
              : String(error)
        },
        500
      );
    }
  }
};
