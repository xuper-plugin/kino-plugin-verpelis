// channel-kit: the generic content-plugin glue. `channel(site)` -> Kino exports search/episodes/resolve, and
// `catalogRows(kind)` for the standard screen (src/std) the plugin draws. A new site writes only its site.js.
//
// Site interface (site.js):
//   export const HOST = "https://example.com/";
//   export const NAME = "Example";
//   export async function search(q)        -> [{ url, title, thumb?, year?, type:"movie"|"tvshow" }]
//   export async function findvideos(url)  -> [{ url, lang? }]
//   export async function catalog(kind)    -> [{ title, titleEn?, items:[{url,title,thumb?,year?,type}] }]  // kind: "movie"|"tvshow"
//   export const HOME_ROWS = [{ id, title, titleEn?, genre, urls:[listing pages] }]  // optional: the typed rows of home()
//   export async function listPage(url)    -> [{ url, title, thumb?, year?, type }]                         // with HOME_ROWS
//   export async function seasons(url)     -> [{ season }]                                                  // optional (series)
//   export async function episodesOf(url, season) -> [{ url, season, epis, title?, thumb? }]                // optional

import { rankServers } from "../std/rank.js";
const LANG = { Lat: "Latino", LAT: "Latino", Esp: "Español", ESP: "Español", Vose: "VOSE", VOSE: "VOSE" };
const TTL = 300000;
const HOME_KEY = "home:last", HOME_KEEP_MS = 12 * 3600 * 1000, HOME_BUDGET_MS = 11000, HOME_ROW_MAX = 20;
let homeMem = null;

// The English name of a genre row the site names in Spanish (keys without accents, lower case); a genre not here shows in Spanish.
const GENRE_EN = {
  accion: "Action", aventura: "Adventure", animacion: "Animation", anime: "Anime", belica: "War", guerra: "War",
  "ciencia ficcion": "Science fiction", "ciencia-ficcion": "Science fiction", comedia: "Comedy", crimen: "Crime",
  documental: "Documentary", documentales: "Documentaries", drama: "Drama", familia: "Family", familiar: "Family",
  fantasia: "Fantasy", historia: "History", historica: "History", infantil: "Kids", misterio: "Mystery", musica: "Music",
  musical: "Musical", romance: "Romance", romantica: "Romance", suspenso: "Thriller", suspense: "Thriller", thriller: "Thriller",
  terror: "Horror", western: "Western", deporte: "Sport", deportes: "Sports", biografia: "Biography", dorama: "K-drama",
  doramas: "K-dramas", "pelicula de tv": "TV movie", "reality": "Reality", "series": "Series", "peliculas": "Movies",
};
const genreEn = (title) => GENRE_EN[String(title || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase()];

function slug(url) {
  const last = String(url).replace(/\/+$/, "").split("/").pop() || "x";
  return last.replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 120) || "x";
}

// ---- learned server reliability: the hosts that resolve inline for this person are tried first next time, so the
//      default (main) stream is the most reliable; every embed is still resolved, only the order (hence main) changes. ----
/** Hidden-browser pages one resolve may open (20 s each; Kino gives a resolve 75 s). */
const MAX_CAPTURES = 2;
const STATS_KEY = "srvStats";
const STATS_CAP = 24; // halve the counts past this, so a host that recovers climbs back
function readStats() { try { return JSON.parse((kino.storage && kino.storage.get(STATS_KEY)) || "{}") || {}; } catch (_) { return {}; } }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } }
/** Laplace-smoothed inline success rate of a host (unknown = 0.5). */
function scoreOf(id, stats) { const s = stats[id] || { ok: 0, fail: 0 }; return (s.ok + 1) / (s.ok + s.fail + 2); }
/** Record that a host resolved inline (ok=true) or not; never throws. */
function noteServer(id, ok) {
  if (!id) return;
  try {
    const stats = readStats();
    const s = stats[id] || { ok: 0, fail: 0 };
    s[ok ? "ok" : "fail"] += 1;
    if (s.ok + s.fail > STATS_CAP) { s.ok = Math.round(s.ok / 2); s.fail = Math.round(s.fail / 2); }
    stats[id] = s;
    if (kino.storage) kino.storage.set(STATS_KEY, JSON.stringify(stats));
  } catch (_) { /* the stats are a nicety */ }
}

/** A message for the person in their language: Spanish when Kino's language is Spanish, else English. */
const say = (es, en) => (String((globalThis.kino && kino.lang) || "").toLowerCase().startsWith("es") ? es : en);

export function channel(site) {
  const name = site.NAME || "este sitio";

  function mapItem(it) {
    const item = { id: slug(it.url), ref: (it.type === "tvshow" ? "s|" : "m|") + it.url, title: it.title, kind: it.type === "tvshow" ? "series" : "movie" };
    const y = Number(it.year); if (y) item.year = y;
    if (it.thumb) item.poster = it.thumb;
    return item;
  }
  const doSearch = async (q) => ((await site.search(String(q || ""))) || []).map(mapItem);

  const cache = {}, at = {};
  async function loadCatalog(tab) {
    if (!site.catalog) return [];
    const now = Date.now();
    if (cache[tab] && now - at[tab] < TTL) return cache[tab];
    try {
      const rows = (await site.catalog(tab)) || [];
      cache[tab] = rows.map((r) => ({ title: r.title, titleEn: r.titleEn || genreEn(r.title), items: (r.items || []).map(mapItem) })).filter((r) => r.items.length);
      at[tab] = now;
    } catch { cache[tab] = cache[tab] || []; }
    return cache[tab];
  }

  return {
    async search(query) { return doSearch(String((query && query.q) || "")); },

    async episodes(ref) {
      if (!String(ref).startsWith("s|")) throw kino.error("not_found", "not a series ref");
      if (!site.seasons || !site.episodesOf) throw kino.error("not_found", "this site has no episodes");
      const url = String(ref).slice(2);
      const eps = [];
      for (const t of (await site.seasons(url)) || []) {
        for (const e of (await site.episodesOf(url, t.season)) || []) {
          const ep = { season: Number(e.season) || 1, number: Number(e.epis) || 0, ref: "e|" + e.url };
          if (e.title) ep.title = e.title;
          if (e.thumb) ep.still = e.thumb;
          eps.push(ep);
        }
      }
      if (!eps.length) throw kino.error("not_found", "no episodes", { userMessage: say("No hay episodios disponibles", "No episodes available") });
      return { episodes: eps };
    },

    async resolve(ref) {
      const m = /^([mesx])\|(.+)$/.exec(String(ref));
      if (!m) throw kino.error("not_found", "bad ref: " + String(ref).slice(0, 80));
      // This plugin plays nothing on its own: the shared kino-resolver does the hosters. If it is not installed, send the
      // person to the screen to install it (the probe is provider_missing only when it is truly absent).
      let resolverUp = true;
      try { await kino.plugins.call("resolver", "normalizeHost", { url: "https://probe.invalid/" }); } catch (err) { resolverUp = (err && err.code) !== "provider_missing"; }
      if (!resolverUp) throw kino.error("unavailable", "resolver missing", { userMessage: say("Para reproducir, abre " + name + " desde el menú e instala el motor de reproducción que te pedirá.", "To play, open " + name + " from the menu and install the playback engine it asks for.") });
      // One server's own address ("x|<lang>|<embed>"): a copy the person picked, or the player's fallback. The site is not asked again.
      const cut = m[1] === "x" ? m[2].indexOf("|") : -1;
      const one = cut >= 0 && m[2].slice(cut + 1).startsWith("https://") ? [null, m[2].slice(0, cut), m[2].slice(cut + 1)] : null;
      if (m[1] === "x" && !one) throw kino.error("not_found", "bad ref: " + String(ref).slice(0, 80));
      const embeds = one ? [{ url: one[2], lang: one[1] }] : await site.findvideos(m[2]);
      if (!embeds || !embeds.length) throw kino.error("not_found", "no embeds", { userMessage: say("Sin enlaces disponibles", "No links available") });
      const labelOf = (lang, server) => ((LANG[lang] || lang || "") + (server ? " · " + server : "")).trim().slice(0, 48);
      const toStreams = (got, lang) => {
        const out = [];
        const seen = new Set();
        for (const s of got) {
          if (!s.url || seen.has(s.url)) continue;
          seen.add(s.url);
          const stream = { url: s.url };
          const label = labelOf(lang, s.server);
          if (label) stream.label = label;
          if (s.mime) stream.mime = s.mime;
          const hdrs = {};
          for (const h of s.headers || []) hdrs[h.name] = h.value;
          if (s.referer && !hdrs.Referer) hdrs.Referer = s.referer;
          if (Object.keys(hdrs).length) stream.headers = hdrs;
          out.push(stream);
        }
        return out;
      };
      // The hosts that have resolved inline for this person go first; the resolver's ranking breaks ties (its rank call, from
      // the playback audit), else the site's order.
      const stats = readStats();
      const ranked = one ? embeds : await rankServers(kino, embeds, (e) => e.url);
      const ordered = ranked.map((e, i) => ({ e, i })).sort((a, b) => scoreOf(hostOf(b.e.url), stats) - scoreOf(hostOf(a.e.url), stats) || a.i - b.i).map((x) => x.e);
      /** The other servers as copies Kino resolves only when asked (the menu, or its own fallback when one does not play). */
      const lazy = (skip) => ordered.filter((e) => e !== skip).map((e) => ({ ref: "x|" + (e.lang || "") + "|" + e.url, label: labelOf(e.lang, hostOf(e.url).split(".")[0]) }));
      const deliver = (streams, from) => {
        const [first, ...rest] = streams;
        const main = { ...first, expiresInSeconds: 1800 };
        const others = one ? rest : [...rest, ...lazy(from)];
        if (others.length) main.alternatives = others.slice(0, 8);
        return main;
      };
      // Pass 1: the resolver (inline), one server after another IN ORDER, and the first that answers plays. Every server used
      // to be resolved before the first frame (10-13 s on a page with six of them, measured 2026-11-24); the rest are now
      // lazy copies. The ones the resolver says need a JS browser are kept for pass 2; a "dead" one is dropped.
      const needBrowser = [];
      for (const e of ordered) {
        try {
          const res = await kino.plugins.call("resolver", "resolve", { url: e.url, referer: site.HOST });
          const got = toStreams((res && res.streams) || [], e.lang);
          noteServer(hostOf(e.url), got.length > 0);
          if (got.length) return deliver(got, e);
          if (res && res.error === "needs_browser") needBrowser.push(e);
        } catch { noteServer(hostOf(e.url), false); needBrowser.push(e); }
      }
      // Pass 2: ONLY the needs-browser embeds, and ONLY because nothing resolved inline — Kino's WebView as a
      // last resort (needs browser + any-host; kino.browser.capture runs in resolve(), never in the
      // resolver's provider door). The page autoplays and we capture its media; one working stream is enough.
      if (needBrowser.length && globalThis.kino && kino.browser && typeof kino.browser.capture === "function") {
        for (const e of needBrowser.slice(0, MAX_CAPTURES)) {
          try {
            const cap = await kino.browser.capture(e.url, { headers: { Referer: site.HOST }, timeoutMs: 18000 });
            const got = toStreams(((cap && cap.media) || []).map((mm) => ({
              url: mm.url, server: "browser",
              headers: Object.entries(mm.headers || {}).filter(([, v]) => v != null).map(([name, value]) => ({ name, value: String(value) })),
            })), e.lang);
            if (got.length) return deliver(got, e);
          } catch { /* ignore */ }
        }
      }
      throw kino.error("not_found", "no playable streams", { userMessage: say("No se pudo resolver el video", "The video could not be opened") });
    },

    /**
     * Kino's Home by categories (the `home` export): one row per kind of title the site can fill, each tagged with its type
     * (`genre`) so Kino shelves it under Películas, Series, Infantil... The rows come from site.HOME_ROWS ([{ id, title, titleEn,
     * genre, urls }], every url a listing page) through site.listPage; a row whose pages fail is left out, the rows that answered
     * within the budget are shown, and the last Home that worked is kept for 12 h (also the answer when none arrives in time).
     */
    async home() {
      const defs = site.HOME_ROWS || [];
      if (!defs.length || !site.listPage) return [];
      const now = Date.now();
      if (homeMem && now - homeMem.at < TTL * 6) return homeMem.rows;
      const out = defs.map(() => null);
      let done = false;
      const all = Promise.all(defs.map((d, i) => Promise.resolve().then(async () => {
        const pages = await Promise.all(d.urls.map((u) => site.listPage(u).catch(() => [])));
        const seen = new Set();
        const items = [];
        for (let k = 0; items.length < HOME_ROW_MAX; k++) {
          let any = false;
          for (const p of pages) if (k < p.length) { any = true; if (!seen.has(p[k].url)) { seen.add(p[k].url); items.push(mapItem(p[k])); } }
          if (!any) break;
        }
        if (items.length) out[i] = { id: d.id, title: d.title, ...(d.titleEn ? { titleEn: d.titleEn } : {}), genre: d.genre, items: items.slice(0, HOME_ROW_MAX) };
      }).catch(() => {}))).then(() => { done = true; });
      const end = Date.now() + HOME_BUDGET_MS;
      while (!done && Date.now() < end) await Promise.race([all, kino.sleep(Math.min(250, Math.max(1, end - Date.now())))]);
      const rows = out.filter(Boolean);
      if (rows.length) {
        homeMem = { at: Date.now(), rows };
        try { kino.storage.set(HOME_KEY, JSON.stringify({ at: Date.now(), rows }), { ttlMs: HOME_KEEP_MS }); } catch (_) { /* the copy is a nicety */ }
        return rows;
      }
      try { const o = JSON.parse(kino.storage.get(HOME_KEY) || "null"); if (o && Array.isArray(o.rows) && Date.now() - o.at < HOME_KEEP_MS) return o.rows; } catch (_) { /* none kept */ }
      return [];
    },

    /** The site's catalog for one kind ("movie", "tvshow", "popular") as the standard screen's rows (5 min cache). */
    async catalogRows(kind) {
      return (await loadCatalog(kind)).map((r) => ({ id: slug(r.title), title: r.title, ...(r.titleEn ? { titleEn: r.titleEn } : {}), items: r.items }));
    },
  };
}
