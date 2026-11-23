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
    items.push({ url, title, thumb, year, type: m.includes(">TV<") ? "tvshow" : "movie" });
  }
  return items;
}

export async function seasons(url) {
  const data = await dl(url);
  return multi(data, "<span class='se-t.*?'>(.*?)</span>").map((t) => ({ season: String(t).trim() }));
}

export async function episodesOf(url, season) {
  const data = await dl(url);
  const bloque = single(data, "<span class='se-t.*?'>" + season + "</span>(.*?)</ul>");
  const out = [];
  for (const [thumb, se, epUrl, title] of multi(bloque, "<li class='mark-.*?<img src='(.*?)'.*?</div><div class='numerando'>(.*?)</div>.*?<a href='(.*?)'>(.*?)</a>")) {
    out.push({ thumb, season: single(se, "(.*?)-").trim(), epis: single(se, "-(.*?)$").trim(), url: epUrl, title: clean(title) });
  }
  return out;
}

function parseCards(bloque, type) {
  const out = [];
  for (const m of multi(bloque, "<article(.*?)</article>")) {
    const u = single(m, '<a href="(.*?)"');
    const title = clean(single(m, 'alt="(.*?)"'));
    if (!u || !title) continue;
    out.push({ url: u, title, thumb: single(m, '<img src="(.*?)"'), year: single(m, "</h3><span>(.*?)</span>") || "", type });
    if (out.length >= 18) break;
  }
  return out;
}
async function listPage(url, type) {
  const data = await dl(url);
  const bloque = single(data, ">Añadido recientemente<(.*?)>Géneros<") || single(data, "</h1>(.*?)>Géneros<") || data;
  return parseCards(bloque, type);
}
async function genreList(base) {
  const data = await dl(base);
  const bloque = single(data, ">Géneros<(.*?)</ul>");
  return multi(bloque, '<a href="(.*?)".*?>(.*?)</a>').map(([u, t]) => ({ url: u, title: clean(String(t)).replace(/&amp;/g, "&") })).filter((g) => g.url && g.title);
}

// Populares tab: /tendencias/ is a mixed movie+series grid; the type is in the URL path.
async function popularCatalog() {
  const data = await dl(HOST + "tendencias/");
  const movies = [], series = [];
  for (const m of multi(data, "<article(.*?)</article>")) {
    const u = single(m, '<a href="(.*?)"');
    const title = clean(single(m, 'alt="(.*?)"'));
    if (!u || !title) continue;
    const type = /\/series\//.test(u) ? "tvshow" : "movie";
    const card = { url: u, title, thumb: single(m, '<img src="(.*?)"'), year: single(m, "</h3><span>(.*?)</span>") || "", type };
    (type === "tvshow" ? series : movies).push(card);
  }
  const rows = [];
  if (movies.length) rows.push({ title: "Películas populares", titleEn: "Popular movies", items: movies.slice(0, 18) });
  if (series.length) rows.push({ title: "Series populares", titleEn: "Popular series", items: series.slice(0, 18) });
  return rows;
}

// Home rows for a tab. kind: "movie" (Películas) | "tvshow" (Series) | "popular" (Populares). Row 0 =
// recent/top (feeds the hero), then a rail per genre.
export async function catalog(kind) {
  if (kind === "popular") return popularCatalog();
  const base = kind === "tvshow" ? HOST + "series/" : HOST + "peliculas/";
  const type = kind === "tvshow" ? "tvshow" : "movie";
  const recientes = await listPage(base, type);
  const rows = [];
  if (recientes.length) rows.push({ title: kind === "tvshow" ? "Series recientes" : "Estrenos", titleEn: kind === "tvshow" ? "Recent series" : "New releases", items: recientes });
  let genres = [];
  try { genres = await genreList(base); } catch { /* ignore */ }
  const genreRows = await Promise.all(genres.slice(0, 6).map(async (g) => {
    try { const items = await listPage(g.url, type); return items.length ? { title: g.title, items } : null; } catch { return null; }
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
