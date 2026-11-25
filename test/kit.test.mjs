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

test("home(): typed rows (Kino's genre tag), a failing row left out, rows kept for the next call", async () => {
  const store = new Map();
  globalThis.kino = { ...kinoWith("es-CO"), storage: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) }, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const card = (n, type = "movie") => ({ url: "https://x.example/" + n, title: "T" + n, type });
  const site2 = { ...site, HOME_ROWS: [
    { id: "a", title: "Estrenos", genre: "peliculas", urls: ["p1"] },
    { id: "b", title: "Series recientes", genre: "series", urls: ["s1"] },
    { id: "c", title: "Infantil", genre: "infantil", urls: ["k1", "k2"] },
    { id: "d", title: "Rota", genre: "documentales", urls: ["bad"] },
  ], listPage: async (u) => {
    if (u === "bad") throw new Error("down");
    if (u === "k1") return [card(1), card(2)];
    if (u === "k2") return [card(2), card(3, "tvshow")];
    return [card(u === "s1" ? 10 : 20, u === "s1" ? "tvshow" : "movie")];
  } };
  const rows = await channel(site2).home();
  assert.deepEqual(rows.map((r) => [r.id, r.genre]), [["a", "peliculas"], ["b", "series"], ["c", "infantil"]]);
  assert.equal(rows[1].items[0].kind, "series");
  assert.deepEqual(rows[2].items.map((i) => i.title), ["T1", "T2", "T3"], "two pages merged, no duplicates");
  assert.ok(rows.every((r) => r.items.length > 0 && r.items.every((i) => i.ref)));
});

test("home(): the site's own rows are typed with Kino's closed vocabulary", async () => {
  const site2 = await import("../src/site.js");
  const ok = new Set(["peliculas", "series", "anime", "infantil", "documentales"]);
  assert.ok(site2.HOME_ROWS.length >= 3);
  for (const r of site2.HOME_ROWS) { assert.ok(ok.has(r.genre), r.id); assert.ok(r.urls.every((u) => u.startsWith(site2.HOST))); }
  assert.ok(site2.HOME_ROWS.some((r) => r.genre === "infantil"));
});

// "Ver más": Home rows carry "hr|<id>", screen rows "l|<listing url>"; browse pages the WordPress <url>page/N/ and answers next.
function pagedSite(asked) {
  const card = (u, n, k) => ({ url: `${u}t${n}-${k}`, title: `T${n}${k}`, type: "movie" });
  return {
    ...site,
    HOME_ROWS: [{ id: "infantil", title: "Infantil", genre: "infantil", urls: ["https://x.example/genre/familia/", "https://x.example/genre/kids/"] }],
    listPage: async (url) => {
      asked.push(url);
      const n = Number((/page\/(\d+)\/$/.exec(url) || [])[1] || 1);
      return n > 2 ? [] : [card(url, n, "a"), card(url, n, "b")];
    },
    catalog: async () => [
      { title: "Estrenos", url: "https://x.example/movies/", items: [{ url: "https://x.example/a", title: "A", type: "movie" }] },
      { title: "Fuera", url: "https://other.example/movies/", items: [{ url: "https://x.example/b", title: "B", type: "movie" }] },
      { title: "Sin lista", items: [{ url: "https://x.example/c", title: "C", type: "movie" }] },
    ],
  };
}

test("home rows carry a hr| ref; browse pages every listing of the row and answers next while titles come", async () => {
  globalThis.kino = { ...kinoWith("es"), sleep: async () => {} };
  const asked = [];
  const ch = channel(pagedSite(asked));
  const rows = await ch.home();
  assert.ok(rows.length);
  for (const r of rows) assert.equal(r.ref, "hr|" + r.id); // home() keeps its last answer a while (an earlier test's rows here)
  asked.length = 0;
  const p1 = await ch.browse("hr|infantil", null);
  assert.deepEqual(asked, ["https://x.example/genre/familia/", "https://x.example/genre/kids/"]);
  assert.equal(p1.items.length, 4);
  assert.equal(p1.next, "2");
  assert.equal(p1.cursor, undefined);
  asked.length = 0;
  const p2 = await ch.browse("hr|infantil", p1.next);
  assert.deepEqual(asked, ["https://x.example/genre/familia/page/2/", "https://x.example/genre/kids/page/2/"]);
  assert.equal(p2.items.length, 4);
  assert.notEqual(p2.items[0].ref, p1.items[0].ref);
  assert.deepEqual(await ch.browse("hr|infantil", "3"), { items: [] });
  await assert.rejects(ch.browse("hr|nope", null), (e) => e.code === "not_found");
});

test("screen rows carry an l| ref only for the site's own listing; browse refuses any other url", async () => {
  globalThis.kino = kinoWith("es");
  const asked = [];
  const ch = channel(pagedSite(asked));
  const rows = await ch.catalogRows("movie");
  assert.deepEqual(rows.map((r) => r.ref), ["l|https://x.example/movies/", undefined, undefined]);
  const p2 = await ch.browse(rows[0].ref, "2");
  assert.deepEqual(asked, ["https://x.example/movies/page/2/"]);
  assert.equal(p2.next, "3");
  for (const bad of ["l|https://other.example/movies/", "l|https://x.example/", "l|https://x.example/../x/", "l|https://x.example/?s=a", "m|https://x.example/a", null]) {
    await assert.rejects(ch.browse(bad, null), (e) => e.code === "not_found", String(bad));
  }
  assert.equal(asked.length, 1);
});
