const ORIGIN = "https://member.starcg.net";
const MARKET = ORIGIN + "/market.php";
const START = MARKET + "?page=1&type=all&server=all";
const MAX_RESULT_PAGES = 40;

export default {
  async fetch(request) {
    const u = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (u.pathname === "/" || u.pathname === "/health") {
      return cors(json({
        ok: true,
        version: "4.0",
        mode: "StarCG direct keyword search proxy"
      }));
    }

    if (u.pathname === "/debug") {
      try {
        const html = await fetchText(START);
        const cfg = discoverSearchConfig(html);
        return cors(json({
          ok: true,
          input_tag: cfg.inputTag,
          input_id: cfg.inputId,
          input_name: cfg.inputName,
          method: cfg.method,
          action: cfg.action,
          candidates: cfg.candidates
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

    try {
      const server = u.searchParams.get("server") || "all";
      const type = u.searchParams.get("type") || "all";
      const currency = u.searchParams.get("currency") || "all";

      // Read StarCG's current search UI every time so the Worker can adapt
      // if its HTML attributes change.
      const landing = await fetchText(START);
      const cfg = discoverSearchConfig(landing);

      // Try the field discovered from HTML/JS first, then a small set of
      // common parameter names. This is NOT page crawling: each attempt is
      // StarCG's own keyword search request.
      const first = await submitKeywordSearch(cfg, q, server, type);

      let items = [];
      let pages = 0;
      let current = first;
      const visited = new Set();

      while (current && pages < MAX_RESULT_PAGES) {
        pages++;

        const parsed = parseMarket(current.html);

        // Final safety filter: even if StarCG changes something, never return
        // unrelated unfiltered market rows.
        const qLower = q.toLowerCase();
        items.push(...parsed.filter(x =>
          String(x.name || "").toLowerCase().includes(qLower)
        ));

        const next = findNextHref(current.html);
        if (!next) break;

        const nextUrl = new URL(next, current.url);

        // Make sure the next page remains inside the SAME keyword search.
        if (current.field) nextUrl.searchParams.set(current.field, q);
        nextUrl.searchParams.set("server", server);
        nextUrl.searchParams.set("type", type);

        const href = nextUrl.href;
        if (visited.has(href)) break;
        visited.add(href);

        current = {
          field: current.field,
          url: href,
          html: await fetchText(href)
        };
      }

      if (currency !== "all") {
        items = items.filter(x => x.currency === currency);
      }

      const dedupe = new Map();
      for (const x of items) {
        const key = [
          x.name, x.server, x.place, x.east, x.south,
          x.shop, x.price, x.currency, x.quantity
        ].join("|");
        dedupe.set(key, x);
      }

      items = [...dedupe.values()].sort((a, b) => a.price - b.price);

      return cors(json({
        ok: true,
        query: q,
        source: "StarCG original keyword search",
        search_field: first.field,
        result_pages: pages,
        count: items.length,
        items
      }));
    } catch (err) {
      return cors(json({
        error: String(err?.message || err),
        hint: "如果仍失敗，請直接在 Worker 網址後加 /debug 並把畫面截圖給我。"
      }, 502));
    }
  }
};

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function fetchText(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": "Mozilla/5.0 StarCG-Market-Compare/4.0",
      "Accept-Language": "zh-TW,zh;q=0.9",
      ...(init.headers || {})
    }
  });

  if (!r.ok) throw new Error(`StarCG HTTP ${r.status}`);
  return await r.text();
}

function attr(tag, name) {
  const re = new RegExp(
    `\\b${escapeRegExp(name)}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`,
    "i"
  );
  const m = tag.match(re);
  return m ? (m[1] ?? m[2] ?? "") : "";
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function discoverSearchConfig(html) {
  const im = html.match(
    /<input\b[^>]*placeholder\s*=\s*["'][^"']*搜尋名字[^"']*["'][^>]*>/i
  );

  if (!im) {
    throw new Error("找不到 StarCG 的「搜尋名字」欄位，原站可能已改版");
  }

  const inputTag = im[0];
  const inputId = attr(inputTag, "id");
  const inputName = attr(inputTag, "name");

  const idx = im.index ?? html.indexOf(inputTag);
  const before = html.slice(0, idx);
  const fs = before.lastIndexOf("<form");

  let method = "GET";
  let action = MARKET;
  let hidden = {};

  if (fs >= 0) {
    const fe = html.indexOf(">", fs);
    const formTag = html.slice(fs, fe + 1);
    method = (attr(formTag, "method") || "GET").toUpperCase();
    action = new URL(attr(formTag, "action") || "/market.php", ORIGIN).href;

    const formClose = html.indexOf("</form>", fe);
    const formHtml = html.slice(
      fe + 1,
      formClose > 0 ? formClose : Math.min(html.length, idx + 5000)
    );

    for (const m of formHtml.matchAll(
      /<input\b[^>]*type\s*=\s*["']hidden["'][^>]*>/gi
    )) {
      const n = attr(m[0], "name");
      const v = attr(m[0], "value");
      if (n) hidden[n] = v;
    }
  }

  const inferred = inferFieldsFromScripts(html, inputId);

  // StarCG currently exposes a search box without a name attribute.
  // We therefore keep multiple safe candidates rather than failing.
  const candidates = unique([
    inputName,
    ...inferred,
    "search",
    "name",
    "keyword",
    "q",
    "search_name",
    "searchName",
    "item_name",
    "item"
  ]);

  return {
    inputTag,
    inputId,
    inputName,
    method,
    action,
    hidden,
    candidates
  };
}

function inferFieldsFromScripts(html, inputId) {
  const found = [];
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1] || "")
    .join("\n");

  // URLSearchParams.set("parameter", ...)
  for (const m of scripts.matchAll(
    /(?:searchParams|params|urlParams)\s*\.\s*set\s*\(\s*["']([A-Za-z0-9_-]+)["']/gi
  )) {
    found.push(m[1]);
  }

  // "?parameter=" or "&parameter=" inside JS.
  for (const m of scripts.matchAll(
    /[?&]([A-Za-z_][A-Za-z0-9_-]*)=/g
  )) {
    const key = m[1];
    if (!["page", "type", "server", "lang"].includes(key)) found.push(key);
  }

  // If the input has an id, look especially near JS references to that id.
  if (inputId) {
    const pos = scripts.indexOf(inputId);
    if (pos >= 0) {
      const near = scripts.slice(Math.max(0, pos - 1500), pos + 3000);
      for (const m of near.matchAll(/[?&]([A-Za-z_][A-Za-z0-9_-]*)=/g)) {
        const key = m[1];
        if (!["page", "type", "server", "lang"].includes(key)) found.unshift(key);
      }
    }
  }

  return unique(found);
}

async function submitKeywordSearch(cfg, q, server, type) {
  let best = null;

  for (const field of cfg.candidates) {
    try {
      const result = await requestWithField(cfg, field, q, server, type);
      const parsed = parseMarket(result.html);
      const qLower = q.toLowerCase();
      const matching = parsed.filter(x =>
        String(x.name || "").toLowerCase().includes(qLower)
      );

      const reflected = searchInputValue(result.html) === q;
      const score = (matching.length * 100) + (reflected ? 10 : 0);

      if (!best || score > best.score) {
        best = { ...result, field, score, matching: matching.length, reflected };
      }

      // Strong signal: StarCG actually returned matching listings.
      if (matching.length > 0) {
        return { ...result, field };
      }

      // Valid search with zero results: the site reflected the keyword in
      // its own search box, so the parameter was accepted.
      if (reflected && looksLikeNoResults(result.html)) {
        return { ...result, field };
      }
    } catch (_) {
      // Try the next candidate.
    }
  }

  if (best && best.reflected) {
    return { url: best.url, html: best.html, field: best.field };
  }

  throw new Error(
    "無法自動辨識 StarCG 的搜尋參數。請開啟你的 Worker 網址/debug 並把結果截圖給我。"
  );
}

async function requestWithField(cfg, field, q, server, type) {
  const p = new URLSearchParams(cfg.hidden || {});
  p.set(field, q);
  p.set("server", server);
  p.set("type", type);
  p.delete("page");

  // Most JS-driven search UIs use GET even if the input itself has no name.
  // Try the discovered form method first.
  if (cfg.method === "POST") {
    const html = await fetchText(cfg.action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: p.toString()
    });
    return { url: cfg.action, html };
  }

  const url = new URL(cfg.action || MARKET);
  for (const [k, v] of p) url.searchParams.set(k, v);
  return { url: url.href, html: await fetchText(url.href) };
}

function searchInputValue(html) {
  const m = html.match(
    /<input\b[^>]*placeholder\s*=\s*["'][^"']*搜尋名字[^"']*["'][^>]*>/i
  );
  if (!m) return "";
  return decode(attr(m[0], "value") || "");
}

function looksLikeNoResults(html) {
  const t = strip(html).join(" ");
  return /沒有找到|找不到|查無|無符合|0\s*筆|0\s*個/.test(t);
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

function strip(html) {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|p|li|tr|td|section|article|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
  )
    .split("\n")
    .map(x => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseMarket(html) {
  const lines = strip(html);
  const out = [];

  const stall =
    /\[(S[123])\]\s*(.*?)\s*\[\s*東\s*[:：]\s*(\d+)\s*南\s*[:：]\s*(\d+)\s*\]/;

  const price =
    /價格\s*[:：]\s*([\d,]+)(?:\s*(金幣|魔晶))?/;

  let cur = null;
  let type = "道具";
  let name = "";

  const bad = s =>
    !s ||
    /^(搜尋|清除條件|全部|道具攤位|寵物攤位|所有分流|上一頁|下一頁|金幣|魔晶)$/.test(s) ||
    /價格|商店\s*[:：]|攤位到期|販售道具|販售寵物/.test(s) ||
    stall.test(s);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sm = line.match(stall);

    if (sm) {
      cur = {
        server: sm[1],
        place: sm[2].trim(),
        east: +sm[3],
        south: +sm[4],
        shop: "",
        expires: ""
      };
      name = "";
      type = "道具";
      continue;
    }

    if (!cur) continue;

    if (line.includes("販售道具")) {
      type = "道具";
      name = "";
      continue;
    }

    if (line.includes("販售寵物")) {
      type = "寵物";
      name = "";
      continue;
    }

    if (/^商店\s*[:：]/.test(line)) {
      cur.shop = line.replace(/^商店\s*[:：]\s*/, "");
      continue;
    }

    if (/^攤位到期時間\s*[:：]/.test(line)) {
      cur.expires = line.replace(/^攤位到期時間\s*[:：]\s*/, "");
      continue;
    }

    const pm = line.match(price);

    if (pm) {
      let n = name;

      if (!n) {
        for (let k = i - 1; k >= Math.max(0, i - 8); k--) {
          if (!bad(lines[k])) {
            n = lines[k];
            break;
          }
        }
      }

      if (!n) continue;

      let quantity = 1;
      const qm = n.match(/\s*[xX×]\s*(\d+)\s*$/);

      if (qm) {
        quantity = Math.max(1, +qm[1]);
        n = n.replace(/\s*[xX×]\s*\d+\s*$/, "").trim();
      }

      const p = +pm[1].replace(/,/g, "");

      // Currency may be on the next line / represented separately.
      let currency = pm[2] || "";
      if (!currency) {
        const around = lines.slice(i, Math.min(lines.length, i + 4)).join(" ");
        if (around.includes("魔晶")) currency = "魔晶";
        else if (around.includes("金幣")) currency = "金幣";
      }
      if (!currency) currency = "金幣";

      out.push({
        ...cur,
        name: n,
        type,
        quantity,
        price: p,
        unit_price: p / quantity,
        currency
      });

      continue;
    }

    if (!bad(line) && line.length <= 100) {
      name = line;
    }
  }

  return out;
}

function findNextHref(html) {
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const text = strip(m[2]).join(" ");

    if (text.includes("下一頁")) {
      const href = attr(m[0], "href");
      if (href && href !== "#" && !/^javascript:/i.test(href)) {
        return decode(href);
      }
    }
  }

  return null;
}
