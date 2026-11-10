// Construction du relevé et du corps POST /api/restock/releves.
// Contrat pvlcity-cmyk/estim #328 (tête 2a2ed7ea) :
//   { lot, run?, arret, duree_ms, arrets?: { "<shop>": "defi"|"503" }, releves }
//   arret : Play-In seulement (null | "defi" | "robots").
//   arrets : uniquement "defi" ou "503" — jamais "robots".
//   relevé : { id, shop?, etat, prix, vendeur, entrepot, image, gtin }
//          ou { id, shop, erreur } ou { id, shop, disparue: true }.
//   Sans shop, c'est Play-In. id : chaîne, zéros de tête conservés.

import { PUBLIC_LOT_SHOPS } from "./shops.mjs";

const SHOP_SET = new Set(PUBLIC_LOT_SHOPS);
const ARRETS_OK = new Set(["defi", "503"]);
const ARRET_OK = new Set(["defi", "robots"]);

/** Relevé d'une fiche. `payload` : succès, { erreur }, ou { disparue: true }. */
export function buildReleve(item, payload) {
  const releve = { id: String(item.id), ...payload };
  if (item.shop && item.shop !== "playin") releve.shop = item.shop;
  return releve;
}

function filtrerArrets(arrets) {
  const map = arrets && typeof arrets === "object" && !Array.isArray(arrets) ? arrets : {};
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    const shop = String(key).trim().toLowerCase();
    const reason = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!SHOP_SET.has(shop) || !ARRETS_OK.has(reason)) continue;
    out[shop] = reason;
  }
  return out;
}

/**
 * Corps envoyé à POST /api/restock/releves.
 * `arret` : arrêt de Play-In uniquement (null | "defi" | "robots").
 * `arrets` : { [shop]: "defi" | "503" }, omis s'il est vide.
 */
export function buildRelevesBody({ lot, run, arret, arrets, duree_ms, releves }) {
  const body = {
    lot: typeof lot === "string" ? lot.slice(0, 64) : null,
    run: run ?? { id: null, attempt: null },
    arret: ARRET_OK.has(arret) ? arret : null,
    duree_ms,
    releves,
  };
  const map = filtrerArrets(arrets);
  if (Object.keys(map).length) body.arrets = map;
  return body;
}
