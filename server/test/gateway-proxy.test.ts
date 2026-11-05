import { describe, expect, test } from "bun:test";
import { carriesStaticKey, gatewayHeaders } from "../src/services/gatewayProxy";

// The public /mcp proxy: a client can neither name the member a tool call is
// for nor use the server's own gateway key.

describe("gateway proxy", () => {
  test("a member id the client sent is dropped", () => {
    const inbound = new Headers({ "X-Maurice-Member-Id": "alice", Authorization: "Bearer oauth-token" });
    const out = gatewayHeaders(inbound, undefined);
    expect(out.get("x-maurice-member-id")).toBeNull();
    expect(out.get("authorization")).toBe("Bearer oauth-token");
  });

  test("the member the server resolved replaces the client's", () => {
    const inbound = new Headers({ "x-maurice-member-id": "alice" });
    expect(gatewayHeaders(inbound, "bob").get("x-maurice-member-id")).toBe("bob");
  });

  test("the static key is recognised, with or without Bearer", () => {
    expect(carriesStaticKey("Bearer s3cret-key", "s3cret-key")).toBe(true);
    expect(carriesStaticKey("s3cret-key", "s3cret-key")).toBe(true);
    expect(carriesStaticKey("Bearer maur_abc", "s3cret-key")).toBe(false);
    expect(carriesStaticKey("Bearer s3cret-ke", "s3cret-key")).toBe(false);
    expect(carriesStaticKey(undefined, "s3cret-key")).toBe(false);
    expect(carriesStaticKey("Bearer ", "")).toBe(false);
  });
});
