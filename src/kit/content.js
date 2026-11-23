// channel-kit: the generic content-plugin glue. `channel(site)` -> Kino exports search/episodes/resolve, and
// `catalogRows(kind)` for the standard screen (src/std) the plugin draws. A new site writes only its site.js.
//
// Site interface (site.js):
//   export const HOST = "https://example.com/";
//   export const NAME = "Example";
//   export async function search(q)        -> [{ url, title, thumb?, year?, type:"movie"|"tvshow" }]
//   export async function findvideos(url)  -> [{ url, lang? }]
//   export async function catalog(kind)    -> [{ title, titleEn?, items:[{url,title,thumb?,year?,type}] }]  // kind: "movie"|"tvshow"
//   export async function seasons(url)     -> [{ season }]                                                  // optional (series)
//   export async function episodesOf(url, season) -> [{ url, season, epis, title?, thumb? }]                // optional

const LANG = { Lat: "Latino", LAT: "Latino", Esp: "Español", ESP: "Español", Vose: "VOSE", VOSE: "VOSE" };
const TTL = 300000;

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
      const m = /^([mes])\|(.+)$/.exec(String(ref));
      if (!m) throw kino.error("not_found", "bad ref: " + String(ref).slice(0, 80));
      // This plugin plays nothing on its own: the shared kino-resolver does the hosters. If it is not installed, send the
      // person to the screen to install it (the probe is provider_missing only when it is truly absent).
      let resolverUp = true;
      try { await kino.plugins.call("resolver", "normalizeHost", { url: "https://probe.invalid/" }); } catch (err) { resolverUp = (err && err.code) !== "provider_missing"; }
      if (!resolverUp) throw kino.error("unavailable", "resolver missing", { userMessage: say("Para reproducir, abre " + name + " desde el menú e instala el motor de reproducción que te pedirá.", "To play, open " + name + " from the menu and install the playback engine it asks for.") });
      const embeds = await site.findvideos(m[2]);
      if (!embeds || !embeds.length) throw kino.error("not_found", "no embeds", { userMessage: say("Sin enlaces disponibles", "No links available") });
      const streams = [];
      const seen = new Set();
      const collect = (got, lang) => {
        for (const s of got) {
          if (!s.url || seen.has(s.url)) continue;
          seen.add(s.url);
          const stream = { url: s.url };
          const label = ((LANG[lang] || lang || "") + (s.server ? " · " + s.server : "")).trim().slice(0, 48);
          if (label) stream.label = label;
          if (s.mime) stream.mime = s.mime;
          const hdrs = {};
          for (const h of s.headers || []) hdrs[h.name] = h.value;
          if (s.referer && !hdrs.Referer) hdrs.Referer = s.referer;
          if (Object.keys(hdrs).length) stream.headers = hdrs;
          streams.push(stream);
        }
      };
      const needBrowser = [];
      // The hosts that have resolved inline for this person go first, so the default (main) stream is the most reliable;
      // the site's order breaks ties, so with no history this is exactly the site's order.
      const stats = readStats();
      const ordered = embeds.map((e, i) => ({ e, i })).sort((a, b) => scoreOf(hostOf(b.e.url), stats) - scoreOf(hostOf(a.e.url), stats) || a.i - b.i).map((x) => x.e);
      // Pass 1: the resolver (inline) for EVERY embed — fast; unknown/dead hosts return instantly. Fresh
      // content has an inline server (voe, vimeos, …) and resolves here without ever touching the browser.
      // Record the embeds the resolver says need a JS browser (a gated host like streamwish, an SPA like
      // filemoon); skip the ones it calls "dead" so Pass 2 never wastes a WebView on an expired upload.
      for (const e of ordered) {
        try {
          const res = await kino.plugins.call("resolver", "resolve", { url: e.url, referer: site.HOST });
          const got = (res && res.streams) || [];
          collect(got, e.lang);
          noteServer(hostOf(e.url), got.length > 0);
          if (!got.length && res && res.error === "needs_browser") needBrowser.push(e);
        } catch { noteServer(hostOf(e.url), false); needBrowser.push(e); }
      }
      // Pass 2: ONLY the needs-browser embeds, and ONLY if nothing resolved inline — Kino's WebView as a
      // last resort (needs browser + any-host; kino.browser.capture runs in resolve(), never in the
      // resolver's provider door). The page autoplays and we capture its media; one working stream is enough.
      if (!streams.length && needBrowser.length && globalThis.kino && kino.browser && typeof kino.browser.capture === "function") {
        for (const e of needBrowser) {
          try {
            const cap = await kino.browser.capture(e.url, { headers: { Referer: site.HOST }, timeoutMs: 18000 });
            collect(((cap && cap.media) || []).map((mm) => ({
              url: mm.url, server: "browser",
              headers: Object.entries(mm.headers || {}).filter(([, v]) => v != null).map(([name, value]) => ({ name, value: String(value) })),
            })), e.lang);
          } catch { /* ignore */ }
          if (streams.length) break;
        }
      }
      if (!streams.length) throw kino.error("not_found", "no playable streams", { userMessage: say("No se pudo resolver el video", "The video could not be opened") });
      const [first, ...rest] = streams;
      const main = { ...first, expiresInSeconds: 1800 };
      if (rest.length) main.alternatives = rest.slice(0, 8);
      return main;
    },

    /** The site's catalog for one kind ("movie", "tvshow", "popular") as the standard screen's rows (5 min cache). */
    async catalogRows(kind) {
      return (await loadCatalog(kind)).map((r) => ({ id: slug(r.title), title: r.title, ...(r.titleEn ? { titleEn: r.titleEn } : {}), items: r.items }));
    },
  };
}
