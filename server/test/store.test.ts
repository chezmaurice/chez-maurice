/**
 * The household's store (GET /api/me/store, services/store.ts): the two env
 * lines a hosting service writes, shown to the admin alone. With either line
 * missing, or to a member, there is no store — and no top-up in the budget.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { MEMBER } from "./_member";

const { default: db } = await import("../src/db");
const { createSession } = await import("../src/services/auth");
const { householdBudget } = await import("../src/services/budget");
const me = (await import("../src/routes/me")).default;

const STANDARD = "store-standard";
db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, 'storestd', 'Std', 'standard')`, [STANDARD]);

const ENV = ["MAURICE_STORE_ACCOUNT", "MAURICE_STORE_URL"] as const;
const saved: Record<string, string | undefined> = {};
const ACCOUNT = "3f6c1a52-7d0e-4b8a-9c41-2e5f6a7b8c9d";

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

function store(userId: string) {
  return me.request("/store", { headers: { Authorization: `Bearer ${createSession(userId).token}` } });
}

test("a household with no store answers 404 no_store, even to its admin", async () => {
  const res = await store(MEMBER.id);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "no_store" });
  expect(householdBudget(true).can_top_up).toBe(false);
});

test("one line alone is no store", async () => {
  process.env.MAURICE_STORE_ACCOUNT = ACCOUNT;
  expect((await store(MEMBER.id)).status).toBe(404);
  delete process.env.MAURICE_STORE_ACCOUNT;
  process.env.MAURICE_STORE_URL = "https://account.example.org";
  expect((await store(MEMBER.id)).status).toBe(404);
});

test("lines written empty, as a tower without its Apple key writes them, are no store", async () => {
  process.env.MAURICE_STORE_ACCOUNT = "";
  process.env.MAURICE_STORE_URL = "";
  expect((await store(MEMBER.id)).status).toBe(404);
  process.env.MAURICE_STORE_URL = "https://account.example.org";
  expect((await store(MEMBER.id)).status).toBe(404);
  process.env.MAURICE_STORE_ACCOUNT = "  ";
  expect((await store(MEMBER.id)).status).toBe(404);
  expect(householdBudget(true).can_top_up).toBe(false);
});

test("the admin is given the account and the service's URL", async () => {
  process.env.MAURICE_STORE_ACCOUNT = ` ${ACCOUNT} `;
  process.env.MAURICE_STORE_URL = "https://account.example.org/";
  const res = await store(MEMBER.id);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ account: ACCOUNT, url: "https://account.example.org" });
  expect(householdBudget(true).can_top_up).toBe(true);
});

test("a member never sees the store, nor a top-up", async () => {
  process.env.MAURICE_STORE_ACCOUNT = ACCOUNT;
  process.env.MAURICE_STORE_URL = "https://account.example.org";
  const res = await store(STANDARD);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "no_store" });
  expect(householdBudget(false).can_top_up).toBe(false);
});
