// Construction du relevé et du corps POST /api/restock/releves.
// Isolée pour s'aligner sur le contrat de pvlcity-cmyk/estim #328 quand il sera figé.
// Forme actuelle (Play-In) : { lot, run, arret, duree_ms, releves }.
// Chaque relevé : { id, etat, prix, vendeur, entrepot, image, gtin }
//   ou { id, erreur } ou { id, disparue: true }.
// Champs ajoutés seulement quand ils n'affectent pas un lot Play-In seul :
//   shop sur un relevé hors Play-In ; arrets (carte par enseigne) s'il y a un arrêt hors Play-In.

/** Relevé d'une fiche. `payload` : succès, { erreur }, ou { disparue: true }. */
export function buildReleve(item, payload) {
  const releve = { id: String(item.id), ...payload };
  if (item.shop && item.shop !== "playin") releve.shop = item.shop;
  return releve;
}

/**
 * Corps envoyé à POST /api/restock/releves.
 * `arret` : arrêt de Play-In uniquement (null | "defi" | "robots"), pour ne pas
 * geler Play-In si une autre enseigne rencontre un défi.
 * `arrets` : { [shop]: "defi" | "robots" } pour toutes les enseignes arrêtées.
 */
export function buildRelevesBody({ lot, run, arret, arrets, duree_ms, releves }) {
  const body = {
    lot: typeof lot === "string" ? lot.slice(0, 64) : null,
    run: run ?? { id: null, attempt: null },
    arret: arret ?? null,
    duree_ms,
    releves,
  };
  const map = arrets && typeof arrets === "object" ? arrets : {};
  const horsPlayin = Object.keys(map).some((s) => s !== "playin");
  if (horsPlayin) body.arrets = map;
  return body;
}
