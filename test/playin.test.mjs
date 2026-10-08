import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRobots, robotsAllows, detectChallenge, isPlayinProductUrl, redirectGone, readProduct, price } from "../checker/playin.mjs";

const page = ({ availability = "https://schema.org/InStock", prix = "49.99", store = null, seller = null } = {}) => {
  const offer = { "@type": "Offer", availability, price: prix, priceCurrency: "EUR", ...(seller ? { seller: { name: seller } } : {}) };
  const ld = { "@context": "https://schema.org", "@type": "Product", name: "Exemple", sku: "123456", image: "https://example.test/a.jpg", gtin13: "0820650850011", offers: offer };
  const next = store
    ? `<script>self.__next_f.push([1,"{\\"_id\\":123456,\\"productStores\\":{\\"items\\":[{\\"__typename\\":\\"ProductStore\\",\\"storeStockState\\":\\"${store}\\",\\"store\\":{\\"_id\\":0,\\"warehouse\\":true}}]}"])</script>`
    : "";
  return `<html><head><title>Exemple</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>${next}</body></html>`;
};

test("en stock seulement si l'entrepôt en ligne est STOCK_IN_WAREHOUSE", () => {
  assert.equal(readProduct(page({ store: "STOCK_IN_WAREHOUSE" })).etat, "in_stock");
  assert.equal(readProduct(page({ store: "STOCK_IN_STORE" })).etat, "out_of_stock");
  assert.equal(readProduct(page({ store: "OUT_OF_STOCK" })).etat, "out_of_stock");
  // JSON-LD « en stock » sans donnée d'entrepôt : inconnu.
  assert.equal(readProduct(page()).etat, "unknown");
  assert.equal(readProduct(page({ availability: "https://schema.org/OutOfStock" })).etat, "out_of_stock");
  assert.equal(readProduct(page({ availability: "https://schema.org/PreOrder", store: "STOCK_IN_WAREHOUSE" })).etat, "preorder");
});

test("prix 0 = inconnu", () => {
  assert.equal(readProduct(page({ prix: "0", store: "OUT_OF_STOCK", availability: "https://schema.org/OutOfStock" })).prix, null);
  assert.equal(price(0), null);
  assert.equal(price("12,5"), 12.5);
  assert.equal(readProduct(page({ store: "STOCK_IN_WAREHOUSE" })).prix, 49.99);
});

test("vendeur tiers écarté", () => {
  const p = readProduct(page({ seller: "Autre Boutique", store: "STOCK_IN_WAREHOUSE" }));
  assert.equal(p.vendeur, false);
  assert.equal(readProduct(page({ seller: "Play-In", store: "STOCK_IN_WAREHOUSE" })).vendeur, true);
});

test("pas de JSON-LD : null", () => {
  assert.equal(readProduct("<html></html>"), null);
});

test("robots.txt", () => {
  const g = parseRobots("User-agent: *\nDisallow: /*/panier\nDisallow: /*sortBy=\nDisallow: https://rachat.play-in.com/produit/\n");
  assert.equal(robotsAllows(g, "/fr/produit/123/abc"), true);
  assert.equal(robotsAllows(g, "/fr/panier"), false);
  assert.equal(robotsAllows(g, "/fr/x?sortBy=a"), false);
  const g2 = parseRobots("User-agent: cotlyxbot\nDisallow: /\n");
  assert.equal(robotsAllows(g2, "/fr/produit/1/a"), false);
});

test("défis et redirections", () => {
  assert.equal(detectChallenge(403, null, ""), "http");
  assert.equal(detectChallenge(200, null, "<title>Just a moment...</title>"), "defi");
  assert.equal(detectChallenge(200, new Headers(), page()), null);
  assert.equal(redirectGone("123", true, "https://www.play-in.com/fr/categorie/pokemon"), true);
  assert.equal(redirectGone("123", true, "https://www.play-in.com/fr/produit/123/abc"), false);
  assert.equal(redirectGone("123", false, null), false);
  assert.equal(isPlayinProductUrl("https://www.play-in.com/fr/produit/123/abc"), true);
  assert.equal(isPlayinProductUrl("https://evil.test/fr/produit/123/abc"), false);
  assert.equal(isPlayinProductUrl("https://www.play-in.com/fr/produit/123/abc?x=1"), false);
});
