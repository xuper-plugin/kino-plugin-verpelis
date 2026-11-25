// VerPelis: a content-source plugin built from the channel-kit (src/kit): the generic glue (search, episodes, resolve
// through kino-resolver) lives there, this plugin brings its site scraper (site.js); the screen is the standard xuper-plugin
// screen (src/std).
import { channel } from "./kit/content.js";
import * as site from "./site.js";
import { makeStandardScreen } from "./std/index.js";
import { LOGO, LOGO_ASPECT } from "./logo.js";

const ch = channel(site);
export const search = ch.search;
export const resolve = ch.resolve;
export const home = ch.home;
export const browse = ch.browse;

// VerPelis plays nothing on its own: every hoster goes through kino-resolver (resolve() refuses while it is missing), so
// the screen is the install gate until it is installed.
let std = null;
const standard = () => (std ??= makeStandardScreen({ snapshot: "xuper-plugin/kino-plugin-verpelis",
  kino: globalThis.kino, name: "VerPelis", logo: LOGO, logoAspect: LOGO_ASPECT, needsResolver: true, hasSettings: false,
  tabs: [
    { id: "movie", label: "Películas", labelEn: "Movies" },
    { id: "popular", label: "Populares", labelEn: "Popular" },
  ],
  loadTab: async (kind) => ({ rows: await ch.catalogRows(kind) }),
}));

export async function screen(ctx) {
  await null;
  return standard().screen(ctx && typeof ctx === "object" ? ctx : {});
}

export async function screenEvent(ev) {
  await null;
  return standard().screenEvent(ev && typeof ev === "object" ? ev : {});
}

// std 1.7.0: the catalog door -- the author's other plugins (Da-Video) find titles here through Kino, and Kino opens and
// plays what they find in this plugin, with its own resolve.
import { catalogDoor } from "./std/catalog.js";
export const proto_catalog_search = catalogDoor(search);
