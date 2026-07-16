(() => {
  const guide = window.GUEST_GUIDE;
  const updates = window.GUEST_UPDATES || {};
  const owner = new URLSearchParams(location.search).get("edit") === "1";

  if (!guide) {
    console.error("Guest Guide content could not be loaded.");
    return;
  }

  const grid = document.querySelector("#guide-menu");
  const panels = document.querySelector("#category-panels");

  const welcomeLine = document.querySelector("#welcome-line");
  if (welcomeLine) {
    welcomeLine.textContent = guide.site.welcome || "";
  }

  const greeting = document.querySelector("#greeting-content");
  if (greeting) {
    greeting.innerHTML =
      md(guide.site.greeting || "") +
      `<p class="signature">${guide.site.signature || ""}</p>`;

    const greetingTitle = document.querySelector("#greeting-title");
    if (greetingTitle) {
      greetingTitle.textContent =
        guide.site.greetingTitle || "A Welcome from Us";
    }
  }

  const hero = document.querySelector(".hero");
  if (hero) {
    hero.style.backgroundImage =
      `linear-gradient(rgba(248,247,243,.80),rgba(248,247,243,.94)),` +
      `url('${guide.site.heroImage}')`;
  }

  if (owner) {
    document.body.classList.add("owner-preview");
    const editorNotice = document.querySelector("#editor-notice");
    if (editorNotice) editorNotice.hidden = false;
  }

  const paths = {
    spark:
      '<path d="m12 3 1.6 5.3L19 10l-5.4 1.7L12 17l-1.6-5.3L5 10l5.4-1.7L12 3Z"/>',
    home:
      '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V21h13V10.5"/><path d="M9 21v-6h6v6"/>',
    leaf:
      '<path d="M20 4C11 4 5 9 5 17c5 0 10-2 13-7"/><path d="M4 21c3-6 7-9 13-12"/>',
    check:
      '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    pin:
      '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    map:
      '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/>'
  };

  const icon = (name) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;

  function localISODate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function ordinal(number) {
    const mod100 = number % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${number}th`;

    const endings = {
      1: "st",
      2: "nd",
      3: "rd"
    };

    return `${number}${endings[number % 10] || "th"}`;
  }

  function displayDate(isoDate) {
    const date = new Date(`${isoDate}T12:00:00`);

    if (Number.isNaN(date.getTime())) return isoDate;

    const weekday = date.toLocaleDateString("en-GB", {
      weekday: "long"
    });

    const month = date.toLocaleDateString("en-GB", {
      month: "long"
    });

    return `${weekday} ${ordinal(date.getDate())} ${month}`;
  }

  function validCollection(row) {
    return (
      row &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || "")) &&
      Array.isArray(row.collections) &&
      row.collections.some((item) => String(item || "").trim())
    );
  }

  function binSchedule() {
    const bins = updates.bins || {};
    const rows = Array.isArray(bins.collections) ? bins.collections : [];
    const today = localISODate();

    const valid = rows
      .filter(validCollection)
      .sort((a, b) => a.date.localeCompare(b.date));

    const upcoming = valid.filter((row) => row.date >= today);
    const invalid = rows.filter((row) => !validCollection(row));

    if (!upcoming.length && !owner) {
      return (
        '<p class="no-bin-dates">' +
        "Please check with the property managers for the next collection date." +
        "</p>"
      );
    }

    let html = "";

    if (upcoming.length) {
      const next = upcoming[0];

      html += `
        <section class="next-collection">
          <span class="eyebrow">Next collection</span>
          <h3>${displayDate(next.date)}</h3>
          <ul>
            ${next.collections.map((item) => `<li>${item}</li>`).join("")}
          </ul>
        </section>
      `;

      html += `
        <section class="collection-schedule">
          <h3>Upcoming collection dates</h3>
          ${upcoming
            .map(
              (row) => `
                <div class="collection-date">
                  <strong>${displayDate(row.date)}</strong>
                  <ul>
                    ${row.collections
                      .map((item) => `<li>${item}</li>`)
                      .join("")}
                  </ul>
                </div>
              `
            )
            .join("")}
        </section>
      `;
    }

    if (owner) {
      const threshold = Number(bins.warningWhenFewerThan) || 4;

      if (upcoming.length < threshold) {
        html += `
          <aside class="schedule-warning">
            <strong>Schedule running low</strong><br>
            Only ${upcoming.length} future collection
            ${upcoming.length === 1 ? "date remains" : "dates remain"}.
            Add more dates in <code>frequent-updates.js</code>.
          </aside>
        `;
      }

      if (invalid.length) {
        html += `
          <aside class="schedule-warning">
            <strong>
              ${invalid.length} incomplete collection
              ${invalid.length === 1 ? "entry" : "entries"}
            </strong><br>
            Check the date and collection list in
            <code>frequent-updates.js</code>.
          </aside>
        `;
      }
    }

    if (bins.lastUpdated) {
      html += `<p class="last-updated">Last updated: ${bins.lastUpdated}</p>`;
    }

    return html;
  }

  function md(source, checklist = false) {
    const binToken = "__BIN_COLLECTION_DATES__";

    let text = String(source || "")
      .replace("[BIN_COLLECTION_DATES]", binToken)
      .trim()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    text = text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/_([^_]+)_/g, "<em>$1</em>")
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (match, label, url) => {
          const external = /^https?:\/\//i.test(url);

          return `<a href="${url}"${
            external
              ? ' target="_blank" rel="noopener noreferrer"'
              : ""
          }>${label}</a>`;
        }
      );

    const lines = text.split(/\n/);
    const output = [];
    let inList = false;

    for (const line of lines) {
      if (/^- /.test(line)) {
        if (!inList) {
          output.push(
            `<ul class="${checklist ? "checklist" : ""}">`
          );
          inList = true;
        }

        output.push(`<li>${line.slice(2)}</li>`);
        continue;
      }

      if (inList) {
        output.push("</ul>");
        inList = false;
      }

      if (/^### /.test(line)) {
        output.push(`<h3>${line.slice(4)}</h3>`);
      } else if (line.trim() === "") {
        output.push("");
      } else {
        output.push(`<p>${line.replace(/  $/, "<br>")}</p>`);
      }
    }

    if (inList) {
      output.push("</ul>");
    }

    return output
      .join("")
      .replace(binToken, binSchedule())
      .replace(
        /\[TO COMPLETE(?::[^\]]+)?\]/g,
        (match) => `<mark class="todo">${match}</mark>`
      );
  }

  guide.categories.forEach((category) => {
    const visibleItems = category.items.filter(
      (item) => item.complete || owner
    );

    const card = document.createElement("a");
    card.href = `#${category.id}`;
    card.className = "category-card";
    card.innerHTML =
      `${icon(category.icon)}<span>${category.title}</span>`;

    grid.append(card);

    const panel = document.createElement("section");
    panel.id = category.id;
    panel.className = "category-panel";

    panel.innerHTML = `
      <div class="category-heading">
        <h2>${category.title}</h2>
      </div>
      <div class="item-list"></div>
      <a
        class="panel-back-to-top"
        href="#top"
        aria-label="Back to the top of the page"
      >
        <span>Back to top</span>
      </a>
    `;

    const list = panel.querySelector(".item-list");

    visibleItems.forEach((item) => {
      const details = document.createElement("details");

      details.className =
        `guide-item${item.complete ? "" : " incomplete"}`;

      details.innerHTML = `
        <summary>
          <span>${item.title}</span>
        </summary>
        <div class="item-content">
          ${md(item.content, item.checklist)}
        </div>
      `;

      list.append(details);
    });

    if (!visibleItems.length) {
      panel.classList.add("empty");
    }

    panels.append(panel);
  });

  document.addEventListener("click", (event) => {
    const anchor = event.target.closest('a[href^="#"]');

    if (!anchor) return;

    const target = document.querySelector(anchor.getAttribute("href"));

    if (target) {
      event.preventDefault();
      target.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }
  });
})();
