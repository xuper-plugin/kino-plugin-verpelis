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

// resolve(): the first server that answers plays; the others are lazy copies ("x|<lang>|<embed>") resolved only when asked.
function doorKino(answers, asked) {
  return {
    lang: "es-CO",
    storage: { get: () => null, set() {} },
    error: (code, message, extra) => Object.assign(new Error(message), { code }, extra || {}),
    plugins: { call: async (alias, call, arg) => {
      if (call === "normalizeHost") return { host: "" };
      if (call === "rank") throw Object.assign(new Error("old resolver"), { code: "provider_failed" });
      asked.push(arg.url);
      return answers[arg.url] || { streams: [], error: "needs_browser" };
    } },
  };
}
const three = { ...site, findvideos: async () => [
  { url: "https://a.example/e/1", lang: "Lat" }, { url: "https://b.example/e/2", lang: "Lat" }, { url: "https://c.example/e/3", lang: "Esp" },
] };

test("resolve stops at the first server that answers; the rest are lazy copies, not resolved", async () => {
  const asked = [];
  globalThis.kino = doorKino({ "https://a.example/e/1": { streams: [], error: "dead" }, "https://b.example/e/2": { streams: [{ url: "https://cdn/b.m3u8", server: "bhost", referer: "https://b.example/" }] } }, asked);
  const s = await channel(three).resolve("m|https://x.example/a");
  assert.equal(s.url, "https://cdn/b.m3u8");
  assert.equal(s.headers.Referer, "https://b.example/");
  assert.deepEqual(asked, ["https://a.example/e/1", "https://b.example/e/2"], "the third server is not resolved before the first frame");
  assert.deepEqual(s.alternatives.map((a) => a.ref), ["x|Lat|https://a.example/e/1", "x|Esp|https://c.example/e/3"]);
});

test("a lazy copy's ref resolves that one server, without asking the site again", async () => {
  const asked = [];
  globalThis.kino = doorKino({ "https://c.example/e/3": { streams: [{ url: "https://cdn/c.mp4", server: "chost" }] } }, asked);
  const s = await channel({ ...three, findvideos: async () => { throw new Error("the site must not be asked"); } }).resolve("x|Esp|https://c.example/e/3");
  assert.equal(s.url, "https://cdn/c.mp4");
  assert.equal(s.alternatives, undefined);
  assert.deepEqual(asked, ["https://c.example/e/3"]);
  await assert.rejects(channel(three).resolve("x|Esp|ftp://nope"), (e) => e.code === "not_found");
});
