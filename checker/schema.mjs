// Helpers de lecture schema.org (microdonnées et JSON-LD), portés depuis
// pvlcity-cmyk/estim src/lib/server/restock-pages.ts et restock-playin.ts.
// Fonctions pures : aucun accès réseau. Aucun prix inventé : illisible ou ≤ 0 → null.

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

/** Mappe une valeur schema.org (URL ou jeton) vers in_stock / preorder / out_of_stock / unknown. */
export function mapSchemaAvailability(v) {
  const key = String(v ?? "").trim().replace(/^https?:\/\/schema\.org\//i, "").toLowerCase();
  return AVAIL[key] ?? "unknown";
}

/** Prix en euros ; 0, négatif ou illisible = inconnu (null). Jamais inventé. */
export function price(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
}

/** EAN / GTIN : longueur et clé de contrôle vérifiées (jamais une sku). */
export function normalizeEan(v) {
  const s = String(v ?? "").replace(/[\s-]/g, "");
  if (!/^(\d{8}|\d{12,14})$/.test(s)) return null;
  const digits = s.split("").map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  if ((10 - (sum % 10)) % 10 !== check) return null;
  if (s.length === 12) return `0${s}`;
  if (s.length === 14 && s.startsWith("0")) return s.slice(1);
  return s;
}

function firstImage(v) {
  for (const x of Array.isArray(v) ? v : [v]) {
    const u = typeof x === "string" ? x : x && typeof x === "object" ? x.url ?? x.contentUrl : null;
    if (typeof u === "string" && /^https:\/\/[^\s"'<>]{1,490}$/.test(u.trim())) return u.trim();
  }
  return null;
}

function sellerName(o) {
  const s = o.seller;
  if (!s) return null;
  if (typeof s === "string") return s.trim() || null;
  if (typeof s === "object" && typeof s.name === "string" && s.name.trim()) return s.name.trim();
  return null;
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

/**
 * Premier Product JSON-LD de la page, ou null.
 * `sellerRe` : vendeur maison ; une offre d'un autre vendeur nommé n'est jamais retenue.
 * Les type=application/ld+json sans guillemets (PrestaShop / BCD) sont lus.
 * Pas de logique d'entrepôt Play-In.
 */
export function parseProductJsonLd(html, { sellerRe } = {}) {
  // Guillemets optionnels : source restock-playin.ts (fiches BCD).
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
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
  const own = sellerRe
    ? offers.filter((o) => {
        const n = sellerName(o);
        return !n || sellerRe.test(n);
      })
    : offers;
  const vendeur = own.length > 0 || offers.length === 0;
  let etat = "unknown";
  let prix = null;
  for (const o of own) {
    const a = mapSchemaAvailability(o.availability);
    const pr = price(o.price ?? o.lowPrice);
    if (a === "in_stock" || a === "preorder") {
      if (etat !== "in_stock") etat = a;
      if (pr != null) prix = prix == null ? pr : Math.min(prix, pr);
    } else if (etat === "unknown" && a !== "unknown") {
      etat = a;
      if (prix == null) prix = pr;
    } else if (prix == null && pr != null) prix = pr;
  }
  const g = p.gtin13 ?? p.gtin14 ?? p.gtin ?? p.gtin12 ?? p.gtin8 ?? null;
  return {
    etat,
    prix,
    vendeur,
    entrepot: null,
    image: firstImage(p.image),
    gtin: normalizeEan(g),
  };
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "").trim() : null;
}

function itemprops(html, prop) {
  const re = new RegExp(`<[a-z]+\\b[^>]*\\bitemprop\\s*=\\s*["']${prop}["'][^>]*>`, "gi");
  return [...html.matchAll(re)].map((m) => m[0]);
}

/** Microdata schema.org : prix meta[itemprop=price]@content, stock [itemprop=availability]@content|href. */
export function parseProductMicrodata(html) {
  const priceTag = itemprops(html, "price")[0];
  const availTag = itemprops(html, "availability")[0];
  if (!priceTag && !availTag) return null;
  const rawPrice = priceTag ? attr(priceTag, "content") : null;
  const prix = price(rawPrice);
  const etat = availTag ? mapSchemaAvailability(attr(availTag, "content") ?? attr(availTag, "href")) : "unknown";
  const gtinTag = itemprops(html, "gtin13")[0];
  return {
    etat,
    prix,
    vendeur: true,
    entrepot: null,
    image: null,
    gtin: normalizeEan(gtinTag ? attr(gtinTag, "content") : null),
  };
}
