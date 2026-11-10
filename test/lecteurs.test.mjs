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
} from "../checker/dispatch.mjs";
import { readProduct, detectChallenge } from "../checker/playin.mjs";
import { lotPath, LOT_SHOPS_QUERY, runPassage, délaisDuLot, budgetDuLot } from "../checker/passage.mjs";

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
    calls.push({ url, ua, headers: init?.headers ?? {} });
    if (url.endsWith("/robots.txt")) {
      const body = typeof robots === "function" ? robots(url) : robots;
      const status = statusOf[url] ?? 200;
      return new Response(body, { status, headers: headersOf[url] });
    }
    const p = pages[url];
    if (!p) return new Response("absent", { status: 404 });
    const status = p.status ?? statusOf[url] ?? 200;
    const r = new Response(p.body ?? "", { status, headers: p.headers ?? headersOf[url] });
    if (p.redirectTo) {
      Object.defineProperty(r, "redirected", { value: true });
      Object.defineProperty(r, "url", { value: p.redirectTo });
    }
    return r;
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
