// Lecteur JSON-LD générique : Smartoys, BCD, PokéMaël, TZP, Gentlemen.
// Source portée : pvlcity-cmyk/estim src/lib/server/restock-pages.ts
//   (JSONLD_SHOPS, isJsonLdShopProductUrl, parseJsonLdShopPage) et
//   restock-playin.ts (parseProductJsonLd, sans la logique d'entrepôt Play-In).
// Fonctions pures, aucun réseau. La sku n'est jamais prise pour un EAN.
import { parseProductJsonLd } from "./schema.mjs";

export const JSONLD_SHOPS = {
  smartoys: { origin: "https://www.smartoys.be", host: "www.smartoys.be", path: /^\/catalog\/[a-z0-9-]+-p-([0-9]{8,14})\.html$/, seller: /^smartoys\b/i },
  bcd: { origin: "https://www.bcd-jeux.fr", host: "www.bcd-jeux.fr", path: /^\/[a-z0-9-]+\/([0-9]{1,9})-[a-z0-9-]+\.html$/, seller: /^bcd[\s-]?jeux\b/i },
  tzp: { origin: "https://www.tzp.fr", host: "www.tzp.fr", path: /^\/[a-z0-9-]+\/([0-9]{1,9})-[a-z0-9-]+\.html$/, seller: /^tzp(\.fr)?\b/i },
  pokemael: { origin: "https://pokemael.com", host: "pokemael.com", path: /^\/products\/[a-z0-9-]{1,200}$/, seller: /^pok[ée]ma[ëe]l\b/i },
  gentlemen: { origin: "https://lesgentlemendujeu.com", host: "lesgentlemendujeu.com", path: /^\/[a-z0-9-]+\/([0-9]{1,9})-[a-z0-9-]+\.html$/, seller: /^les\s+gentlemen\s+du\s+jeu\b/i },
};

export const JSONLD_SHOP_NAMES = Object.keys(JSONLD_SHOPS);

/** Fiche d'une enseigne JSON-LD : https, bon hôte, motif connu, aucun « ? » ni « # ». */
export function isJsonLdShopProductUrl(shop, url) {
  if (typeof url !== "string") return false;
  const c = JSONLD_SHOPS[shop];
  if (!c) return false;
  if (url.includes("?") || url.includes("#") || url.length > 500) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.host === c.host && c.path.test(u.pathname);
  } catch {
    return false;
  }
}

/** JSON-LD Product avec le vendeur maison de l'enseigne ; EAN : clés gtin seulement. */
export function parseJsonLdShopPage(shop, html) {
  const c = JSONLD_SHOPS[shop];
  if (!c) return null;
  return parseProductJsonLd(html, { sellerRe: c.seller });
}

export function readJsonLdShop(shop, html) {
  return parseJsonLdShopPage(shop, html);
}
