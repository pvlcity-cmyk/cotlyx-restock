// Dispatcher : chaque item du lot est lu selon son champ `shop`.
// Play-In passe par checker/playin.mjs, sans en modifier le comportement.
// Les autres enseignes : Ultrajeux (microdonnées), Smartoys / BCD / PokéMaël /
// TZP / Gentlemen (JSON-LD). La Grande Récré n'est pas lue (pause).
// Politesse : UA CotlyxBot/1.0, robots.txt, 3 à 4 s entre deux requêtes de la
// même enseigne, arrêt au premier défi de cette enseigne, aucun contournement.
// Gentlemen : arrêt aussi au premier 503.
import {
  USER_AGENT,
  PLAYIN_ORIGIN,
  parseRobots,
  robotsAllows,
  detectChallenge,
  isPlayinProductUrl,
  redirectGone,
  readProduct,
  softGone,
} from "./playin.mjs";
import { withRetry } from "./retry.mjs";
import { ULTRAJEUX_ORIGIN, isUltrajeuxProductUrl, readUltrajeux } from "./ultrajeux.mjs";
import { JSONLD_SHOPS, isJsonLdShopProductUrl, readJsonLdShop } from "./jsonld-shop.mjs";
import { buildReleve } from "./releve.mjs";
import { PUBLIC_LOT_SHOPS } from "./shops.mjs";
import { POST_RESERVE_MS, FETCH_MARGIN_MS, reliquatJusqua } from "./budget.mjs";

export { buildReleve, buildRelevesBody } from "./releve.mjs";
export { PUBLIC_LOT_SHOPS } from "./shops.mjs";
export { POST_RESERVE_MS, FETCH_MARGIN_MS } from "./budget.mjs";

/** Délai plancher entre deux fiches d'une même enseigne hors Play-In (4 s, ticket). */
export const SHOP_DELAY_MS = 4000;

const PUBLIC_LOT_SET = new Set(PUBLIC_LOT_SHOPS);

export const SHOP_ORIGINS = {
  playin: PLAYIN_ORIGIN,
  ultrajeux: ULTRAJEUX_ORIGIN,
  ...Object.fromEntries(Object.entries(JSONLD_SHOPS).map(([k, v]) => [k, v.origin])),
};

export const MAX_REDIRECTS = 3;
export const ROBOTS_TIMEOUT_MS = 15_000;
export const PAGE_TIMEOUT_MS = 20_000;

/** Hôtes autorisés par enseigne : l'hôte de l'origine, plus d'éventuels alias www/apex. */
export const SHOP_HOSTS = {
  playin: ["www.play-in.com", "play-in.com"],
  ultrajeux: ["www.ultrajeux.com", "ultrajeux.com"],
  smartoys: ["www.smartoys.be", "smartoys.be"],
  bcd: ["www.bcd-jeux.fr", "bcd-jeux.fr"],
  pokemael: ["pokemael.com", "www.pokemael.com"],
  tzp: ["www.tzp.fr", "tzp.fr"],
  gentlemen: ["lesgentlemendujeu.com", "www.lesgentlemendujeu.com"],
};

export function hostsAutorises(shop) {
  return new Set(SHOP_HOSTS[shop] ?? []);
}

/** URL https dont l'hôte est dans la liste de l'enseigne. */
export function urlHoteAutorise(shop, url) {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return u.protocol === "https:" && hostsAutorises(shop).has(u.host);
  } catch {
    return false;
  }
}

function estRedirection(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function finaliserReponse(res, url, redirected) {
  Object.defineProperty(res, "url", { value: url, configurable: true });
  Object.defineProperty(res, "redirected", { value: redirected, configurable: true });
  return res;
}

/**
 * GET avec redirect:manual. On ne suit une redirection que si l'hôte d'arrivée
 * est autorisé pour l'enseigne, https, au plus MAX_REDIRECTS sauts.
 * Sinon { interdit: true } → relevé http_autre (page) ou échec robots.
 */
export async function fetchManuel(fetchImpl, url, { headers, signal, shop }) {
  let current = url;
  let redirected = false;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current, { headers, redirect: "manual", signal });
    if (!estRedirection(res.status)) return finaliserReponse(res, current, redirected);
    const loc = res.headers.get("location");
    if (!loc || hop === MAX_REDIRECTS) return { interdit: true };
    let next;
    try {
      next = new URL(loc, current);
    } catch {
      return { interdit: true };
    }
    if (!urlHoteAutorise(shop, next)) return { interdit: true };
    redirected = true;
    current = next.href;
  }
  return { interdit: true };
}

const JSONLD_NAMES = new Set(Object.keys(JSONLD_SHOPS));

export function isKnownShop(shop) {
  return PUBLIC_LOT_SET.has(shop);
}

/** shop absent ou vide → playin (contrat : sans shop, c'est Play-In). */
export function shopOf(item) {
  const s = typeof item?.shop === "string" ? item.shop.trim().toLowerCase() : "";
  if (!s) return "playin";
  return isKnownShop(s) ? s : null;
}

export function isProductUrl(shop, url) {
  if (shop === "playin") return isPlayinProductUrl(url);
  if (shop === "ultrajeux") return isUltrajeuxProductUrl(url);
  if (JSONLD_NAMES.has(shop)) return isJsonLdShopProductUrl(shop, url);
  return false;
}

/** Identifiant de fiche : 1 à 20 chiffres, toujours une chaîne (zéros de tête conservés). */
export function idChaine(raw) {
  if (typeof raw === "string" && /^\d{1,20}$/.test(raw)) return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    const s = String(raw);
    return /^\d{1,20}$/.test(s) ? s : null;
  }
  return null;
}

/**
 * Filtre et normalise les items du lot. Les enseignes hors liste blanche, LGR, Vinticards
 * et les URL hors motif sont écartées. L'id reste une chaîne, zéros de tête inclus.
 */
export function preparerItems(raw, max = 40) {
  const out = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x) continue;
    const id = idChaine(x.id);
    if (!id) continue;
    const shop = shopOf(x);
    if (!shop) continue;
    if (!isProductUrl(shop, x.url)) continue;
    out.push({ id, url: x.url, shop });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Défi qui arrête l'enseigne. Play-In : comportement actuel (403 / 429 / 503 + pages de défi).
 * Gentlemen : 503 inclus. Autres enseignes : pages de défi, 403 et 429 ; un 503 sans page
 * de défi est une erreur HTTP (le ticket réserve l'arrêt 503 à Gentlemen).
 * Aucun contournement.
 */
export function shopChallenge(shop, status, headers, html) {
  if (shop === "playin") return detectChallenge(status, headers, html);
  if (shop === "gentlemen" && status === 503) return "http";
  if (status === 503) return detectChallenge(200, headers, html);
  return detectChallenge(status, headers, html);
}

/** Valeur autorisée dans `arrets` : "defi" ou "503". Jamais "robots". */
export function raisonArrets(shop, status, headers, html) {
  if (!shopChallenge(shop, status, headers, html)) return null;
  return shop === "gentlemen" && status === 503 ? "503" : "defi";
}

function readPage(shop, html) {
  if (shop === "playin") return readProduct(html);
  if (shop === "ultrajeux") return readUltrajeux(html);
  return readJsonLdShop(shop, html);
}

/** Redirection vers une autre page (catégorie, accueil) : fiche disparue, pas une rupture. */
function redirectGoneShop(shop, item, redirected, finalUrl) {
  if (shop === "playin") return redirectGone(item.id, redirected, finalUrl);
  if (!redirected || !finalUrl) return false;
  try {
    const a = new URL(item.url);
    const b = new URL(finalUrl);
    return !(a.host === b.host && a.pathname === b.pathname);
  } catch {
    return false;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function groupByShop(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.shop)) map.set(it.shop, []);
    map.get(it.shop).push(it);
  }
  const order = [];
  if (map.has("playin")) order.push("playin");
  for (const k of map.keys()) if (k !== "playin") order.push(k);
  return { map, order };
}

export function reliquatLecture(nowMs, t0, budgetMs, reserveMs = POST_RESERVE_MS) {
  return reliquatJusqua(nowMs, t0 + budgetMs - reserveMs);
}

/**
 * Lit les fiches du lot, enseigne par enseigne.
 * Un défi n'arrête que cette enseigne. Play-In d'abord, même délai et mêmes règles qu'aujourd'hui.
 * Échéance absolue : deadline (t0 + budget). La lecture s'arrête plus tôt d'une réserve POST.
 * Cadence par enseigne (retries compris) : au moins `delay` depuis le départ de la
 * requête précédente. Éligibilité revue au départ effectif, après le backoff :
 * reliquat ≥ délai de politesse + 1 s, et timeout minimal utile (FETCH_MARGIN_MS).
 * Les items non traités ne sont pas renvoyés.
 */
export async function lireLot(items, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const t0 = opts.t0 ?? now();
  const budget = opts.budgetMs ?? 200_000;
  const reserve = opts.reserveMs ?? POST_RESERVE_MS;
  const deadline = opts.deadline ?? t0 + budget;
  const lectureDeadline = deadline - reserve;
  const timeoutFn = opts.timeoutFn ?? ((ms) => AbortSignal.timeout(ms));
  const delayPlayin = opts.delayPlayinMs ?? 3000;
  const delayShop = Math.max(SHOP_DELAY_MS, opts.delayShopMs ?? opts.delayPlayinMs ?? SHOP_DELAY_MS);
  const log = opts.log ?? (() => {});
  const retryLog = (quoi) => (k, why) => log(`${quoi} : nouvelle tentative ${k}/2 (${why})`);

  const n = { lus: 0, ok: 0, disparues: 0, reseau: 0, http: 0, robots: 0, jsonld: 0, defi: 0, temps: 0 };
  const releves = [];
  const arrets = {};
  let playinStop = null;
  const lastStart = new Map();
  const headers = { "user-agent": USER_AGENT, "accept-language": "fr-FR,fr;q=0.9", accept: "text/html,application/xhtml+xml" };

  const reliquat = () => reliquatJusqua(now(), lectureDeadline);
  const reliquatTotal = () => reliquatJusqua(now(), deadline);
  const peutReseau = (besoin = FETCH_MARGIN_MS) => reliquat() >= besoin;
  const peutLireFiche = (delay) => reliquat() >= delay + FETCH_MARGIN_MS;
  const signalBorne = (maxMs) => {
    const left = reliquat();
    if (left < FETCH_MARGIN_MS) return null;
    return timeoutFn(Math.min(maxMs, left));
  };

  /** Attend la cadence depuis le départ de la requête précédente. Pas d'attente partielle. */
  async function attendreCadence(shop, delay) {
    const prev = lastStart.get(shop);
    if (prev == null) return true;
    const wait = prev + delay - now();
    if (wait <= 0) return true;
    if (now() + wait > deadline) return false;
    // Après l'attente, il doit rester de quoi partir : politesse + 1 s (et la marge réseau).
    if (now() + wait + delay + FETCH_MARGIN_MS > lectureDeadline) return false;
    await sleep(wait);
    return reliquatTotal() > 0 && peutLireFiche(delay);
  }

  function backoffCadence(shop, delay, i) {
    const standard = i === 0 ? 2000 : 5000;
    const prev = lastStart.get(shop);
    const waitCadence = prev == null ? 0 : Math.max(0, prev + delay - now());
    return Math.max(standard, waitCadence);
  }

  const { map, order } = groupByShop(items);

  for (const shop of order) {
    const group = map.get(shop);
    const origin = SHOP_ORIGINS[shop];
    const delay = shop === "playin" ? delayPlayin : delayShop;
    let groups = null;
    let stop = null;

    if (!peutLireFiche(delay) || !peutReseau()) {
      n.temps += group.length;
      continue;
    }

    const canRetryApres = (wait = 0) => {
      if (wait < 0) wait = 0;
      if (now() + wait > deadline) return false;
      if (now() + wait + FETCH_MARGIN_MS > lectureDeadline) return false;
      // Après le backoff, il faudra encore reliquat ≥ politesse + 1 s.
      return lectureDeadline - (now() + wait) >= delay + FETCH_MARGIN_MS;
    };
    const canAttemptShop = () => peutLireFiche(delay) && peutReseau() && reliquatTotal() > 0;

    try {
      const got = await withRetry(
        async () => {
          if (!(await attendreCadence(shop, delay))) throw Object.assign(new Error("budget"), { name: "TimeoutError" });
          if (!canAttemptShop()) throw Object.assign(new Error("budget"), { name: "TimeoutError" });
          const signal = signalBorne(ROBOTS_TIMEOUT_MS);
          if (!signal) throw Object.assign(new Error("budget"), { name: "TimeoutError" });
          lastStart.set(shop, now());
          return fetchManuel(fetchImpl, `${origin}/robots.txt`, { headers, signal, shop });
        },
        {
          backoffMs: (i) => backoffCadence(shop, delay, i),
          canRetry: canRetryApres,
          canAttempt: canAttemptShop,
          sleepImpl: sleep,
          onRetry: retryLog("robots.txt"),
        },
      );
      if (got?.interdit) {
        stop = "robots";
      } else {
        const r = got;
        const txt = await r.text();
        const raison = raisonArrets(shop, r.status, r.headers, txt);
        if (raison) stop = raison;
        else if (!r.ok) stop = "robots";
        else groups = parseRobots(txt, new URL(origin).host);
      }
    } catch {
      stop = "robots";
    }

    if (stop) {
      if (stop === "defi" || stop === "503") {
        arrets[shop] = stop;
        n.defi += 1;
      }
      if (shop === "playin") playinStop = stop === "503" ? "defi" : stop;
      continue;
    }

    for (const it of group) {
      if (!peutLireFiche(delay)) {
        n.temps += 1;
        continue;
      }
      const u = new URL(it.url);
      if (!robotsAllows(groups, u.pathname + u.search)) {
        n.robots += 1;
        releves.push(buildReleve(it, { erreur: "robots" }));
        continue;
      }
      if (!(await attendreCadence(shop, delay))) {
        n.temps += 1;
        continue;
      }
      if (!peutLireFiche(delay) || !peutReseau()) {
        n.temps += 1;
        continue;
      }
      n.lus += 1;
      let res;
      let html = "";
      try {
        ({ res, html } = await withRetry(
          async () => {
            if (!(await attendreCadence(shop, delay))) throw Object.assign(new Error("budget"), { name: "TimeoutError" });
            if (!canAttemptShop()) throw Object.assign(new Error("budget"), { name: "TimeoutError" });
            const signal = signalBorne(PAGE_TIMEOUT_MS);
            if (!signal) throw Object.assign(new Error("budget"), { name: "TimeoutError" });
            lastStart.set(shop, now());
            const got = await fetchManuel(fetchImpl, it.url, { headers, signal, shop });
            if (got?.interdit) return { res: null, html: "", interdit: true };
            return { res: got, html: await got.text() };
          },
          {
            backoffMs: (i) => backoffCadence(shop, delay, i),
            canRetry: canRetryApres,
            canAttempt: canAttemptShop,
            sleepImpl: sleep,
            onRetry: retryLog("fiche"),
          },
        ));
        if (res == null) {
          n.http += 1;
          releves.push(buildReleve(it, { erreur: "http_autre" }));
          continue;
        }
      } catch {
        n.reseau += 1;
        releves.push(buildReleve(it, { erreur: "reseau" }));
        continue;
      }
      const raison = raisonArrets(shop, res.status, res.headers, html);
      if (raison) {
        n.defi += 1;
        stop = raison;
        arrets[shop] = raison;
        if (shop === "playin") playinStop = "defi";
        releves.push(buildReleve(it, { erreur: "defi" }));
        break;
      }
      if (res.ok && redirectGoneShop(shop, it, res.redirected, res.url)) {
        n.disparues += 1;
        releves.push(buildReleve(it, { disparue: true }));
        continue;
      }
      if (!res.ok) {
        n.http += 1;
        releves.push(buildReleve(it, { erreur: `http_${res.status === 404 || res.status === 410 ? "absente" : "autre"}` }));
        continue;
      }
      const p = readPage(shop, html);
      if (shop === "playin" && !p && softGone(html)) {
        n.disparues += 1;
        releves.push(buildReleve(it, { disparue: true }));
        continue;
      }
      if (!p) {
        n.jsonld += 1;
        releves.push(buildReleve(it, { erreur: "jsonld" }));
        continue;
      }
      n.ok += 1;
      releves.push(buildReleve(it, { etat: p.etat, prix: p.prix, vendeur: p.vendeur, entrepot: p.entrepot, image: p.image, gtin: p.gtin }));
    }
  }

  return { releves, n, arret: playinStop, arrets };
}
