import db from "../db";
import { freshInviteCode, normalizeInviteCode } from "./auth";
import { createUser, setGuestContacts } from "./users";
import { seedDefaultAccess } from "./modelAccess";

// ── Open invitations ─────────────────────────────────────────────
// An admin invites *someone*: no member exists until the code is redeemed, and
// the person who redeems it names themselves. Single use, seven days. The
// member-bound codes in auth.ts stay for the other case — a new device for
// someone who is already here.

export interface OpenInvite {
  code: string;
  expires_at: string;
  created_at: string;
}

export function createOpenInvite(createdBy: string, days = 7): OpenInvite {
  const code = freshInviteCode();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  db.run(`INSERT INTO household_invites (code, created_by, expires_at) VALUES (?, ?, ?)`, [
    code,
    createdBy,
    expiresAt,
  ]);
  return db
    .query(`SELECT code, expires_at, created_at FROM household_invites WHERE code = ?`)
    .get(code) as OpenInvite;
}

/** Invitations still waiting for someone: unused and unexpired, newest first.
 *  The admin's own kind — the guests members invite are listed to each of them
 *  (listGuestInvites). */
export function listOpenInvites(): OpenInvite[] {
  return db
    .query(
      `SELECT code, expires_at, created_at FROM household_invites
       WHERE used_at IS NULL AND expires_at > ? AND role = 'standard' ORDER BY created_at DESC`,
    )
    .all(new Date().toISOString()) as OpenInvite[];
}

/** Withdraw an invitation nobody has used yet. */
export function revokeOpenInvite(raw: string): boolean {
  const res = db.run(`DELETE FROM household_invites WHERE code = ? AND used_at IS NULL`, [
    normalizeInviteCode(raw),
  ]);
  return res.changes > 0;
}

// ── A guest, invited by a member ─────────────────────────────────
// specs/cross-household-share.md, section A. A friend from another household
// is let in to reach the member who invited them, and nobody else: the
// invitation is single use like the admin's, and makes a guest whose only
// contact is its maker. A guest does not count as one of the household's
// members; they talk to Maurice on the household's budget, as every guest.

/** Who may invite a guest: a member who is not one, and a child only once the
 *  admin allowed it (`users.may_invite_guests`, the `may_publish` model). */
export function mayInviteGuests(userId: string): boolean {
  const u = db.query(`SELECT role, is_child, may_invite_guests FROM users WHERE id = ?`).get(userId) as
    | { role: string; is_child: number; may_invite_guests: number }
    | null;
  if (!u || u.role === "guest") return false;
  return !u.is_child || !!u.may_invite_guests;
}

export function createGuestInvite(memberId: string, days = 7): OpenInvite {
  const code = freshInviteCode();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  db.run(
    `INSERT INTO household_invites (code, created_by, expires_at, role, contact_of) VALUES (?, ?, ?, 'guest', ?)`,
    [code, memberId, expiresAt, memberId],
  );
  return db
    .query(`SELECT code, expires_at, created_at FROM household_invites WHERE code = ?`)
    .get(code) as OpenInvite;
}

/** A member's guest invitations still waiting for someone, newest first. */
export function listGuestInvites(memberId: string): OpenInvite[] {
  return db
    .query(
      `SELECT code, expires_at, created_at FROM household_invites
       WHERE contact_of = ? AND role = 'guest' AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(memberId, new Date().toISOString()) as OpenInvite[];
}

export interface InvitedGuest {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url: string | null;
  joined_at: string;
}

/** The guests who came in by a member's invitation, and are still guests here. */
export function guestsInvitedBy(memberId: string): InvitedGuest[] {
  return db
    .query(
      `SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_url, i.used_at AS joined_at
         FROM household_invites i JOIN users u ON u.id = i.used_by
        WHERE i.contact_of = ? AND i.role = 'guest' AND u.role = 'guest'
        ORDER BY i.used_at DESC`,
    )
    .all(memberId) as InvitedGuest[];
}

/** Withdraw one of the member's own guest invitations nobody has used yet. */
export function revokeGuestInvite(memberId: string, raw: string): boolean {
  const res = db.run(
    `DELETE FROM household_invites WHERE code = ? AND contact_of = ? AND role = 'guest' AND used_at IS NULL`,
    [normalizeInviteCode(raw), memberId],
  );
  return res.changes > 0;
}

/** Where one of the member's guest invitations stands — polled by the sheet
 *  showing it, so it can close once the friend is in. Null when it is not theirs. */
export function guestInviteState(memberId: string, raw: string): "pending" | "used" | "expired" | null {
  const row = db
    .query(`SELECT expires_at, used_at FROM household_invites WHERE code = ? AND contact_of = ? AND role = 'guest'`)
    .get(normalizeInviteCode(raw), memberId) as { expires_at: string; used_at: string | null } | null;
  if (!row) return null;
  if (row.used_at) return "used";
  return row.expires_at > new Date().toISOString() ? "pending" : "expired";
}

/** The member a guest was invited by, when one was — the console says so. */
export function invitedBy(guestId: string): { id: string; username: string; display_name: string } | null {
  return db
    .query(
      `SELECT u.id, u.username, u.display_name FROM household_invites i JOIN users u ON u.id = i.contact_of
        WHERE i.used_by = ? AND i.role = 'guest' LIMIT 1`,
    )
    .get(guestId) as { id: string; username: string; display_name: string } | null;
}

/** What an open invitation will make, before anyone redeems it: the enroll
 *  route words its first answer from it. Null when it cannot be used. */
export function openInviteKind(raw: string): { role: "standard" | "guest"; invited_by: string | null } | null {
  const row = db
    .query(
      `SELECT i.role, u.display_name FROM household_invites i LEFT JOIN users u ON u.id = i.contact_of
        WHERE i.code = ? AND i.used_at IS NULL AND i.expires_at > ?`,
    )
    .get(normalizeInviteCode(raw), new Date().toISOString()) as { role: string; display_name: string | null } | null;
  if (!row) return null;
  return { role: row.role === "guest" ? "guest" : "standard", invited_by: row.display_name ?? null };
}

/** Whether a code is an open invitation that can still be used. */
export function isOpenInvite(raw: string): boolean {
  return !!db
    .query(`SELECT 1 FROM household_invites WHERE code = ? AND used_at IS NULL AND expires_at > ?`)
    .get(normalizeInviteCode(raw), new Date().toISOString());
}

/**
 * A handle for the newcomer, from the name they gave: lowercase ASCII, accents
 * folded ("Aline" → "aline", "Zoé" → "zoe"), numbered when taken. The username
 * names the member's garden directory, so it has to be plain.
 */
export function usernameFor(displayName: string): string {
  const base =
    displayName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 20) || "membre";
  const taken = (u: string) => db.query(`SELECT 1 FROM users WHERE username = ?`).get(u);
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/**
 * Redeem an open invitation: the newcomer becomes a member under the name they
 * chose. The code is claimed before the member is created, in one statement,
 * so two phones scanning the same QR code at once cannot both come in.
 */
export async function redeemOpenInvite(
  raw: string,
  profile: { display_name: string; avatar_color?: string },
): Promise<{ userId: string; role: "standard" | "guest" } | null> {
  const code = normalizeInviteCode(raw);
  const now = new Date().toISOString();
  const claimed = db.run(
    `UPDATE household_invites SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?`,
    [now, code, now],
  );
  if (claimed.changes === 0) return null;
  const invite = db.query(`SELECT role, contact_of FROM household_invites WHERE code = ?`).get(code) as
    { role: string; contact_of: string | null };
  const role = invite.role === "guest" ? "guest" : "standard";
  // A guest's invitation whose maker is gone has nobody to let them reach.
  if (role === "guest" && !invite.contact_of) {
    db.run(`UPDATE household_invites SET used_at = NULL WHERE code = ?`, [code]);
    return null;
  }
  try {
    const user = await createUser({
      username: usernameFor(profile.display_name),
      display_name: profile.display_name,
      role,
      avatar_color: profile.avatar_color,
    });
    seedDefaultAccess(user.id);
    // The one person a guest invited by a member reaches: that member.
    if (role === "guest") setGuestContacts(user.id, [invite.contact_of!]);
    db.run(`UPDATE household_invites SET used_by = ? WHERE code = ?`, [user.id, code]);
    return { userId: user.id, role };
  } catch (err) {
    // Hand the invitation back: nobody came in by it.
    db.run(`UPDATE household_invites SET used_at = NULL WHERE code = ?`, [code]);
    throw err;
  }
}
