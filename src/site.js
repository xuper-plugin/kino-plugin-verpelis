// VerPelis (verpelis.gratis) — the site-specific scraper. Everything else is channel-kit.
import { single, multi, dl, clean } from "./kit/scrape.js";

export const HOST = "https://verpelis.gratis/";
export const NAME = "VerPelis";

export async function search(q) {
  const data = await dl(HOST + "?s=" + encodeURIComponent(String(q)).replace(/%20/g, "+"));
  const bloque = single(data, "</h1>(.*?)</div></div></div>");
  const items = [];
  for (const m of multi(bloque, "<article(.*?)</article>")) {
    const url = single(m, '<a href="(.*?)"');
    let title = single(m, 'alt="(.*?)"').trim();
    if (!url || !title) continue;
    title = clean(title);
    const thumb = single(m, '<img src="(.*?)"');
    const cy = single(title, "(\\d{4})"); if (cy) title = title.replace("(" + cy + ")", "").trim();
    const year = single(m, '<span class="year">(.*?)</span>') || "";
    // Movies only: the site lists series but has no video for any episode (its player answers embed_url null for every
    // one, measured on 14 series, 2026-11-24), so a series would open and never play.
    if (m.includes(">TV<") || /\/series\//.test(url)) continue;
    items.push({ url, title, thumb, year, type: "movie" });
  }
  return items;
}

function parseCards(bloque) {
  const out = [];
  for (const m of multi(bloque, "<article(.*?)</article>")) {
    const u = single(m, '<a href="(.*?)"');
    const title = clean(single(m, 'alt="(.*?)"'));
    if (!u || !title) continue;
    if (/\/series\//.test(u)) continue;
    out.push({ url: u, title, thumb: single(m, '<img src="(.*?)"'), year: single(m, "</h3><span>(.*?)</span>") || "", type: "movie" });
    if (out.length >= 18) break;
  }
  return out;
}
export async function listPage(url) {
  const data = await dl(url);
  const bloque = single(data, ">Añadido recientemente<(.*?)>Géneros<") || single(data, "</h1>(.*?)>Géneros<") || data;
  return parseCards(bloque);
}
// Kino's Home by categories: one typed row per kind of title the site has, movies only (the site has no video for series). Its genre
// page "familia" is the kids' shelf and "documental" the documentaries; it has no anime section, so no Anime row. `genre` is Kino's type tag.
// Its genre pages live under /genero/ (2026-11-25: /genre/documental/ is a 404 and /genre/familia/ redirects to one film's page).
export const HOME_ROWS = [
  { id: "estrenos", title: "Estrenos", titleEn: "New releases", genre: "peliculas", urls: [HOST + "peliculas/"] },
  { id: "peliculas-populares", title: "Películas populares", titleEn: "Popular movies", genre: "peliculas", urls: [HOST + "tendencias/"] },
  { id: "infantil", title: "Infantil", titleEn: "Kids", genre: "infantil", urls: [HOST + "genero/familia/"] },
  { id: "documentales", title: "Documentales", titleEn: "Documentaries", genre: "documentales", urls: [HOST + "genero/documental/"] },
];

async function genreList(base) {
  const data = await dl(base);
  const bloque = single(data, ">Géneros<(.*?)</ul>");
  return multi(bloque, '<a href="(.*?)".*?>(.*?)</a>').map(([u, t]) => ({ url: u, title: clean(String(t)).replace(/&amp;/g, "&") })).filter((g) => g.url && g.title);
}

// Populares tab: /tendencias/ is a mixed movie+series grid; only its movies are kept.
async function popularCatalog() {
  const movies = parseCards(await dl(HOST + "tendencias/"));
  return movies.length ? [{ title: "Películas populares", titleEn: "Popular movies", url: HOST + "tendencias/", items: movies }] : [];
}

// Home rows for a tab. kind: "movie" (Películas) | "popular" (Populares). Row 0 = recent/top (feeds the hero), then a rail
// per genre.
export async function catalog(kind) {
  if (kind === "popular") return popularCatalog();
  const base = HOST + "peliculas/";
  const recientes = await listPage(base);
  const rows = [];
  if (recientes.length) rows.push({ title: "Estrenos", titleEn: "New releases", url: base, items: recientes });
  let genres = [];
  try { genres = await genreList(base); } catch { /* ignore */ }
  const genreRows = await Promise.all(genres.slice(0, 6).map(async (g) => {
    try { const items = await listPage(g.url); return items.length ? { title: g.title, url: g.url, items } : null; } catch { return null; }
  }));
  for (const r of genreRows) if (r) rows.push(r);
  return rows;
}

/**
 * The embed behind one player option. The GET form (/wp-json/dooplayer/v2/<post>/<type>/<nume>) is the one the site answers;
 * the POST form 404s since 2026-11 and was asked first, once per option, one option after another: ~14 s of 404s per play
 * (measured 2026-11-22). Now GET first, POST only as the fallback.
 */
async function embedOf(url, dpost, dtype, dnume) {
  try {
    const d1 = await dl(HOST + "wp-json/dooplayer/v2/" + dpost + "/" + dtype + "/" + dnume, null, { Referer: url });
    const embed = single(d1, '"embed_url":"(.*?)"');
    if (embed) return embed;
  } catch { /* try the other form */ }
  try {
    const d2 = await dl(HOST + "wp-json/dooplayer/v2/", { action: "doo_player_ajax", post: dpost, nume: dnume, type: dtype }, { Referer: url });
    return single(d2, '"embed_url":"(.*?)"') || null;
  } catch { return null; }
}

export async function findvideos(url) {
  const data = await dl(url);
  const options = [];
  for (const option of multi(data, "<li id='player-option-(.*?)</li>")) {
    const dpost = single(option, " data-post='(.*?)'");
    const dtype = single(option, " data-type='(.*?)'");
    const dnume = single(option, " data-nume='(.*?)'");
    if (!dpost || !dtype || !dnume || dnume === "trailer") continue;
    options.push({ option, dpost, dtype, dnume });
  }
  // The options are asked together (a page lists a handful; Kino runs at most 6 requests of a plugin at once), in page order.
  const embeds = await Promise.all(options.map((o) => embedOf(url, o.dpost, o.dtype, o.dnume)));
  const out = [];
  options.forEach((o, i) => {
    if (!embeds[i]) return;
    const lang = o.option.includes("mx.png") ? "Lat" : o.option.includes("es.png") ? "Esp" : o.option.includes("vose.png") ? "Vose" : "?";
    out.push({ url: embeds[i].replaceAll("\\/", "/"), lang });
  });
  return out;
}
