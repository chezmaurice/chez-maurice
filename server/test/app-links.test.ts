// What a household serves so that https://<household>/join?code=… opens an app:
// both apps in each file, Maurice first (iOS opens the first match), release
// builds only, and the device read off the User-Agent for the /join page.

import { describe, expect, test } from "bun:test";
import { appleAppSiteAssociation, assetLinks, joinPlatform, JOIN_APPS } from "../src/services/appLinks";

describe("app links", () => {
  test("apple-app-site-association: both apps on /join with a code, Maurice first", () => {
    const d = appleAppSiteAssociation().applinks.details[0];
    expect(d.appIDs).toEqual(["F5B4ZC8LEU.eu.chezmaurice.maurice", "F5B4ZC8LEU.eu.chezmaurice.carnet.app"]);
    expect(d.components[0]["/"]).toBe("/join");
    expect(d.components[0]["?"]).toEqual({ code: "?*" });
  });

  test("assetlinks.json: both release packages, one signing key, no debug build", () => {
    const links = assetLinks();
    expect(links.map((l) => l.target.package_name)).toEqual(["eu.chezmaurice.maurice", "eu.chezmaurice.carnet"]);
    for (const l of links) {
      expect(l.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
      expect(l.target.sha256_cert_fingerprints).toHaveLength(1);
      expect(l.target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
    expect(JSON.stringify(links)).not.toContain(".debug");
  });

  test("the device a /join page is read on", () => {
    expect(joinPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)")).toBe("ios");
    expect(joinPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 8)")).toBe("android");
    expect(joinPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac");
    expect(joinPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("other");
    expect(joinPlatform(undefined)).toBe("other");
  });

  test("Carnet has no Mac app; both have iOS and Android", () => {
    const [maurice, carnet] = JOIN_APPS;
    expect(maurice.install.mac).toBeTruthy();
    expect(carnet.install.mac).toBeUndefined();
    for (const a of JOIN_APPS) {
      expect(a.install.ios).toBeTruthy();
      expect(a.install.android).toContain(`chezmaurice/${a.key}-android-releases`);
    }
  });
});
