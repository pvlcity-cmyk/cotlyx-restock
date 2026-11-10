// Appels à Cotlyx (OIDC GitHub Actions, GET lot, POST relevés).
// Le jeton est obtenu une fois, avant la lecture des pages, et réutilisé.
// Les JWT OIDC de GitHub Actions durent 5 minutes par défaut
// (docs : About security hardening with OpenID Connect), soit plus que
// le budget max du passage (240 s). On lit aussi le champ exp du JWT.
// Tous les appels (OIDC, GET, POST, retries) sont bornés à une échéance
// absolue unique : timeout = min(nominal, reliquat), pas de backoff s'il
// dépasse le reliquat, éligibilité revue après chaque backoff.
import { withRetry } from "./retry.mjs";
import {
  FETCH_MARGIN_MS,
  OIDC_TIMEOUT_MS,
  POST_TIMEOUT_MS,
  OIDC_DUREE_DEFAUT_MS,
  OIDC_MARGE_MS,
} from "./budget.mjs";

export const AUDIENCE = "https://cotlyx.fr/restock";
export const COTLYX_ORIGIN = "https://cotlyx.fr";
export const CLIENT_UA = "CotlyxRestock/1.0 (+https://github.com/pvlcity-cmyk/cotlyx-restock)";
export { OIDC_TIMEOUT_MS, POST_TIMEOUT_MS, OIDC_DUREE_DEFAUT_MS };

/** Expiration d'un JWT en ms, ou null si illisible. Ne journalise pas le jeton. */
export function jwtExpMs(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function createCotlyx({
  fetchImpl = fetch,
  now = Date.now,
  sleep,
  timeoutFn = (ms) => AbortSignal.timeout(ms),
  env = process.env,
  getDeadline = () => Infinity,
  log = () => {},
} = {}) {
  let token = null;
  let tokenExp = 0;
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryLog = (quoi) => (k, why) => log(`${quoi} : nouvelle tentative ${k}/2 (${why})`);

  const reliquat = () => Math.max(0, getDeadline() - now());
  const signalBorne = (nominal) => {
    const left = reliquat();
    if (left < FETCH_MARGIN_MS) return null;
    return timeoutFn(Math.min(nominal, left));
  };
  const canRetry = (ms = 0) => reliquat() >= ms + FETCH_MARGIN_MS;
  const canAttempt = () => reliquat() >= FETCH_MARGIN_MS;

  function tokenEncoreValable() {
    return Boolean(token) && tokenExp - now() > OIDC_MARGE_MS;
  }

  async function oidcToken() {
    if (tokenEncoreValable()) return token;
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) throw new Error("jeton OIDC indisponible (permission id-token: write ?)");
    if (!canAttempt()) throw Object.assign(new Error("échéance"), { name: "TimeoutError" });
    const r = await withRetry(
      () => {
        if (!canAttempt()) throw Object.assign(new Error("échéance"), { name: "TimeoutError" });
        const signal = signalBorne(OIDC_TIMEOUT_MS);
        if (!signal) throw Object.assign(new Error("échéance"), { name: "TimeoutError" });
        return fetchImpl(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, { headers: { authorization: `Bearer ${bearer}` }, signal });
      },
      { retryStatus: true, canRetry, canAttempt, sleepImpl: wait, onRetry: retryLog("jeton OIDC") },
    );
    if (!r.ok) throw new Error(`jeton OIDC : HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j?.value !== "string") throw new Error("jeton OIDC illisible");
    token = j.value;
    tokenExp = jwtExpMs(token) ?? now() + OIDC_DUREE_DEFAUT_MS;
    return token;
  }

  async function cotlyx(path, init = {}, timeoutMs = POST_TIMEOUT_MS) {
    const tok = await oidcToken();
    if (!canAttempt()) throw Object.assign(new Error("échéance"), { name: "TimeoutError" });
    let essais = 0;
    const res = await withRetry(
      () => {
        if (!canAttempt()) throw Object.assign(new Error("échéance"), { name: "TimeoutError" });
        const signal = signalBorne(timeoutMs);
        if (!signal) throw Object.assign(new Error("échéance"), { name: "TimeoutError" });
        essais += 1;
        return fetchImpl(`${COTLYX_ORIGIN}${path}`, {
          ...init,
          headers: { ...(init.headers ?? {}), authorization: `Bearer ${tok}`, "user-agent": CLIENT_UA, accept: "application/json" },
          signal,
        });
      },
      { retryStatus: true, canRetry, canAttempt, sleepImpl: wait, onRetry: retryLog(path) },
    );
    return Object.assign(res, { essais });
  }

  return { oidcToken, cotlyx, tokenEncoreValable };
}
