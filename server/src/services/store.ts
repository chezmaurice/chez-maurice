// The household's store: where its admin buys the subscription and top-ups
// from inside the Apple apps. A household made by a hosting service (the
// tower) carries two lines in its env file — the account the purchases are
// credited to, and the service's base URL — and the apps ask the service
// itself for everything else (prices come from StoreKit, never from here).
// A household with neither line, like one run at home, has no store at all.

export interface StoreConfig {
  /** The account's token, a UUID the apps hand StoreKit as appAccountToken. */
  account: string;
  /** The hosting service's base URL, without a trailing slash. */
  url: string;
}

export function storeConfig(): StoreConfig | null {
  const account = process.env.MAURICE_STORE_ACCOUNT?.trim();
  const url = process.env.MAURICE_STORE_URL?.trim().replace(/\/+$/, "");
  if (!account || !url) return null;
  return { account, url };
}
