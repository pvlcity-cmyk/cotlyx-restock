import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProductMicrodata, parseProductJsonLd, price } from "../checker/schema.mjs";
import { isUltrajeuxProductUrl, readUltrajeux } from "../checker/ultrajeux.mjs";
import { isJsonLdShopProductUrl, parseJsonLdShopPage } from "../checker/jsonld-shop.mjs";
import { buildReleve, buildRelevesBody } from "../checker/releve.mjs";
import {
  preparerItems,
  shopOf,
  isProductUrl,
  shopChallenge,
  lireLot,
  SHOP_DELAY_MS,
  PUBLIC_LOT_SHOPS,
  idChaine,
  POST_RESERVE_MS,
  MAX_REDIRECTS,
  urlHoteAutorise,
} from "../checker/dispatch.mjs";
import { readProduct, detectChallenge } from "../checker/playin.mjs";
import { lotPath, LOT_SHOPS_QUERY, runPassage, délaisDuLot, budgetDuLot } from "../checker/passage.mjs";
import { createCotlyx, jwtExpMs } from "../checker/cotlyx.mjs";
import { BUDGET_MAX_MS, OIDC_DUREE_DEFAUT_MS, POST_TIMEOUT_MS, GET_LOT_TIMEOUT_MS } from "../checker/budget.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(dir, "fixtures", name), "utf8");

const UJ_IN = fx("ultrajeux-instock.html");
const UJ_OUT = fx("ultrajeux-outofstock.html");
const UJ_NOPRICE = fx("ultrajeux-sans-prix.html");
const BCD_IN = fx("bcd-instock.html");
const TZP_OUT = fx("tzp-outofstock.html");
const SM_NOPRICE = fx("smartoys-sans-prix.html");
const PKM_IN = fx("pokemael-instock.html");
const GEN_IN = fx("gentlemen-instock.html");
const DEFI = fx("cloudflare-challenge.html");
const ROBOTS_OK = fx("robots-allow.txt");
const ROBOTS_DENY = fx("robots-deny.txt");

const URLS = {
  playin: "https://www.play-in.com/fr/produit/123456/exemple",
  ultrajeux: "https://www.ultrajeux.com/produit-33282-bundle-6-boosters.html",
  smartoys: "https://www.smartoys.be/catalog/trading-cards-lot-p-0196214145221.html",
  bcd: "https://www.bcd-jeux.fr/pokemon-tcg/39598-mini-tin-exemple.html",
  tzp: "https://www.tzp.fr/precommande/3527-coffret-exemple.html",
  pokemael: "https://pokemael.com/products/booster-exemple",
  gentlemen: "https://lesgentlemendujeu.com/pokemon/13030-etb-exemple.html",
};

const playinPage = ({ availability = "https://schema.org/InStock", prix = "49.99", store = "STOCK_IN_WAREHOUSE" } = {}) => {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Exemple",
    sku: "123456",
    image: "https://example.test/a.jpg",
    gtin13: "0820650850011",
    offers: { "@type": "Offer", availability, price: prix, priceCurrency: "EUR" },
  };
  const next = store
    ? `<script>self.__next_f.push([1,"{\\"_id\\":123456,\\"productStores\\":{\\"items\\":[{\\"__typename\\":\\"ProductStore\\",\\"storeStockState\\":\\"${store}\\",\\"store\\":{\\"_id\\":0,\\"warehouse\\":true}}]}"])</script>`
    : "";
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>${next}</body></html>`;
};

function fakeFetch(pages, { robots = ROBOTS_OK, statusOf = {}, headersOf = {} } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    const ua = new Headers(init?.headers).get("user-agent") ?? new Headers(init?.headers).get("User-Agent");
    calls.push({ url, ua, headers: init?.headers ?? {}, redirect: init?.redirect });
    if (url.endsWith("/robots.txt")) {
      const body = typeof robots === "function" ? robots(url) : robots;
      const status = statusOf[url] ?? 200;
      return new Response(body, { status, headers: headersOf[url] });
    }
    const p = pages[url];
    if (!p) return new Response("absent", { status: 404 });
    if (p.redirectTo) {
      return new Response("", { status: p.status ?? 302, headers: { location: p.redirectTo, ...(p.headers ?? headersOf[url] ?? {}) } });
    }
    const status = p.status ?? statusOf[url] ?? 200;
    return new Response(p.body ?? "", { status, headers: p.headers ?? headersOf[url] });
  };
  return { fetchImpl, calls };
}

const clock = () => {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
};

/* ---------- parseurs ---------- */

test("en stock : Ultrajeux microdonnées, BCD JSON-LD sans guillemets, PokéMaël", () => {
  const uj = readUltrajeux(UJ_IN);
  assert.equal(uj.etat, "in_stock");
  assert.equal(uj.prix, 94.9);
  assert.equal(uj.gtin, "0196214145221");
  assert.equal(uj.vendeur, true);

  const bcd = parseJsonLdShopPage("bcd", BCD_IN);
  assert.equal(bcd.etat, "in_stock");
  assert.equal(bcd.prix, 49.9);
  assert.equal(bcd.vendeur, true);
  assert.equal(bcd.image, "https://www.bcd-jeux.fr/img/exemple.jpg");

  const pkm = parseJsonLdShopPage("pokemael", PKM_IN);
  assert.equal(pkm.etat, "in_stock");
  assert.equal(pkm.prix, 9.99);
  assert.equal(pkm.gtin, null, "la sku Shopify n'est jamais prise pour un EAN");
});

test("rupture : Ultrajeux et TZP", () => {
  assert.equal(readUltrajeux(UJ_OUT).etat, "out_of_stock");
  assert.equal(readUltrajeux(UJ_OUT).prix, 94.9);
  const tzp = parseJsonLdShopPage("tzp", TZP_OUT);
  assert.equal(tzp.etat, "out_of_stock");
  assert.equal(tzp.prix, 54.99);
});

test("prix absent : null, jamais inventé", () => {
  assert.equal(readUltrajeux(UJ_NOPRICE).etat, "in_stock");
  assert.equal(readUltrajeux(UJ_NOPRICE).prix, null);
  assert.equal(parseJsonLdShopPage("smartoys", SM_NOPRICE).prix, null);
  assert.equal(price(0), null);
  assert.equal(price(""), null);
  assert.equal(parseProductMicrodata("<html>rien</html>"), null);
  assert.equal(parseProductJsonLd("<html></html>"), null);
});

test("URL : motifs d'enseigne, paramètres et autre hôte refusés", () => {
  assert.equal(isUltrajeuxProductUrl(URLS.ultrajeux), true);
  assert.equal(isUltrajeuxProductUrl("https://www.ultrajeux.com/search3.php?r=pokemon"), false);
  assert.equal(isUltrajeuxProductUrl(`${URLS.ultrajeux}?x=1`), false);
  for (const shop of ["smartoys", "bcd", "tzp", "pokemael", "gentlemen"]) {
    assert.equal(isJsonLdShopProductUrl(shop, URLS[shop]), true, shop);
    assert.equal(isJsonLdShopProductUrl(shop, `${URLS[shop]}?x=1`), false, `${shop} ?`);
    assert.equal(isProductUrl(shop, URLS[shop].replace("https:", "http:")), false, `${shop} http`);
  }
  assert.equal(isProductUrl("lagranderecre", "https://www.lagranderecre.fr/x.html"), false);
});

test("vendeur tiers nommé : offre écartée", () => {
  const tiers = BCD_IN.replace(/BCD Jeux/g, "Boutique Tierce");
  assert.equal(parseJsonLdShopPage("bcd", tiers).vendeur, false);
});

/* ---------- dispatch et politesse ---------- */

test("dispatch : shop absent ou playin → playin", () => {
  assert.equal(shopOf({ id: "123456", url: URLS.playin }), "playin");
  assert.equal(shopOf({ id: "123456", url: URLS.playin, shop: "playin" }), "playin");
  assert.equal(shopOf({ id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" }), "ultrajeux");
});

test("preparerItems : shop absent = Play-In ; enseigne inconnue ou LGR écartée", () => {
  const items = preparerItems([
    { id: "123456", url: URLS.playin },
    { id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" },
    { id: "1", url: "https://www.lagranderecre.fr/jeux/x.html", shop: "lagranderecre" },
    { id: "2", url: URLS.bcd, shop: "inconnue" },
    { id: "abc", url: URLS.playin },
  ]);
  assert.deepEqual(
    items.map((x) => [x.shop, x.id]),
    [
      ["playin", "123456"],
      ["ultrajeux", "33282"],
    ],
  );
});

test("dispatch vers playin : lecture via playin.mjs (entrepôt)", async () => {
  const html = playinPage({ store: "STOCK_IN_WAREHOUSE" });
  assert.equal(readProduct(html).etat, "in_stock");
  const { fetchImpl } = fakeFetch({ [URLS.playin]: { body: html } });
  const clk = clock();
  const { releves, arret } = await lireLot([{ id: "123456", url: URLS.playin, shop: "playin" }], {
    fetchImpl,
    sleep: clk.sleep,
    now: clk.now,
    t0: clk.now(),
    delayPlayinMs: 3000,
    budgetMs: 60_000,
  });
  assert.equal(arret, null);
  assert.equal(releves.length, 1);
  assert.equal(releves[0].id, "123456");
  assert.equal(releves[0].shop, undefined, "lot Play-In : pas de champ shop ajouté");
  assert.equal(releves[0].etat, "in_stock");
  assert.equal(releves[0].prix, 49.99);
  assert.equal(releves[0].entrepot, "STOCK_IN_WAREHOUSE");
  assert.equal(clk.sleeps[0], 3000);
});

test("défi : arrêt de cette enseigne seulement, signalé dans le relevé", async () => {
  const uj2 = "https://www.ultrajeux.com/produit-33278-autre.html";
  const playinHtml = playinPage();
  const { fetchImpl, calls } = fakeFetch({
    [URLS.ultrajeux]: { body: DEFI },
    [uj2]: { body: UJ_IN },
    [URLS.playin]: { body: playinHtml },
    [URLS.bcd]: { body: BCD_IN },
  });
  const clk = clock();
  const { releves, arret, arrets, n } = await lireLot(
    [
      { id: "123456", url: URLS.playin, shop: "playin" },
      { id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" },
      { id: "33278", url: uj2, shop: "ultrajeux" },
      { id: "39598", url: URLS.bcd, shop: "bcd" },
    ],
    { fetchImpl, sleep: clk.sleep, now: clk.now, t0: clk.now(), delayPlayinMs: 3000, budgetMs: 120_000 },
  );
  assert.equal(arret, null, "un défi Ultrajeux ne gèle pas Play-In");
  assert.equal(arrets.ultrajeux, "defi");
  assert.ok(!arrets.playin);
  assert.ok(!arrets.bcd);
  const byId = Object.fromEntries(releves.map((r) => [r.id, r]));
  assert.equal(byId["123456"].etat, "in_stock");
  assert.equal(byId["33282"].erreur, "defi");
  assert.equal(byId["33282"].shop, "ultrajeux");
  assert.ok(!byId["33278"], "seconde fiche Ultrajeux non lue");
  assert.equal(byId["39598"].etat, "in_stock");
  assert.ok(!calls.some((c) => c.url === uj2), "arrêt immédiat de l'enseigne");
  assert.ok(calls.every((c) => c.ua === "CotlyxBot/1.0 (+https://cotlyx.fr)"));
  assert.equal(n.defi, 1);
});

test("503 Gentlemen : arrêt au premier, les autres enseignes continuent", async () => {
  const gen2 = "https://lesgentlemendujeu.com/pokemon/13031-autre.html";
  const { fetchImpl, calls } = fakeFetch({
    [URLS.gentlemen]: { body: "unavailable", status: 503 },
    [gen2]: { body: GEN_IN },
    [URLS.bcd]: { body: BCD_IN },
  });
  const clk = clock();
  const { releves, arrets, arret } = await lireLot(
    [
      { id: "13030", url: URLS.gentlemen, shop: "gentlemen" },
      { id: "13031", url: gen2, shop: "gentlemen" },
      { id: "39598", url: URLS.bcd, shop: "bcd" },
    ],
    { fetchImpl, sleep: clk.sleep, now: clk.now, t0: clk.now(), delayPlayinMs: 3000, budgetMs: 120_000 },
  );
  assert.equal(arret, null);
  assert.equal(arrets.gentlemen, "503");
  const byId = Object.fromEntries(releves.map((r) => [r.id, r]));
  assert.equal(byId["13030"].erreur, "defi");
  assert.ok(!byId["13031"]);
  assert.ok(!calls.some((c) => c.url === gen2));
  assert.equal(byId["39598"].etat, "in_stock");
  // Un 503 hors Gentlemen / Play-In n'arrête pas l'enseigne.
  assert.equal(shopChallenge("bcd", 503, new Headers(), "erreur serveur"), null);
  assert.equal(shopChallenge("gentlemen", 503, new Headers(), "erreur serveur"), "http");
  assert.equal(detectChallenge(503, null, ""), "http");
});

test("robots.txt qui interdit : fiche signalée, pas de requête produit", async () => {
  const { fetchImpl, calls } = fakeFetch({ [URLS.ultrajeux]: { body: UJ_IN } }, { robots: ROBOTS_DENY });
  const clk = clock();
  const { releves, n } = await lireLot([{ id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" }], {
    fetchImpl,
    sleep: clk.sleep,
    now: clk.now,
    t0: clk.now(),
    delayPlayinMs: 3000,
    budgetMs: 60_000,
  });
  assert.equal(releves[0].erreur, "robots");
  assert.equal(n.robots, 1);
  assert.ok(!calls.some((c) => c.url === URLS.ultrajeux));
  assert.ok(calls.some((c) => c.url === "https://www.ultrajeux.com/robots.txt"));
  assert.equal(clk.sleeps.length, 0);
});

test("délai respecté : horloge simulée, 3 s Play-In, 4 s autre enseigne", async () => {
  const uj2 = "https://www.ultrajeux.com/produit-33278-autre.html";
  const pi2 = "https://www.play-in.com/fr/produit/123457/autre";
  const { fetchImpl } = fakeFetch({
    [URLS.playin]: { body: playinPage() },
    [pi2]: { body: playinPage({ store: "STOCK_IN_WAREHOUSE" }) },
    [URLS.ultrajeux]: { body: UJ_IN },
    [uj2]: { body: UJ_OUT },
  });
  const clk = clock();
  await lireLot(
    [
      { id: "123456", url: URLS.playin, shop: "playin" },
      { id: "123457", url: pi2, shop: "playin" },
      { id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" },
      { id: "33278", url: uj2, shop: "ultrajeux" },
    ],
    { fetchImpl, sleep: clk.sleep, now: clk.now, t0: clk.now(), delayPlayinMs: 3000, budgetMs: 120_000 },
  );
  // Play-In d'abord (2 × 3000), puis Ultrajeux (2 × 4000).
  assert.deepEqual(clk.sleeps, [3000, 3000, SHOP_DELAY_MS, SHOP_DELAY_MS]);
  assert.equal(SHOP_DELAY_MS, 4000);
});

test("corps du relevé : sans shop = Play-In ; arrets seulement defi ou 503", () => {
  const playin = buildReleve({ id: "123456", shop: "playin" }, { etat: "in_stock", prix: 49.99, vendeur: true, entrepot: "STOCK_IN_WAREHOUSE", image: null, gtin: "0820650850011" });
  assert.deepEqual(playin, { id: "123456", etat: "in_stock", prix: 49.99, vendeur: true, entrepot: "STOCK_IN_WAREHOUSE", image: null, gtin: "0820650850011" });
  const uj = buildReleve({ id: "33282", shop: "ultrajeux" }, { etat: "in_stock", prix: 94.9, vendeur: true, entrepot: null, image: null, gtin: "0196214145221" });
  assert.equal(uj.shop, "ultrajeux");
  const onlyPlayin = buildRelevesBody({ lot: "lot-abc-12345678", run: { id: "1", attempt: "1" }, arret: "defi", arrets: { playin: "defi" }, duree_ms: 12, releves: [playin] });
  assert.equal(onlyPlayin.arret, "defi");
  assert.deepEqual(onlyPlayin.arrets, { playin: "defi" });
  const mixed = buildRelevesBody({ lot: "lot-abc-12345678", run: { id: "1", attempt: "1" }, arret: null, arrets: { ultrajeux: "defi" }, duree_ms: 12, releves: [uj] });
  assert.deepEqual(mixed.arrets, { ultrajeux: "defi" });
  assert.equal(mixed.arret, null);
});

test("robots.txt illisible : enseigne sautée (arret robots), les autres continuent", async () => {
  const { fetchImpl } = fakeFetch(
    { [URLS.ultrajeux]: { body: UJ_IN }, [URLS.bcd]: { body: BCD_IN } },
    { robots: (url) => (url.includes("ultrajeux") ? "nope" : ROBOTS_OK), statusOf: { "https://www.ultrajeux.com/robots.txt": 500 } },
  );
  const clk = clock();
  const { releves, arrets } = await lireLot(
    [
      { id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" },
      { id: "39598", url: URLS.bcd, shop: "bcd" },
    ],
    { fetchImpl, sleep: clk.sleep, now: clk.now, t0: clk.now(), delayPlayinMs: 3000, budgetMs: 60_000 },
  );
  assert.equal(arrets.ultrajeux, undefined, "robots n'entre pas dans arrets");
  assert.ok(!releves.some((r) => r.id === "33282"));
  assert.equal(releves.find((r) => r.id === "39598").etat, "in_stock");
});


/* ---------- contrat #328 ---------- */

test("shops dans l'URL du GET /api/restock/lot", async () => {
  assert.deepEqual(PUBLIC_LOT_SHOPS, ["playin", "ultrajeux", "smartoys", "bcd", "pokemael", "tzp", "gentlemen"]);
  assert.equal(LOT_SHOPS_QUERY, "playin,ultrajeux,smartoys,bcd,pokemael,tzp,gentlemen");
  assert.equal(lotPath(), "/api/restock/lot?shops=playin,ultrajeux,smartoys,bcd,pokemael,tzp,gentlemen");
  const paths = [];
  const code = await runPassage({
    getLot: async (path) => {
      paths.push(path);
      return new Response(null, { status: 204 });
    },
    postReleves: async () => {
      throw new Error("POST ne doit pas être appelé");
    },
    sleep: async () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(paths, [lotPath()]);
});

test("204 : aucun POST, sortie propre", async () => {
  const posts = [];
  const logs = [];
  const code = await runPassage({
    getLot: async () => new Response(null, { status: 204 }),
    postReleves: async (body) => {
      posts.push(body);
      return new Response("{}", { status: 200 });
    },
    sleep: async () => {},
    log: (m) => logs.push(m),
  });
  assert.equal(code, 0);
  assert.equal(posts.length, 0);
  assert.ok(logs.some((m) => /rien à lire/.test(m)));
});

test("id en chaîne avec zéros en tête", async () => {
  assert.equal(idChaine("0196214145221"), "0196214145221");
  assert.equal(typeof idChaine("0196214145221"), "string");
  const items = preparerItems([{ id: "0196214145221", url: URLS.smartoys, shop: "smartoys" }]);
  assert.equal(items[0].id, "0196214145221");
  const { fetchImpl } = fakeFetch({ [URLS.smartoys]: { body: SM_NOPRICE } });
  const clk = clock();
  const { releves } = await lireLot(items, {
    fetchImpl,
    sleep: clk.sleep,
    now: clk.now,
    t0: clk.now(),
    delayPlayinMs: 3000,
    budgetMs: 60_000,
  });
  assert.equal(releves.length, 1);
  assert.equal(releves[0].id, "0196214145221");
  assert.equal(typeof releves[0].id, "string");
  assert.equal(releves[0].shop, "smartoys");
  const body = buildRelevesBody({ lot: "lot-zeros-12345678", run: { id: "1", attempt: "1" }, arret: null, arrets: {}, duree_ms: 1, releves });
  assert.equal(body.releves[0].id, "0196214145221");
  assert.ok(JSON.stringify(body).includes('"id":"0196214145221"'));
});

test("arrets sans robots", async () => {
  const body = buildRelevesBody({
    lot: "lot-abc-12345678",
    run: { id: "1", attempt: "1" },
    arret: "robots",
    arrets: { playin: "robots", ultrajeux: "robots", gentlemen: "503", bcd: "defi", inconnue: "defi" },
    duree_ms: 12,
    releves: [],
  });
  assert.equal(body.arret, "robots");
  assert.deepEqual(body.arrets, { gentlemen: "503", bcd: "defi" });
  assert.ok(!Object.values(body.arrets).includes("robots"));
  assert.ok(!Object.keys(body.arrets).includes("inconnue"));

  const { fetchImpl } = fakeFetch({ [URLS.playin]: { body: playinPage() } }, { statusOf: { "https://www.play-in.com/robots.txt": 500 } });
  const clk = clock();
  const r = await lireLot([{ id: "123456", url: URLS.playin, shop: "playin" }], {
    fetchImpl,
    sleep: clk.sleep,
    now: clk.now,
    t0: clk.now(),
    delayPlayinMs: 3000,
    budgetMs: 60_000,
  });
  assert.equal(r.arret, "robots");
  assert.equal(r.arrets.playin, undefined);
  const posted = buildRelevesBody({ lot: "lot-abc-12345678", run: { id: "1", attempt: "1" }, arret: r.arret, arrets: r.arrets, duree_ms: 1, releves: r.releves });
  assert.equal(posted.arret, "robots");
  assert.equal(posted.arrets, undefined);
});

test("delayMs et budgetMs respectés, sans descendre sous 3 à 4 s", () => {
  assert.deepEqual(délaisDuLot({ delayMs: 1000 }), { delayPlayinMs: 3000, delayShopMs: 4000 });
  assert.deepEqual(délaisDuLot({ delayMs: 3000 }), { delayPlayinMs: 3000, delayShopMs: 4000 });
  assert.deepEqual(délaisDuLot({ delayMs: 5000 }), { delayPlayinMs: 5000, delayShopMs: 5000 });
  assert.deepEqual(délaisDuLot({}), { delayPlayinMs: 3000, delayShopMs: 4000 });
  assert.equal(budgetDuLot({ budgetMs: 200_000 }), 200_000);
  assert.equal(budgetDuLot({ budgetMs: 10_000 }), 10_000);
  assert.equal(budgetDuLot({}), 200_000);
  assert.equal(budgetDuLot({ budgetMs: 999_999 }), 240_000);
});


/* ---------- budget 240 s et redirections manuelles ---------- */

test("budget 240 s tenu (cas Data) : aucun réseau après expiration, POST inclus", async () => {
  // Repro Data : budget=240000, horloge=240001, robots UJ à 240001 puis BCD à 255001, fin à 270001
  // (timeouts 15 s non bornés, robots des enseignes suivantes après expiration).
  // Avec réserve POST 10 s, la lecture s'arrête à 230000 ; on part de là.
  const BUDGET = 240_000;
  let t = BUDGET - POST_RESERVE_MS;
  const calls = [];
  const now = () => t;
  const sleep = async (ms) => {
    t += ms;
  };
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push({ url, at: t });
    // Sans borne, un robots.txt qui expire au timeout ferait +15 s (repro Data).
    t += 15_000;
    return new Response("User-agent: *\nAllow: /\n");
  };
  const posts = [];
  const code = await runPassage({
    t0: 0,
    now,
    sleep,
    getLot: async () =>
      Response.json({
        ok: true,
        lot: "lot-budget-12345678",
        delayMs: 3000,
        budgetMs: BUDGET,
        items: [
          { id: "123456", url: URLS.playin, shop: "playin" },
          { id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" },
          { id: "39598", url: URLS.bcd, shop: "bcd" },
        ],
      }),
    postReleves: async (body) => {
      posts.push(body);
      t += 9_000;
      return Object.assign(new Response("{}", { status: 200 }), { essais: 1 });
    },
    fetchImpl,
  });
  assert.equal(code, 0);
  assert.ok(t <= BUDGET, `fin à ${t} ms, budget ${BUDGET}`);
  assert.equal(POST_RESERVE_MS, 10_000);
  assert.equal(posts.length, 1);
  assert.equal(calls.length, 0, "aucun appel réseau une fois le reliquat de lecture épuisé");
  assert.ok(!calls.some((c) => c.url.includes("ultrajeux") || c.url.includes("bcd-jeux")));
  const ids = (posts[0].releves ?? []).map((r) => r.id);
  assert.ok(!ids.includes("33282"));
  assert.ok(!ids.includes("39598"));
  assert.ok(!ids.includes("123456"));
});

test("redirection : seulement vers un hôte autorisé de l'enseigne, au plus 3 sauts", async () => {
  assert.equal(urlHoteAutorise("ultrajeux", "https://www.ultrajeux.com/categorie/x"), true);
  assert.equal(urlHoteAutorise("ultrajeux", "https://evil.test/x"), false);
  assert.equal(urlHoteAutorise("ultrajeux", "http://www.ultrajeux.com/x"), false);

  const clk = clock();
  const { fetchImpl, calls } = fakeFetch({
    [URLS.ultrajeux]: { redirectTo: "https://evil.test/phish" },
    "https://evil.test/phish": { body: UJ_IN },
    [URLS.bcd]: { redirectTo: "https://www.bcd-jeux.fr/categorie/pokemon/" },
    "https://www.bcd-jeux.fr/categorie/pokemon/": { body: "<html>catégorie</html>" },
  });
  const r = await lireLot(
    [
      { id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" },
      { id: "39598", url: URLS.bcd, shop: "bcd" },
    ],
    { fetchImpl, sleep: clk.sleep, now: clk.now, t0: clk.now(), delayPlayinMs: 3000, budgetMs: 120_000 },
  );
  const byId = Object.fromEntries(r.releves.map((x) => [x.id, x]));
  assert.equal(byId["33282"].erreur, "http_autre");
  assert.ok(!calls.some((c) => c.url.includes("evil.test")), "aucune requête vers un hôte hors liste");
  assert.equal(byId["39598"].disparue, true);
  assert.ok(calls.every((c) => c.redirect === "manual"));

  const a = "https://www.ultrajeux.com/produit-1-a.html";
  const hops = {
    [a]: { redirectTo: "https://www.ultrajeux.com/s2" },
    "https://www.ultrajeux.com/s2": { redirectTo: "https://www.ultrajeux.com/s3" },
    "https://www.ultrajeux.com/s3": { redirectTo: "https://www.ultrajeux.com/s4" },
    "https://www.ultrajeux.com/s4": { redirectTo: "https://www.ultrajeux.com/s5" },
    "https://www.ultrajeux.com/s5": { body: UJ_IN },
  };
  const hopFetch = fakeFetch(hops);
  const clk2 = clock();
  const r2 = await lireLot([{ id: "1", url: a, shop: "ultrajeux" }], {
    fetchImpl: hopFetch.fetchImpl,
    sleep: clk2.sleep,
    now: clk2.now,
    t0: clk2.now(),
    delayPlayinMs: 3000,
    budgetMs: 120_000,
  });
  assert.equal(r2.releves[0].erreur, "http_autre");
  const pages = hopFetch.calls.filter((c) => !c.url.endsWith("/robots.txt"));
  assert.ok(pages.length <= MAX_REDIRECTS + 1, "au plus 3 sauts (4 requêtes)");
  assert.ok(!pages.some((c) => c.url.endsWith("/s5")), "le 4e saut n'est pas suivi");
});

/* ---------- échéance absolue : repros Data (tête 9a0ba4bf) ---------- */

function fakeJwt(expMs) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function horloge(t0 = 0) {
  let t = t0;
  const sleeps = [];
  return {
    get t() {
      return t;
    },
    set t(v) {
      t = v;
    },
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms) => {
      t += ms;
    },
  };
}

test("jwt OIDC : exp lu, durée typique 5 min (supérieure au budget de 240 s)", () => {
  assert.equal(jwtExpMs("pas-un-jwt"), null);
  assert.equal(jwtExpMs(fakeJwt(300_000)), 300_000);
  assert.equal(OIDC_DUREE_DEFAUT_MS, 300_000);
  assert.ok(OIDC_DUREE_DEFAUT_MS > BUDGET_MAX_MS);
});

test("restitution à 230000 ms avec OIDC 9 s et POST 9 s : fin ≤ 240000 (cas Data)", async () => {
  // Repro Data : à 230000, oidcToken (jusqu'à 3 × 10 s) puis POST 9 s → fin 248000,
  // sans échéance passée à postReleves. Ici le jeton est obtenu avant la lecture
  // (valable 5 min) ; à 230000 il ne reste que le POST de 9 s → 239000.
  const BUDGET = BUDGET_MAX_MS;
  const clk = horloge(0);
  const calls = [];
  const timeouts = [];
  const jwt = fakeJwt(clk.now() + OIDC_DUREE_DEFAUT_MS);
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test/token?r=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token",
  };
  let lastTimeout = Infinity;
  const timeoutFn = (ms) => {
    lastTimeout = ms;
    timeouts.push({ ms, at: clk.now() });
    return new AbortController().signal;
  };
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push({ url, at: clk.now() });
    const spend = Math.min(9_000, lastTimeout);
    if (url.startsWith("https://oidc.test/")) {
      clk.advance(spend);
      if (spend < 9_000) throw Object.assign(new Error("échéance"), { name: "TimeoutError" });
      return Response.json({ value: jwt });
    }
    if (url.includes("/api/restock/lot")) {
      return Response.json({
        ok: true,
        lot: "lot-restit-12345678",
        delayMs: 3000,
        budgetMs: BUDGET,
        items: [{ id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" }],
      });
    }
    if (url.includes("/api/restock/releves")) {
      clk.advance(spend);
      if (spend < 9_000) throw Object.assign(new Error("échéance"), { name: "TimeoutError" });
      return new Response("{}", { status: 200 });
    }
    throw new Error(`réseau enseigne interdit dans ce test : ${url}`);
  };
  const client = createCotlyx({
    fetchImpl,
    now: clk.now,
    sleep: clk.sleep,
    timeoutFn,
    env,
    getDeadline: () => BUDGET,
  });
  await client.oidcToken();
  assert.equal(clk.t, 9_000);
  clk.t = 230_000;
  const code = await runPassage({
    t0: 0,
    now: clk.now,
    sleep: clk.sleep,
    deadline: BUDGET,
    prefetchOidc: () => client.oidcToken(),
    getLot: (path) => client.cotlyx(path, {}, GET_LOT_TIMEOUT_MS),
    postReleves: (body) =>
      client.cotlyx("/api/restock/releves", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, POST_TIMEOUT_MS),
    fetchImpl,
  });
  assert.equal(code, 0);
  assert.ok(clk.t <= BUDGET, `fin à ${clk.t} ms`);
  assert.equal(clk.t, 239_000);
  const oidc = calls.filter((c) => c.url.startsWith("https://oidc.test/"));
  const posts = calls.filter((c) => c.url.includes("/releves"));
  assert.equal(oidc.length, 1);
  assert.equal(oidc[0].at, 0);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].at, 230_000);
  assert.ok(!calls.some((c) => c.at >= BUDGET), "aucun appel à l'échéance ou après");
  const postTimeout = timeouts.filter((x) => x.at === 230_000);
  assert.ok(postTimeout.some((x) => x.ms <= 10_000));
});

test("restitution : 503 suivi de retries bornés à l'échéance (cas Data)", async () => {
  // Repro Data : 503 + backoffs 2 s et 5 s + retries POST 10 s → fin 273000.
  // Jeton déjà obtenu ; POST 503 en 9 s à 230000 ; un backoff de 2 s dépasserait 240000.
  const BUDGET = BUDGET_MAX_MS;
  const clk = horloge(0);
  const calls = [];
  const jwt = fakeJwt(OIDC_DUREE_DEFAUT_MS);
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test/token?r=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token",
  };
  let lastTimeout = Infinity;
  const timeoutFn = (ms) => {
    lastTimeout = ms;
    return new AbortController().signal;
  };
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push({ url, at: clk.now() });
    if (url.startsWith("https://oidc.test/")) {
      clk.advance(Math.min(9_000, lastTimeout));
      return Response.json({ value: jwt });
    }
    if (url.includes("/api/restock/lot")) {
      return Response.json({
        ok: true,
        lot: "lot-503-12345678",
        delayMs: 3000,
        budgetMs: BUDGET,
        items: [{ id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" }],
      });
    }
    if (url.includes("/api/restock/releves")) {
      clk.advance(Math.min(9_000, lastTimeout));
      return new Response("{}", { status: 503 });
    }
    throw new Error(`réseau enseigne interdit dans ce test : ${url}`);
  };
  const client = createCotlyx({
    fetchImpl,
    now: clk.now,
    sleep: clk.sleep,
    timeoutFn,
    env,
    getDeadline: () => BUDGET,
  });
  await client.oidcToken();
  clk.t = 230_000;
  const code = await runPassage({
    t0: 0,
    now: clk.now,
    sleep: clk.sleep,
    deadline: BUDGET,
    prefetchOidc: () => client.oidcToken(),
    getLot: (path) => client.cotlyx(path, {}, GET_LOT_TIMEOUT_MS),
    postReleves: (body) =>
      client.cotlyx("/api/restock/releves", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, POST_TIMEOUT_MS),
    fetchImpl,
  });
  assert.ok(clk.t <= BUDGET, `fin à ${clk.t} ms`);
  assert.equal(clk.t, 239_000);
  const posts = calls.filter((c) => c.url.includes("/releves"));
  assert.equal(posts.length, 1, "pas de retry POST une fois le backoff trop long");
  assert.ok(!calls.some((c) => c.at >= BUDGET));
  assert.equal(code, 1);
});

test("page : pas d'appel à 229500 ms ni après l'échéance (cas Data)", async () => {
  // Repro Data : départ 223500, robots immédiat, sommeil 4000, page à 227500
  // (TimeoutError immédiat), backoff 2000, nouvelle page à 229500 avec timeout 500 ms.
  const BUDGET = BUDGET_MAX_MS;
  const clk = horloge(223_500);
  const calls = [];
  const timeouts = [];
  const timeoutFn = (ms) => {
    timeouts.push({ ms, at: clk.now() });
    return new AbortController().signal;
  };
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push({ url, at: clk.now() });
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
    throw Object.assign(new Error("délai dépassé"), { name: "TimeoutError" });
  };
  const r = await lireLot([{ id: "33282", url: URLS.ultrajeux, shop: "ultrajeux" }], {
    fetchImpl,
    sleep: clk.sleep,
    now: clk.now,
    t0: 0,
    deadline: BUDGET,
    budgetMs: BUDGET,
    delayPlayinMs: 3000,
    timeoutFn,
  });
  assert.ok(clk.t <= BUDGET, `fin à ${clk.t} ms`);
  assert.ok(!calls.some((c) => c.at >= BUDGET), "aucun appel à l'échéance ou après");
  assert.ok(!calls.some((c) => c.at === 229_500), "pas de page à 229500 ms");
  const pages = calls.filter((c) => !c.url.endsWith("/robots.txt"));
  assert.equal(pages.length, 0, "pas de fiche une fois le reliquat < politesse + 1 s");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at, 223_500);
  assert.ok(calls[0].url.endsWith("/robots.txt"));
  assert.equal(r.releves.length, 0, "item non traité, non consommé dans les relevés");
});

test("cadence par enseigne : retries compris, 4 s hors Play-In et 3 s Play-In (cas Data 2 s)", async () => {
  // Repro Data : 2 s seulement entre deux requêtes de la même enseigne (backoff retry).
  const BUDGET = BUDGET_MAX_MS;
  const cadence = async (shop, url, delay, body) => {
    const clk = horloge(0);
    const calls = [];
    let pages = 0;
    const timeoutFn = (ms) => new AbortController().signal;
    const fetchImpl = async (input) => {
      const u = String(input);
      calls.push({ url: u, at: clk.now() });
      if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
      pages += 1;
      if (pages === 1) throw Object.assign(new Error("délai dépassé"), { name: "TimeoutError" });
      return new Response(body, { status: 200 });
    };
    await lireLot([{ id: shop === "playin" ? "123456" : "33282", url, shop }], {
      fetchImpl,
      sleep: clk.sleep,
      now: clk.now,
      t0: 0,
      deadline: BUDGET,
      budgetMs: BUDGET,
      delayPlayinMs: 3000,
      timeoutFn,
    });
    assert.ok(clk.t <= BUDGET, `fin à ${clk.t} ms`);
    assert.ok(!calls.some((c) => c.at >= BUDGET));
    assert.ok(calls.length >= 3, "robots + page + retry");
    for (let i = 1; i < calls.length; i++) {
      const gap = calls[i].at - calls[i - 1].at;
      assert.ok(gap >= delay, `écart ${gap} ms < ${delay} ms (${shop})`);
    }
    const fiches = calls.filter((c) => !c.url.endsWith("/robots.txt"));
    assert.ok(fiches.length >= 2, "le retry a bien eu lieu, à la cadence");
    return { calls, t: clk.t };
  };
  await cadence("ultrajeux", URLS.ultrajeux, 4_000, UJ_IN);
  await cadence("playin", URLS.playin, 3_000, playinPage());
});

test("cadence : une redirection autorisée attend 4 s Ultrajeux et 3 s Play-In (cas Data)", async () => {
  // Repro Data : robots à 0, page à 4000, cible redirigée aussi à 4000 (0 ms d'écart).
  // Attendu : chaque requête suivie après redirection attend la cadence de l'enseigne.
  const BUDGET = BUDGET_MAX_MS;
  const chaine = async (shop, url, delay, body) => {
    const clk = horloge(0);
    const calls = [];
    const timeoutFn = () => new AbortController().signal;
    const fetchImpl = async (input, init) => {
      const u = String(input);
      calls.push({ url: u, at: clk.now(), redirect: init?.redirect });
      if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
      if (u === url) return new Response(null, { status: 302, headers: { location: "/redirected" } });
      return new Response(body, { status: 200 });
    };
    await lireLot([{ id: shop === "playin" ? "123456" : "33282", url, shop }], {
      fetchImpl,
      sleep: clk.sleep,
      now: clk.now,
      t0: 0,
      deadline: BUDGET,
      budgetMs: BUDGET,
      delayPlayinMs: 3000,
      timeoutFn,
    });
    assert.ok(clk.t <= BUDGET, `fin à ${clk.t} ms`);
    assert.ok(!calls.some((c) => c.at >= BUDGET), "aucun appel à l'échéance ou après");
    assert.ok(calls.every((c) => c.redirect === "manual"));
    assert.ok(calls.length >= 3, "robots + page + cible redirigée");
    for (let i = 1; i < calls.length; i++) {
      const gap = calls[i].at - calls[i - 1].at;
      assert.ok(gap >= delay, `écart ${gap} ms < ${delay} ms (${shop})`);
    }
    const page = calls.find((c) => c.url === url);
    const cible = calls.find((c) => /\/redirected$/.test(new URL(c.url, url).pathname) || c.url.endsWith("/redirected"));
    assert.ok(page, "la page initiale a été appelée");
    assert.ok(cible, "la cible redirigée a été suivie");
    assert.ok(cible.at - page.at >= delay, `page→cible ${cible.at - page.at} ms < ${delay} ms (${shop})`);
  };
  await chaine("ultrajeux", URLS.ultrajeux, 4_000, UJ_IN);
  await chaine("playin", URLS.playin, 3_000, playinPage());
});

test("cadence : si l'attente d'un saut dépasse l'échéance, la cible n'est pas appelée", async () => {
  // robots à 221000, page à 225000 ; un saut à 229000 laisserait moins que politesse + 1 s
  // avant la réserve POST (230000). On abandonne sans requête vers la cible.
  const BUDGET = BUDGET_MAX_MS;
  const clk = horloge(221_000);
  const calls = [];
  const timeoutFn = () => new AbortController().signal;
  const url = URLS.ultrajeux;
  const fetchImpl = async (input, init) => {
    const u = String(input);
    calls.push({ url: u, at: clk.now(), redirect: init?.redirect });
    if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
    if (u === url) return new Response(null, { status: 302, headers: { location: "/redirected" } });
    return new Response(UJ_IN, { status: 200 });
  };
  const r = await lireLot([{ id: "33282", url, shop: "ultrajeux" }], {
    fetchImpl,
    sleep: clk.sleep,
    now: clk.now,
    t0: 0,
    deadline: BUDGET,
    budgetMs: BUDGET,
    delayPlayinMs: 3000,
    timeoutFn,
  });
  assert.ok(clk.t <= BUDGET, `fin à ${clk.t} ms`);
  assert.ok(!calls.some((c) => c.at >= BUDGET), "aucun appel à l'échéance ou après");
  assert.equal(calls.length, 2, "robots et page seulement");
  assert.ok(calls[0].url.endsWith("/robots.txt"));
  assert.equal(calls[0].at, 221_000);
  assert.equal(calls[1].url, url);
  assert.equal(calls[1].at, 225_000);
  assert.ok(!calls.some((c) => c.url.includes("/redirected")), "cible non suivie une fois l'échéance trop proche");
  assert.equal(r.releves.length, 1);
  assert.equal(r.releves[0].erreur, "reseau");
});
