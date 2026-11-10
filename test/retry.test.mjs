import assert from "node:assert/strict";
import test from "node:test";
import { isTransientError, withRetry } from "../checker/retry.mjs";

const noSleep = async () => {};
const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

test("délai dépassé puis succès : 2 nouvelles tentatives, attente 2 s puis 5 s", async () => {
  const waits = [];
  let n = 0;
  const r = await withRetry(async () => { n++; if (n < 3) throw timeout(); return "ok"; }, { sleepImpl: async (ms) => waits.push(ms) });
  assert.equal(r, "ok");
  assert.equal(n, 3);
  assert.deepEqual(waits, [2000, 5000]);
});

test("toujours en échec après 3 essais : l'erreur remonte", async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new TypeError("fetch failed"); }, { sleepImpl: noSleep }), /fetch failed/);
  assert.equal(n, 3);
});

test("erreur non réseau : pas de nouvelle tentative", async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new Error("jeton OIDC illisible"); }, { sleepImpl: noSleep }));
  assert.equal(n, 1);
});

test("5xx / 429 retentés seulement avec retryStatus ; 4xx jamais", async () => {
  let n = 0;
  const seq = [503, 429, 200];
  const r = await withRetry(async () => ({ status: seq[n++] }), { retryStatus: true, sleepImpl: noSleep });
  assert.equal(r.status, 200);
  assert.equal(n, 3);
  let m = 0;
  const r2 = await withRetry(async () => { m++; return { status: 404 }; }, { retryStatus: true, sleepImpl: noSleep });
  assert.equal(r2.status, 404);
  assert.equal(m, 1);
  let k = 0;
  const r3 = await withRetry(async () => { k++; return { status: 503 }; }, { sleepImpl: noSleep });
  assert.equal(r3.status, 503);
  assert.equal(k, 1);
});

test("budget épuisé : on s'arrête sans attendre", async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw timeout(); }, { canRetry: () => false, sleepImpl: noSleep }));
  assert.equal(n, 1);
});

test("isTransientError", () => {
  assert.equal(isTransientError(timeout()), true);
  assert.equal(isTransientError(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } })), true);
  assert.equal(isTransientError(new Error("HTTP 401")), false);
});

test("pas de backoff s'il dépasse le reliquat ; éligibilité revue après l'attente", async () => {
  let n = 0;
  const waits = [];
  let left = 2_500;
  const r = await withRetry(async () => { n += 1; return { status: 503 }; }, {
    retryStatus: true,
    canRetry: (wait) => left >= wait + 1_000,
    canAttempt: () => left >= 1_000,
    sleepImpl: async (ms) => { waits.push(ms); left -= ms; },
  });
  assert.equal(r.status, 503);
  assert.equal(n, 1);
  assert.deepEqual(waits, []);

  n = 0;
  waits.length = 0;
  left = 8_000;
  const r2 = await withRetry(async () => { n += 1; return { status: 503 }; }, {
    retryStatus: true,
    canRetry: (wait) => left >= wait + 1_000,
    canAttempt: () => false,
    sleepImpl: async (ms) => { waits.push(ms); left -= ms; },
  });
  assert.equal(r2.status, 503);
  assert.equal(n, 1, "pas de nouvelle tentative une fois canAttempt faux après le backoff");
  assert.deepEqual(waits, [2000]);
});
