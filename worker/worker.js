const ORIGIN = "https://member.starcg.net";
const MARKET = ORIGIN + "/market.php";
const MAX_FILTERED_PAGES = 100;

export default {
  async fetch(request) {
    const u = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (u.pathname === "/" || u.pathname === "/health") {
      return cors(json({
        ok: true,
        version: "6.0",
        mode: "StarCG native JSON search"
      }));
    }

    if (u.pathname === "/probe") {
      const q = (u.searchParams.get("q") || "壽喜鍋").trim();
      try {
        const data = await fetchSearch(q, "all", "all", 1);
        return cors(json({
          ok: true,
          version: "6.0",
          page: data.page,
          perPage: data.perPage,
          totalFiltered: data.totalFiltered,
          stalls: Array.isArray(data.stalls) ? data.stalls.length : 0,
          item_stalls: data.itemsByCd ? Object.keys(data.itemsByCd).length : 0,
          pet_stalls: data.petsByCd ? Object.keys(data.petsByCd).length : 0,
          sample_stall: Array.isArray(data.stalls) ? data.stalls[0] : null,
          sample_item: firstNested(data.itemsByCd),
          sample_pet: firstNested(data.petsByCd)
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

    const requestedServer = u.searchParams.get("server") || "all";
    const requestedType = u.searchParams.get("type") || "all";
    const requestedCurrency = u.searchParams.get("currency") || "all";

    try {
      // Frontend uses S1/S2/S3, StarCG API uses 1/2/3.
      const server = normalizeServerForOrigin(requestedServer);

      // Page 1 tells us exactly how many filtered rows exist.
      const first = await fetchSearch(q, server, requestedType, 1);

      const perPage = Math.max(1, Number(first.perPage || 20));
      const totalFiltered = Math.max(0, Number(first.totalFiltered || 0));
      const totalPages = Math.max(
        1,
        Math.min(MAX_FILTERED_PAGES, Math.ceil(totalFiltered / perPage))
      );

      let items = extractListings(first, q);

      // Only fetch additional pages of the ALREADY FILTERED StarCG search.
      // Example: 壽喜鍋 totalFiltered=125, perPage=20 => only pages 1..7.
      for (let page = 2; page <= totalPages; page++) {
        const data = await fetchSearch(q, server, requestedType, page);
        items.push(...extractListings(data, q));
      }

      items = dedupe(items);

      if (requestedCurrency !== "all") {
        items = items.filter(x => x.currency === requestedCurrency);
      }

      items.sort((a, b) =>
        a.price - b.price ||
        (a.server || "").localeCompare(b.server || "") ||
        (a.shop || "").localeCompare(b.shop || "")
      );

      return cors(json({
        ok: true,
        version: "6.0",
        query: q,
        source: "StarCG native AJAX JSON search",
        totalFiltered,
        result_pages: totalPages,
        count: items.length,
        items
      }));
    } catch (e) {
      return cors(json({
        error: String(e?.message || e),
        hint: "請開啟 Worker網址/probe?q=壽喜鍋 並把結果貼給 ChatGPT。"
      }, 502));
    }
  }
};

async function fetchSearch(q, server, type, page) {
  const url = new URL(MARKET);

  url.searchParams.set("page", String(page));
  url.searchParams.set("type", type);
  url.searchParams.set("server", server);
  url.searchParams.set("search", q);
  url.searchParams.set("exact", "0");
  url.searchParams.set("ajax", "1");

  const r = await fetch(url.href, {
    headers: {
      "User-Agent": "Mozilla/5.0 StarCG-Market-Compare/6.0",
      "Accept": "application/json",
      "Accept-Language": "zh-TW,zh;q=0.9",
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  if (!r.ok) throw new Error(`StarCG HTTP ${r.status}`);

  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error("StarCG AJAX 沒有回傳 JSON");
  }

  if (!data || typeof data !== "object") {
    throw new Error("StarCG JSON 格式異常");
  }

  return data;
}

function extractListings(data, query) {
  const out = [];
  const stalls = Array.isArray(data.stalls) ? data.stalls : [];
  const itemsByCd = data.itemsByCd || {};
  const petsByCd = data.petsByCd || {};

  for (const stall of stalls) {
    const cd = String(
      stall.cdkey ??
      stall.cdKey ??
      stall.CDKEY ??
      ""
    );

    if (!cd) continue;

    const common = stallInfo(stall);

    const itemRows = arrayify(itemsByCd[cd]);
    for (const item of itemRows) {
      const listing = listingFromObject(item, common, "道具", query);
      if (listing) out.push(listing);
    }

    const petRows = arrayify(petsByCd[cd]);
    for (const pet of petRows) {
      const listing = listingFromObject(pet, common, "寵物", query);
      if (listing) out.push(listing);
    }
  }

  return out;
}

function stallInfo(stall) {
  const serverNum = Number(stall.server ?? stall.SERVER ?? 0);
  const coordsText = String(stall.coords ?? "");

  let place = "";
  let east = numOrNull(stall.x);
  let south = numOrNull(stall.y);

  const cm = coordsText.match(
    /^(.*?)\s*\[\s*東\s*[:：]\s*(\d+)\s*南\s*[:：]\s*(\d+)\s*\]/
  );

  if (cm) {
    place = cm[1].trim();
    east = Number(cm[2]);
    south = Number(cm[3]);
  }

  return {
    server: serverNum >= 1 && serverNum <= 3 ? `S${serverNum}` : String(stall.server || ""),
    place,
    east,
    south,
    shop: String(stall.name ?? stall.shop ?? ""),
    expires: String(stall.expires ?? ""),
    cdkey: String(stall.cdkey ?? "")
  };
}

function listingFromObject(obj, common, type, query) {
  if (!obj || typeof obj !== "object") return null;

  const price = pickNumber(obj, [
    "price", "PRICE", "sellPrice", "sell_price"
  ]);

  if (price == null) return null;

  // The original search can return every item belonging to a matched stall.
  // Only keep the actual object whose item/pet name contains the keyword.
  const name = pickName(obj, query);

  if (!name) return null;

  const q = String(query || "").toLowerCase();
  if (q && !name.toLowerCase().includes(q)) {
    return null;
  }

  const quantity = pickQuantity(obj);
  const currency = currencyFrom(obj);

  return {
    name,
    type,
    server: common.server,
    place: common.place,
    east: common.east,
    south: common.south,
    shop: common.shop,
    expires: common.expires,
    quantity,
    price,
    unit_price: quantity > 0 ? price / quantity : price,
    currency
  };
}

function pickName(obj, query) {
  const preferred = [
    "ITEM_TRUENAME",
    "ITEM_TRUE_NAME",
    "ITEM_FIRSTNAME",
    "ITEM_FIRST_NAME",
    "ITEM_NAME",
    "itemName",
    "item_name",
    "PET_NAME",
    "PET_TRUENAME",
    "petName",
    "pet_name",
    "NAME",
    "name"
  ];

  const q = String(query || "").toLowerCase();

  // Prefer known name fields that actually contain the search keyword.
  for (const key of preferred) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) {
      if (!q || v.toLowerCase().includes(q)) return cleanName(v);
    }
  }

  // StarCG item objects contain many fields; if names move in a future
  // update, find a name-like string containing the user's keyword.
  if (q) {
    for (const [key, value] of Object.entries(obj)) {
      if (
        typeof value === "string" &&
        value.trim() &&
        value.toLowerCase().includes(q) &&
        !/memo|explanation|function|unicode|cdkey|time/i.test(key)
      ) {
        return cleanName(value);
      }
    }
  }

  // Last fallback to a known field.
  for (const key of preferred) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return cleanName(v);
  }

  return "";
}

function cleanName(v) {
  return String(v || "")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function currencyFrom(obj) {
  // If StarCG ever sends a textual currency, prefer it.
  const texts = [
    obj.currency,
    obj.currencyName,
    obj.priceTypeName,
    obj.pricetype_name
  ];

  for (const x of texts) {
    const s = String(x ?? "");
    if (s.includes("魔晶")) return "魔晶";
    if (s.includes("金幣")) return "金幣";
  }

  const p = Number(
    obj.pricetype ??
    obj.priceType ??
    obj.PRICE_TYPE ??
    0
  );

  // StarCG current market JSON:
  // pricetype 0 = 金幣
  // pricetype 1 = 魔晶
  return p === 1 ? "魔晶" : "金幣";
}

function pickQuantity(obj) {
  const keys = [
    "quantity",
    "qty",
    "count",
    "amount",
    "num",
    "sellCount",
    "sell_count",
    "ITEM_COUNT",
    "ITEM_AMOUNT"
  ];

  for (const k of keys) {
    const n = Number(obj[k]);
    if (Number.isFinite(n) && n > 0 && n < 1000000) {
      return Math.floor(n);
    }
  }

  return 1;
}

function pickNumber(obj, keys) {
  for (const k of keys) {
    if (obj[k] == null) continue;

    const n = Number(
      typeof obj[k] === "string"
        ? obj[k].replace(/,/g, "")
        : obj[k]
    );

    if (Number.isFinite(n)) return n;
  }

  return null;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeServerForOrigin(server) {
  const s = String(server || "all").toUpperCase();

  if (s === "S1" || s === "1") return "1";
  if (s === "S2" || s === "2") return "2";
  if (s === "S3" || s === "3") return "3";

  return "all";
}

function arrayify(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v);
  return [];
}

function dedupe(items) {
  const map = new Map();

  for (const x of items) {
    const key = [
      x.name,
      x.type,
      x.server,
      x.place,
      x.east,
      x.south,
      x.shop,
      x.expires,
      x.price,
      x.currency,
      x.quantity
    ].join("|");

    map.set(key, x);
  }

  return [...map.values()];
}

function firstNested(obj) {
  if (!obj || typeof obj !== "object") return null;

  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.length) return v[0];
    if (v && typeof v === "object") {
      const values = Object.values(v);
      if (values.length) return values[0];
    }
  }

  return null;
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
