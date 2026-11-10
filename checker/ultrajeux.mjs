// Lecteur Ultrajeux : fiche produit en microdonnées schema.org.
// Source portée : pvlcity-cmyk/estim src/lib/server/restock-pages.ts
//   (isUltrajeuxProductUrl, parseProductMicrodata). Fonctions pures, aucun réseau.
import { parseProductMicrodata } from "./schema.mjs";

export const ULTRAJEUX_ORIGIN = "https://www.ultrajeux.com";

/** Fiche Ultrajeux : https://www.ultrajeux.com/produit-<id>-<slug>.html, sans requête ; jamais search3.php. */
export function isUltrajeuxProductUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.host === "www.ultrajeux.com" &&
      /^\/produit-\d{1,9}-[a-z0-9-]{1,200}\.html$/.test(u.pathname) &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

export { parseProductMicrodata };

/** État utile d'une fiche Ultrajeux, ou null si aucune microdonnée prix/stock. */
export function readUltrajeux(html) {
  return parseProductMicrodata(html);
}
