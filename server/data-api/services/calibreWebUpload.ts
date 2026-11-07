/**
 * A book added through Calibre-Web, for an install without `calibredb`.
 *
 * The container ships no Calibre binaries (1 GB of Qt for one route), so on a
 * hosted household POST /api/v1/calibre/add hands the file to the household's
 * Calibre-Web, which writes the same library the read paths serve. It does
 * what the browser does on /calibre: reached on loopback, the member named in
 * the header it trusts from 127.0.0.1 (scripts/configure-calibre-web.ts), and
 * its CSRF token read from a page first — Flask-WTF keeps the token in the
 * session cookie, so the page's cookie goes back with the upload. No
 * X-Scheme: on plain http Flask-WTF does not insist on a Referer.
 *
 * Calibre-Web answers an upload with `{ location }`: the new book's page
 * (`…/admin/book/<id>` for a member who may edit, `…/book/<id>` otherwise),
 * or the index when it refused the file, the reason left in a flash message
 * nobody here reads. It does not refuse a duplicate the way `calibredb add`
 * does: the same file twice is two books.
 */

import { ensureCalibreWebMember, MEMBER_HEADER } from "../../scripts/configure-calibre-web";
import { getPort } from "../lib/config";

export type CalibreWebAdd = { ok: true; bookId: number | null } | { ok: false; status: number; error: string };

const BOOK_LOCATION = /\/book\/(\d+)\/?$/;

export async function addThroughCalibreWeb(
  file: File,
  member: { username: string; isAdmin: boolean },
  base = `http://127.0.0.1:${getPort("calibre-web")}`,
  provision: (m: { username: string; isAdmin: boolean }) => void = ensureCalibreWebMember,
): Promise<CalibreWebAdd> {
  const unreachable = { ok: false as const, status: 503, error: "The library is not answering; try again in a moment." };
  try {
    provision(member);
  } catch {
    return unreachable;
  }
  const who = { [MEMBER_HEADER]: member.username };

  let page: Response;
  try {
    page = await fetch(`${base}/`, { headers: who, redirect: "manual" });
  } catch {
    return unreachable;
  }
  const html = page.status === 200 ? await page.text() : "";
  const token = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  if (!token) return unreachable;
  const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const form = new FormData();
  form.append("csrf_token", token);
  form.append("btn-upload", file, file.name);
  let res: Response;
  try {
    res = await fetch(`${base}/upload`, {
      method: "POST",
      headers: { ...who, Cookie: cookie, "X-CSRFToken": token },
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return unreachable;
  }
  if (res.status === 403) return { ok: false, status: 403, error: "This member may not add books to the library." };
  if (res.status !== 200) return { ok: false, status: 502, error: `The library refused the file (${res.status}).` };

  const location = ((await res.json().catch(() => null)) as { location?: string } | null)?.location ?? "";
  const id = location.match(BOOK_LOCATION)?.[1];
  if (!id) return { ok: false, status: 422, error: "The library could not read this file as a book." };
  return { ok: true, bookId: Number(id) };
}
