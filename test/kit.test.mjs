// The channel-kit glue (src/kit/content.js): what the person reads when the resolver is missing, in their language.
import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "../src/kit/content.js";

function kinoWith(lang) {
  return {
    lang,
    storage: { get: () => null, set() {} },
    plugins: { call: async () => { throw Object.assign(new Error("missing"), { code: "provider_missing" }); } },
    error: (code, message, extra) => Object.assign(new Error(message), { code }, extra || {}),
  };
}
const site = { NAME: "Sitio", HOST: "https://x.example/", search: async () => [], findvideos: async () => [] };

for (const [lang, word] of [["es-CO", "instala"], ["en", "install"]]) {
  test(`resolver missing: the install hint in ${lang}`, async () => {
    globalThis.kino = kinoWith(lang);
    await assert.rejects(channel(site).resolve("m|https://x.example/a"), (e) => {
      assert.equal(e.code, "unavailable");
      assert.match(e.userMessage, new RegExp(word));
      assert.match(e.userMessage, /Sitio/);
      return true;
    });
  });
}

test("catalog rows carry their English title: the site's own, else a known genre's, else none", async () => {
  globalThis.kino = kinoWith("en");
  const item = { url: "https://x.example/a", title: "A", type: "movie" };
  const ch = channel({ ...site, catalog: async () => [
    { title: "Estrenos", titleEn: "New releases", items: [item] },
    { title: "Acción", items: [item] },
    { title: "Ciencia ficción", items: [item] },
    { title: "Telenovelas raras", items: [item] },
  ] });
  const rows = await ch.catalogRows("movie");
  assert.deepEqual(rows.map((r) => r.titleEn), ["New releases", "Action", "Science fiction", undefined]);
});
