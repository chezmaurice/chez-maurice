// What the public /mcp proxy hands the tool gateway.
//
// The gateway trusts two things the server is meant to own: its static key
// (MAURICE_MCP_TOKEN, the server's own credential for loopback calls, which
// carries no member) and the X-Maurice-Member-Id header (who the call is for).
// From the internet, neither may come from the client: the static key is
// refused outright, and the member header is whatever the server resolved —
// a maur_ token's owner — or absent, in which case the gateway's own OAuth
// token names the member.

import { timingSafeEqual } from "node:crypto";

/** True when the request carries the gateway's static key. */
export function carriesStaticKey(authorization: string | undefined, staticKey: string): boolean {
  if (!staticKey || !authorization) return false;
  const given = Buffer.from(authorization.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(staticKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The client's headers with the member header replaced by the server's. */
export function gatewayHeaders(inbound: Headers, memberId: string | undefined): Headers {
  const headers = new Headers(inbound);
  headers.delete("X-Maurice-Member-Id");
  if (memberId) headers.set("X-Maurice-Member-Id", memberId);
  return headers;
}
