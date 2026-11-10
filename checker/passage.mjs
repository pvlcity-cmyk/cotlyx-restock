// Contrat du lot et des relevés (pvlcity-cmyk/estim #328, tête 2a2ed7ea).
// GET /api/restock/lot?shops=… — 204 sans corps : sortie propre, aucun POST.
// POST /api/restock/releves — voir checker/releve.mjs.
// Échéance absolue unique (t0 + budget, 240 s au plus), transmise à OIDC, POST et retries.
import { PUBLIC_LOT_SHOPS } from "./shops.mjs";
import { preparerItems, lireLot, SHOP_DELAY_MS } from "./dispatch.mjs";
import { buildRelevesBody } from "./releve.mjs";
import {
  POST_RESERVE_MS,
  FETCH_MARGIN_MS,
  BUDGET_MAX_MS,
  BUDGET_DEFAULT_MS,
  reliquatJusqua,
} from "./budget.mjs";

export { PUBLIC_LOT_SHOPS, POST_RESERVE_MS, BUDGET_MAX_MS, FETCH_MARGIN_MS };

/** Query `shops=` : liste blanche du contrat, dans cet ordre. Le serveur en fait l'intersection. */
export const LOT_SHOPS_QUERY = PUBLIC_LOT_SHOPS.join(",");

export function lotPath() {
  return `/api/restock/lot?shops=${LOT_SHOPS_QUERY}`;
}

const PLAYIN_DELAY_MS = 3000;

/**
 * delayMs fourni est respecté, sans descendre sous la politesse : 3 s Play-In, 4 s les autres.
 * budgetMs fourni est respecté, plafonné au budget max du passage (timeout Actions).
 */
export function délaisDuLot(lot) {
  const asked = Number(lot?.delayMs);
  const base = Number.isFinite(asked) && asked > 0 ? asked : PLAYIN_DELAY_MS;
  return {
    delayPlayinMs: Math.max(PLAYIN_DELAY_MS, base),
    delayShopMs: Math.max(SHOP_DELAY_MS, base),
  };
}

export function budgetDuLot(lot) {
  const asked = Number(lot?.budgetMs);
  const v = Number.isFinite(asked) && asked > 0 ? asked : BUDGET_DEFAULT_MS;
  return Math.min(BUDGET_MAX_MS, v);
}

/**
 * Un passage complet : demande le lot, lit les fiches, envoie les relevés.
 * `getLot(path)` et `postReleves(body)` sont injectés (OIDC dans check.mjs, faux objets en test).
 * 204 → code 0, aucun POST.
 * Si l'échéance tombe avant le POST : log, pas de POST (le lot n'est pas consommé).
 */
export async function runPassage(deps) {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep;
  const now = deps.now ?? Date.now;
  const t0 = deps.t0 ?? now();
  let deadline = deps.deadline ?? t0 + BUDGET_MAX_MS;
  deps.setDeadline?.(deadline);

  if (deps.prefetchOidc) {
    try {
      await deps.prefetchOidc();
    } catch (err) {
      log(`jeton OIDC indisponible : ${String(err?.message ?? err).slice(0, 80)}`);
      return 1;
    }
  }

  const lotRes = await deps.getLot(lotPath());
  if (lotRes.status === 204) {
    log("rien à lire pour ce créneau");
    return 0;
  }
  if (!lotRes.ok) {
    log(`lot indisponible (HTTP ${lotRes.status})`);
    return lotRes.status === 409 ? 0 : 1;
  }
  const lot = await lotRes.json().catch(() => null);
  const items = preparerItems(lot?.items);
  const { delayPlayinMs, delayShopMs } = délaisDuLot(lot);
  const budgetMs = budgetDuLot(lot);
  deadline = Math.min(deadline, t0 + budgetMs);
  deps.setDeadline?.(deadline);
  if (!items.length) {
    log("lot vide");
    return 0;
  }

  const { releves, n, arret, arrets } = await lireLot(items, {
    delayPlayinMs,
    delayShopMs,
    budgetMs,
    deadline,
    t0,
    now,
    sleep,
    fetchImpl: deps.fetchImpl,
    log,
  });

  const left = reliquatJusqua(now(), deadline);
  if (left < FETCH_MARGIN_MS) {
    log("échéance atteinte : relevés non envoyés, le lot restera disponible");
    return 0;
  }

  const duree = now() - t0;
  const body = buildRelevesBody({
    lot: typeof lot?.lot === "string" ? lot.lot.slice(0, 64) : null,
    run: deps.run ?? { id: null, attempt: null },
    arret,
    arrets,
    duree_ms: duree,
    releves,
  });
  let post;
  try {
    post = await deps.postReleves(body);
  } catch (err) {
    log(`relevés non envoyés : ${String(err?.message ?? err).slice(0, 80)}`);
    return 0;
  }
  const recu = post.ok || (post.status === 409 && post.essais > 1);
  log(`bilan ${JSON.stringify({ demandees: items.length, ...n, arret, duree_s: Math.round((now() - t0) / 100) / 10, envoi: post.status, essais: post.essais })}`);
  return recu ? 0 : 1;
}
