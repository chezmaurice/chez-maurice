import { Hono } from "hono";
import { requireApiKey } from "../../middleware/apiKey";
import books from "./books";
import chapters from "./chapters";
import summaries from "./summaries";
import actions from "./actions";
import bookmarks from "./bookmarks";
import highlights from "./highlights";
import add from "./add";

const calibre = new Hono();

// An install without Calibre's binaries — the Linux container does not ship
// them — reads metadata.db as plain SQLite and the artifact files, and runs
// extraction and summaries in this process (services/bookProcessing.ts). The
// one route that spawns `calibredb`, `/add`, hands the file to Calibre-Web
// there instead (since 7 November 2026; it answered 503 until then).

// Read-only routes are public (site is behind Cloudflare Access)
calibre.route("/books", books);
calibre.route("/books", chapters);
calibre.route("/books", summaries);
calibre.route("/books", actions);
calibre.route("/books", bookmarks);
calibre.route("/books", highlights);
calibre.route("/add", add);

export default calibre;
