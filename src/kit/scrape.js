// channel-kit: shared scraping helpers for every per-site content plugin.
// (Not a plugin itself — site plugins import these and esbuild bundles them in.)

// scrapertools: faithful Python re.findall shape + inline-flag/DOTALL translation.
function pyPattern(patron) {
  let p = String(patron);
  let flags = "gs";
  p = p.replace(/\(\?([aiLmsux]+)\)/g, (_, f) => { if (f.includes("i") && !flags.includes("i")) flags += "i"; if (f.includes("m") && !flags.includes("m")) flags += "m"; return ""; });
  p = p.replace(/\(\?P<([^>]+)>/g, "(?<$1>").replace(/\(\?P=([^)]+)\)/g, "\\k<$1>");
  return new RegExp(p, flags);
}
function findall(patron, text) {
  const re = pyPattern(patron); const out = [];
  for (const m of String(text).matchAll(re)) { if (m.length === 1) out.push(m[0]); else if (m.length === 2) out.push(m[1] ?? ""); else out.push(m.slice(1).map((g) => g ?? "")); }
  return out;
}
export const single = (d, p, i = 0) => { try { const v = findall(p, d)[i]; return v === undefined ? "" : v; } catch { return ""; } };
export const multi = (d, p) => { try { return findall(p, d); } catch { return []; } };

const NAMED_ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", iexcl: "¡", iquest: "¿", laquo: "«", raquo: "»", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", uuml: "ü" };
const codePoint = (c, m) => (c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m);

/**
 * A title as the page shows it: HTML entities decoded, not deleted. WordPress writes "Rammstein &#8211; Live in Mexico City"
 * and "Fast &#038; Furious"; the old version dropped those codes ("Rammstein  Live", "Fast  Furious").
 */
export const clean = (t) => String(t)
  .replace(/&#([0-9]{1,7});/g, (m, n) => codePoint(Number(n), m))
  .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => codePoint(parseInt(h, 16), m))
  .replace(/&([a-z]+);/gi, (m, k) => NAMED_ENTITIES[k] ?? m)
  .replace(/\s+/g, " ")
  .trim();

// GET/POST through kino.fetch; `post` is a form object; returns the body text.
export async function dl(url, post = null, headers = null) {
  const r = await kino.fetch(url, { method: post ? "POST" : "GET", body: post ? { form: post } : undefined, headers: headers || undefined });
  return typeof r.text === "function" ? await r.text() : "";
}
