// Nouvelles tentatives (09/10) : un délai dépassé ou une coupure réseau ne doit pas faire
// échouer tout le passage. 2 nouvelles tentatives, attente croissante (2 s puis 5 s).
// Jamais de nouvelle tentative sur un refus (4xx) ni sur un signe de blocage.

export const RETRY_BACKOFF_MS = [2000, 5000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Délai dépassé ou erreur réseau (fetch failed, connexion coupée). */
export function isTransientError(err) {
  const name = err?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  if (err instanceof TypeError) return true; // « fetch failed » (undici)
  const code = err?.cause?.code ?? err?.code ?? "";
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_)/.test(String(code));
}

/** Réponse à retenter : erreur serveur ou trop de requêtes. */
export const isTransientStatus = (status) => status === 429 || status >= 500;

/**
 * Appelle `fn(tentative)` jusqu'à 3 fois. `retryStatus` : retente aussi une réponse 5xx / 429.
 * `canRetry()` : faux → on s'arrête (budget de temps). Renvoie la dernière réponse, ou relance
 * la dernière erreur.
 */
export async function withRetry(fn, { retries = 2, backoffMs = RETRY_BACKOFF_MS, retryStatus = false, canRetry = () => true, sleepImpl = sleep, onRetry } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fn(i);
      if (retryStatus && res && isTransientStatus(res.status) && i < retries && canRetry()) {
        onRetry?.(i + 1, `HTTP ${res.status}`);
        await sleepImpl(backoffMs[Math.min(i, backoffMs.length - 1)]);
        continue;
      }
      return res;
    } catch (err) {
      if (!isTransientError(err) || i >= retries || !canRetry()) throw err;
      onRetry?.(i + 1, err?.name === "TimeoutError" ? "délai dépassé" : "réseau");
      await sleepImpl(backoffMs[Math.min(i, backoffMs.length - 1)]);
    }
  }
}
