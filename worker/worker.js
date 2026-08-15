const ORIGIN = "https://member.starcg.net";
const MARKET = ORIGIN + "/market.php";
const MAX_FILTERED_PAGES = 50;

export default {
  async fetch(request) {
    const u = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (u.pathname === "/" || u.pathname === "/health") {
      return cors(json({
        ok: true,
        version: "5.0",
        mode: "StarCG AJAX keyword search"
      }));
    }

    // Diagnostic endpoint:
    // /probe?q=壽喜鍋
    if (u.pathname === "/probe") {
      const q = (u.searchParams.get("q") || "壽喜鍋").trim();
      try {
        const raw = await fetchSearchPage(q, "all", "all", 1);
        const payload = unpackAjax(raw.text);
        const items = parseMarket(payload.html);
        return cors(json({
          ok: true,
          version: "5.0",
          requested_url: raw.url,
          content_type: raw.contentType,
          response_length: raw.text.length,
          json_detected: payload.isJson,
          json_keys: payload.jsonKeys,
          detected_pages: payload.pages || findMaxPage(payload.html),
          parsed_items: items.length,
          response_preview: raw.text.slice(0, 12000),
          extracted_html_preview: payload.html.slice(0, 8000)
        }));
      } catch (e) {
        return cors(json({ ok: false, error: String(e?.message || e) }, 502));
      }
    }

    if (u.pathname !== "/search") {
      return cors(json({ error: "Not found" }, 404));
    }

    const q = (u.searchParams.get("q") || "").trim();
    if (!q) return cors(json({ error: "Missing q" }, 400));

    const server = u.searchParams.get("server") || "all";
    const type = u.searchParams.get("type") || "all";
    const wantedCurrency = u.searchParams.get("currency") || "all";

    try {
      const all = [];
      const fingerprints = new Set();

      // IMPORTANT:
      // Every request below contains search=<keyword>&ajax=1.
      // We only follow pages of StarCG's FILTERED search result.
      // We never walk the unfiltered 100+ market pages.
      let page = 1;
      let knownLastPage = null;

      while (page <= MAX_FILTERED_PAGES) {
        const raw = await fetchSearchPage(q, server, type, page);
        const payload = unpackAjax(raw.text);
        const rows = parseMarket(payload.html);

        const qLower = q.toLowerCase();
        const matching = rows.filter(x =>
          String(x.name || "").toLowerCase().includes(qLower)
        );

        const fp = matching.slice(0, 12).map(x =>
          [x.name,x.server,x.east,x.south,x.price,x.currency].join("|")
        ).join("~");

        if (fp && fingerprints.has(fp)) break;
        if (fp) fingerprints.add(fp);

        all.push(...matching);

        if (knownLastPage == null) {
          knownLastPage =
            payload.pages ||
            findMaxPage(payload.html) ||
            null;
        }

        // If StarCG tells us the final page, obey it.
        if (knownLastPage != null && page >= knownLastPage) break;

        // If page 1 has no next-page signal and no results, stop.
        const hasNext = hasNextPage(payload.html, page);
        if (knownLastPage == null && !hasNext) break;

        // A later empty filtered page means we reached the end.
        if (page > 1 && matching.length === 0) break;

        page++;
      }

      let items = dedupe(all);

      if (wantedCurrency !== "all") {
        items = items.filter(x => x.currency === wantedCurrency);
      }

      items.sort((a, b) =>
        a.price - b.price ||
        (a.server || "").localeCompare(b.server || "")
      );

      return cors(json({
        ok: true,
        version: "5.0",
        query: q,
        source: "StarCG AJAX keyword search",
        result_pages: page,
        count: items.length,
        items
      }));
    } catch (e) {
      return cors(json({
        error: String(e?.message || e),
        hint: "請開啟 Worker網址/probe?q=壽喜鍋，將畫面貼給 ChatGPT。"
      }, 502));
    }
  }
};

async function fetchSearchPage(q, server, type, page) {
  const url = new URL(MARKET);

  // These names come directly from StarCG's own page JavaScript.
  url.searchParams.set("page", String(page));
  url.searchParams.set("type", type);
  url.searchParams.set("server", server);
  url.searchParams.set("search", q);
  url.searchParams.set("exact", "0");
  url.searchParams.set("ajax", "1");

  const r = await fetch(url.href, {
    headers: {
      "User-Agent": "Mozilla/5.0 StarCG-Market-Compare/5.0",
      "Accept": "application/json,text/html,*/*",
      "Accept-Language": "zh-TW,zh;q=0.9",
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  if (!r.ok) throw new Error(`StarCG HTTP ${r.status}`);

  return {
    url: url.href,
    text: await r.text(),
    contentType: r.headers.get("content-type") || ""
  };
}

function unpackAjax(text) {
  const raw = String(text || "");
  let parsed = null;

  try {
    parsed = JSON.parse(raw);
  } catch (_) {}

  if (parsed == null) {
    return {
      isJson: false,
      jsonKeys: [],
      html: raw,
      pages: null
    };
  }

  const strings = [];
  collectStrings(parsed, strings);

  // Prefer strings that look like the market result fragment.
  strings.sort((a, b) => scoreHtml(b) - scoreHtml(a) || b.length - a.length);

  const html = strings[0] || raw;

  return {
    isJson: true,
    jsonKeys: parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed)
      : [],
    html,
    pages: findPageCountInJson(parsed)
  };
}

function collectStrings(v, out) {
  if (typeof v === "string") {
    if (v.length > 20) out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out);
    return;
  }
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) collectStrings(x, out);
  }
}

function scoreHtml(s) {
  const t = String(s || "");
  let n = 0;
  if (t.includes("價格")) n += 50;
  if (t.includes("商店")) n += 30;
  if (t.includes("東:") || t.includes("東：")) n += 30;
  if (/\[S[123]\]/.test(t)) n += 30;
  if (t.includes("販售道具") || t.includes("販售寵物")) n += 20;
  return n;
}

function findPageCountInJson(v) {
  let best = null;

  function walk(x, key = "") {
    if (x == null) return;

    if (typeof x === "number" && Number.isFinite(x)) {
      if (/total.?pages?|last.?page|max.?page|page.?count/i.test(key)) {
        if (x >= 1 && x <= 1000) best = Math.max(best || 0, x);
      }
      return;
    }

    if (typeof x === "string" && /^\d+$/.test(x)) {
      const n = +x;
      if (/total.?pages?|last.?page|max.?page|page.?count/i.test(key)) {
        if (n >= 1 && n <= 1000) best = Math.max(best || 0, n);
      }
      return;
    }

    if (Array.isArray(x)) {
      x.forEach(y => walk(y, key));
      return;
    }

    if (typeof x === "object") {
      for (const [k, y] of Object.entries(x)) walk(y, k);
    }
  }

  walk(v);
  return best;
}

function imageToToken(tag) {
  const t = String(tag || "");
  const alt = attr(t, "alt");
  const title = attr(t, "title");
  const src = attr(t, "src");
  const hay = `${alt} ${title} ${src}`.toLowerCase();

  if (hay.includes("魔晶") || /crystal|gem|diamond/.test(hay)) return " 魔晶 ";
  if (hay.includes("金幣") || /gold|coin|money/.test(hay)) return " 金幣 ";

  return alt ? ` ${alt} ` : " ";
}

function htmlLines(html) {
  let s = String(html || "");

  s = s.replace(/<img\b[^>]*>/gi, m => imageToToken(m));

  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|tr|td|section|article|h\d|span)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  s = decode(s);

  return s
    .replace(/\r/g, "")
    .split("\n")
    .map(x => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseMarket(html) {
  const lines = htmlLines(html);
  const out = [];

  const stall =
    /\[(S[123])\]\s*(.*?)\s*\[\s*東\s*[:：]\s*(\d+)\s*南\s*[:：]\s*(\d+)\s*\]/;

  const price =
    /價格\s*[:：]\s*([\d,]+)(?:\s*(金幣|魔晶))?/;

  let cur = null;
  let section = "道具";
  let lastName = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const sm = line.match(stall);
    if (sm) {
      cur = {
        server: sm[1],
        place: clean(sm[2]),
        east: +sm[3],
        south: +sm[4],
        shop: "",
        expires: ""
      };
      lastName = "";
      section = "道具";
      continue;
    }

    if (!cur) continue;

    if (line.includes("販售道具")) {
      section = "道具";
      lastName = "";
      continue;
    }

    if (line.includes("販售寵物")) {
      section = "寵物";
      lastName = "";
      continue;
    }

    if (/^商店\s*[:：]/.test(line)) {
      cur.shop = clean(line.replace(/^商店\s*[:：]\s*/, ""));
      continue;
    }

    if (/^攤位到期時間\s*[:：]/.test(line)) {
      cur.expires = clean(line.replace(/^攤位到期時間\s*[:：]\s*/, ""));
      if (!cur.expires && i + 1 < lines.length) cur.expires = lines[i + 1];
      continue;
    }

    const pm = line.match(price);

    if (pm) {
      let name = lastName;

      if (!validName(name, stall)) {
        for (let k = i - 1; k >= Math.max(0, i - 10); k--) {
          if (validName(lines[k], stall)) {
            name = lines[k];
            break;
          }
        }
      }

      if (!validName(name, stall)) continue;

      let quantity = 1;
      const qm = name.match(/\s*[xX×]\s*(\d+)\s*$/);
      if (qm) {
        quantity = Math.max(1, +qm[1]);
        name = clean(name.replace(/\s*[xX×]\s*\d+\s*$/, ""));
      }

      const priceValue = +pm[1].replace(/,/g, "");

      let currency = pm[2] || "";

      if (!currency) {
        const around = lines
          .slice(Math.max(0, i - 1), Math.min(lines.length, i + 5))
          .join(" ");

        if (around.includes("魔晶")) currency = "魔晶";
        else if (around.includes("金幣")) currency = "金幣";
      }

      if (!currency) currency = "金幣";

      out.push({
        ...cur,
        name,
        type: section,
        quantity,
        price: priceValue,
        unit_price: priceValue / quantity,
        currency
      });

      continue;
    }

    if (validName(line, stall)) {
      lastName = line;
    }
  }

  return out;
}

function validName(s, stall) {
  if (!s || s.length > 120) return false;
  if (stall.test(s)) return false;

  if (
    /^(搜尋|搜尋名字|清除條件|全部|道具攤位|寵物攤位|所有分流|上一頁|下一頁|金幣|魔晶)$/.test(s)
  ) return false;

  if (
    /價格\s*[:：]|商店\s*[:：]|攤位到期|販售道具|販售寵物/.test(s)
  ) return false;

  return true;
}

function findMaxPage(html) {
  let max = 1;
  const s = String(html || "");

  for (const m of s.matchAll(/[?&]page=(\d+)/gi)) {
    max = Math.max(max, +m[1]);
  }

  for (const m of s.matchAll(/\bdata-page\s*=\s*["']?(\d+)/gi)) {
    max = Math.max(max, +m[1]);
  }

  return max > 1 ? max : null;
}

function hasNextPage(html, currentPage) {
  const s = String(html || "");

  if (/下一頁/.test(stripText(s))) return true;

  const max = findMaxPage(s);
  return max != null && max > currentPage;
}

function dedupe(items) {
  const map = new Map();

  for (const x of items) {
    const key = [
      x.name,
      x.server,
      x.place,
      x.east,
      x.south,
      x.shop,
      x.price,
      x.currency,
      x.quantity
    ].join("|");

    map.set(key, x);
  }

  return [...map.values()];
}

function attr(tag, name) {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`,
    "i"
  );

  const m = String(tag || "").match(re);
  return m ? (m[1] ?? m[2] ?? "") : "";
}

function stripText(html) {
  return decode(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function decode(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function cors(res) {
  const h = new Headers(res.headers);

  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");

  return new Response(res.body, {
    status: res.status,
    headers: h
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
