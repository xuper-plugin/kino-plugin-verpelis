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
