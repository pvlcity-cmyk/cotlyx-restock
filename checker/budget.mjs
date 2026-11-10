// Bornes de temps du passage public.
// Échéance absolue : t0 + budget, au plus BUDGET_MAX_MS (240 s). Toute tentative
// (OIDC, POST, page, backoff) y est bornée.
// Jeton OIDC : demandé une fois avant la lecture des pages. Les JWT GitHub Actions
// durent 5 minutes par défaut, donc plus que ce budget ; on lit aussi le champ exp.
// La réserve de lecture (POST_RESERVE_MS) couvre une tentative POST de 10 s.
// Un retry court du POST n'est lancé que s'il tient dans l'échéance (premier
// essai déjà échoué vite) : on ne retranche pas un second 10 s à la lecture.

export const BUDGET_MAX_MS = 240_000;
export const BUDGET_DEFAULT_MS = 200_000;
export const FETCH_MARGIN_MS = 1_000;
export const OIDC_TIMEOUT_MS = 10_000;
export const POST_TIMEOUT_MS = 10_000;
export const GET_LOT_TIMEOUT_MS = 20_000;
/** Défaut GitHub Actions pour un jeton OIDC (5 minutes). */
export const OIDC_DUREE_DEFAUT_MS = 300_000;
/** On ne réutilise pas un jeton trop proche de son expiration. */
export const OIDC_MARGE_MS = 30_000;
/** Réserve pour une tentative POST de 10 s, retirée du budget de lecture dès le départ. */
export const POST_RESERVE_MS = POST_TIMEOUT_MS;

export function reliquatJusqua(nowMs, deadlineMs) {
  return Math.max(0, deadlineMs - nowMs);
}
