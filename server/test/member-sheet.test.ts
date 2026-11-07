/**
 * The app's member sheet (PATCH /api/users/:id): an admin renames a member,
 * changes their colour, and may delete them — but never sets their PIN from
 * afar, which would let them sign in as that member untold. A forgotten PIN
 * goes through a device code, which the member is told about.
 */
import { beforeEach, expect, test } from "bun:test";
import { MEMBER } from "./_member";

const { default: db } = await import("../src/db");
const { createSession } = await import("../src/services/auth");
const users = (await import("../src/routes/users")).default;

const LEA = "sheet-lea";
const adminToken = createSession(MEMBER.id).token;

beforeEach(() => {
  db.run(`DELETE FROM users WHERE id = ?`, [LEA]);
  db.run(`INSERT INTO users (id, username, display_name, role, avatar_color, pin_hash) VALUES (?, 'sheetlea', 'Léa', 'standard', '#a6452e', 'h')`, [LEA]);
});

const patch = (body: unknown, token = adminToken) =>
  users.request(`/${LEA}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const row = () => db.query(`SELECT display_name, avatar_color, pin_hash FROM users WHERE id = ?`).get(LEA) as any;

test("an admin renames a member and changes their colour", async () => {
  const r = await patch({ display_name: "  Léa M.  ", avatar_color: "#2c5aa0" });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ display_name: "Léa M.", avatar_color: "#2c5aa0", has_pin: true });
  expect(row()).toMatchObject({ display_name: "Léa M.", avatar_color: "#2c5aa0" });
});

test("a PIN is never set from afar, nor cleared", async () => {
  for (const body of [{ pin: "482916" }, { pin: null }, { display_name: "X", pin: "482916" }]) {
    expect((await patch(body)).status).toBe(403);
  }
  expect(row()).toEqual({ display_name: "Léa", avatar_color: "#a6452e", pin_hash: "h" });
});

test("a blank name or a colour that is not one is refused", async () => {
  for (const body of [{ display_name: "" }, { display_name: "   " }, { display_name: 3 }, { avatar_color: "blue" }, { avatar_color: "#12345" }]) {
    expect((await patch(body)).status).toBe(400);
  }
  expect(row().display_name).toBe("Léa");
});

test("a member who is not an admin cannot change another", async () => {
  expect((await patch({ display_name: "Moi" }, createSession(LEA).token)).status).toBe(403);
  expect(row().display_name).toBe("Léa");
});
