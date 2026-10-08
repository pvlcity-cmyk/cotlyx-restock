// Lecture d'une fiche produit Play-in : robots.txt, défis anti-bot, JSON-LD Product, stock de
// l'entrepôt en ligne. Fonctions pures (aucun accès réseau), testées dans test/.

export const USER_AGENT = "CotlyxBot/1.0 (+https://cotlyx.fr)";
export const PLAYIN_ORIGIN = "https://www.play-in.com";

/* ---------- robots.txt (RFC 9309) ---------- */

export function parseRobots(txt, host = new URL(PLAYIN_ORIGIN).host) {
  const groups = new Map();
  let agents = [];
  let lastWasAgent = false;
  for (const rawLine of String(txt).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) agents = [];
      agents.push(value.toLowerCase());
      for (const a of agents) if (!groups.has(a)) groups.set(a, []);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key !== "allow" && key !== "disallow") continue;
    let pattern = value;
    if (/^https?:\/\//i.test(pattern)) {
      try {
        const u = new URL(pattern);
        if (u.host !== host) continue;
        pattern = u.pathname + u.search;
      } catch {
        continue;
      }
    }
    if (key === "disallow" && pattern === "") continue;
    for (const a of agents) groups.get(a)?.push({ allow: key === "allow", pattern });
  }
  return groups;
}

function patternToRegex(p) {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Règle la plus longue gagne ; à égalité, Allow gagne. */
export function robotsAllows(groups, pathAndQuery, userAgent = USER_AGENT) {
  const token = userAgent.split("/")[0].trim().toLowerCase();
  const rules = groups.get(token) ?? groups.get("*") ?? [];
  let best = null;
  for (const r of rules) {
    if (!r.pattern) continue;
    if (!patternToRegex(r.pattern).test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

/* ---------- Défis anti-bot : on s'arrête, on ne contourne jamais ---------- */

export function detectChallenge(status, headers, html) {
  if (status === 403 || status === 429 || status === 503) return "http";
  if (headers?.get?.("cf-mitigated")) return "defi";
  const head = String(html).slice(0, 200_000);
  if (/<title>\s*Just a moment/i.test(head)) return "defi";
  if (/_cf_chl_opt|cf-chl-widget|challenges\.cloudflare\.com\/turnstile/i.test(head)) return "defi";
  if (/captcha-delivery\.com|geo\.captcha-delivery/i.test(head)) return "defi";
  if (/Attention Required! \| Cloudflare/i.test(head)) return "defi";
  if (/_Incapsula_Resource|Request unsuccessful\. Incapsula/i.test(head)) return "defi";
  return null;
}

/* ---------- Fiche produit ---------- */

export function isPlayinProductUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.host === "www.play-in.com" && /^\/fr\/produit\/\d+(\/|$)/.test(u.pathname) && !u.search;
  } catch {
    return false;
  }
}

/** Fiche redirigée vers une autre page (catégorie, accueil) : fiche disparue, pas une rupture. */
export function redirectGone(id, redirected, finalUrl) {
  if (!redirected || !finalUrl) return false;
  try {
    const got = /\/produit\/(\d{1,12})(?:[/?#]|$)/.exec(new URL(finalUrl).pathname)?.[1] ?? null;
    return got !== String(id);
  } catch {
    return false;
  }
}

const AVAIL = {
  instock: "in_stock",
  limitedavailability: "in_stock",
  onlineonly: "in_stock",
  instoreonly: "out_of_stock",
  preorder: "preorder",
  presale: "preorder",
  outofstock: "out_of_stock",
  soldout: "out_of_stock",
  discontinued: "out_of_stock",
  backorder: "out_of_stock",
};

function mapAvailability(v) {
  const key = String(v ?? "").trim().replace(/^https?:\/\/schema\.org\//i, "").toLowerCase();
  return AVAIL[key] ?? "unknown";
}

function walk(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const t = node["@type"];
  if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) out.push(node);
  if (node["@graph"]) walk(node["@graph"], out);
}

/** Prix en euros ; 0, négatif ou illisible = inconnu (null). */
export function price(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
}

function firstImage(v) {
  for (const x of Array.isArray(v) ? v : [v]) {
    const u = typeof x === "string" ? x : x && typeof x === "object" ? x.url ?? x.contentUrl : null;
    if (typeof u === "string" && /^https:\/\/[^\s"'<>]{1,490}$/.test(u.trim())) return u.trim();
  }
  return null;
}

/** État de l'entrepôt en ligne : ProductStore avec store._id = 0 et warehouse = true. */
export function warehouseState(html, sku) {
  if (!sku || !/^\d{1,12}$/.test(sku)) return null;
  const u = html.includes('\\"') ? html.replace(/\\"/g, '"') : html;
  const idRe = new RegExp(`"_id":${sku}[,}]`, "g");
  for (let m = idRe.exec(u); m; m = idRe.exec(u)) {
    const j = u.indexOf('"productStores":{', m.index);
    if (j < 0 || j - m.index > 6000) continue;
    const end = u.indexOf("]}", j);
    const seg = u.slice(j, end < 0 ? j + 20_000 : end);
    for (const part of seg.split('{"__typename":"ProductStore"').slice(1)) {
      const state = /"storeStockState":"([A-Z_]{3,40})"/.exec(part)?.[1];
      const store = /"store":\{([^{}]*)\}/.exec(part)?.[1] ?? "";
      if (state && /"_id":0(?:[,}]|$)/.test(store) && /"warehouse":true/.test(store)) return state;
    }
    return null;
  }
  return null;
}

const SELLER_PLAYIN = /^play[\s-]?in\b/i;

function sellerName(o) {
  const s = o.seller;
  if (!s) return null;
  if (typeof s === "string") return s.trim() || null;
  if (typeof s === "object" && typeof s.name === "string" && s.name.trim()) return s.name.trim();
  return null;
}

/**
 * État utile d'une fiche. En stock SEULEMENT si l'entrepôt en ligne (store._id = 0,
 * warehouse = true) est STOCK_IN_WAREHOUSE. STOCK_IN_STORE et OUT_OF_STOCK = rupture.
 * JSON-LD « en stock » sans donnée d'entrepôt = inconnu (aucune transition côté Cotlyx).
 * null si la page n'a pas de Product JSON-LD.
 */
export function readProduct(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const products = [];
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      walk(JSON.parse(m[1].trim()), products);
    } catch {
      /* bloc invalide ignoré */
    }
  }
  const p = products[0];
  if (!p) return null;
  const offers = (Array.isArray(p.offers) ? p.offers : p.offers ? [p.offers] : []).filter(
    (o) => o && typeof o === "object" && (!o.priceCurrency || String(o.priceCurrency).toUpperCase() === "EUR"),
  );
  const own = offers.filter((o) => {
    const n = sellerName(o);
    return !n || SELLER_PLAYIN.test(n);
  });
  const vendeur = own.length > 0 || offers.length === 0;
  let etat = "unknown";
  let prix = null;
  for (const o of own) {
    const a = mapAvailability(o.availability);
    const pr = price(o.price ?? o.lowPrice);
    if (a === "in_stock" || a === "preorder") {
      if (etat !== "in_stock") etat = a;
      if (pr != null) prix = prix == null ? pr : Math.min(prix, pr);
    } else if (etat === "unknown" && a !== "unknown") {
      etat = a;
      if (prix == null) prix = pr;
    } else if (prix == null && pr != null) prix = pr;
  }
  const sku = p.sku != null ? String(p.sku).slice(0, 64) : null;
  const entrepot = warehouseState(html, sku);
  if (entrepot === "STOCK_IN_WAREHOUSE") {
    if (etat !== "preorder") etat = "in_stock";
  } else if (entrepot === "STOCK_IN_STORE" || entrepot === "OUT_OF_STOCK") {
    etat = "out_of_stock";
  } else if (etat === "in_stock") {
    etat = "unknown";
  }
  const g = p.gtin13 ?? p.gtin14 ?? p.gtin ?? p.gtin12 ?? p.gtin8 ?? null;
  const gtin = g != null && /^\d{8,14}$/.test(String(g).trim()) ? String(g).trim() : null;
  return { etat, prix, vendeur, entrepot, image: firstImage(p.image), gtin };
}
