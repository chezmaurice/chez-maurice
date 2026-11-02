// The two apps an invitation can open — Maurice and Carnet — and what a
// household serves so that tapping https://<household>/join?code=… opens one
// of them instead of the browser.
//
// Both apps accept the same link: an invitation names a household, never an
// app (Candide, 2 November 2026). Where both are installed, iOS opens the
// first app ID listed below, and Android asks.
//
// The apps declare *.chezmaurice.eu. For a wildcard, Android verifies the
// files on chezmaurice.eu itself (served by the site); every household serves
// them too, which costs nothing and is where iOS looks for its own domain. A
// self-hosted household on any other name is not declared in the apps: there
// the link opens this page, whose "Open" buttons use the apps' own schemes.

const APPLE_TEAM = "F5B4ZC8LEU";

/** The release key both Android apps are signed with (debug builds are not). */
const ANDROID_CERT =
  "08:B9:A2:58:83:9E:E5:16:96:79:F9:0A:C7:4F:01:81:46:B2:86:A5:BB:7C:70:46:57:6A:55:83:52:91:B7:4A";

export type Platform = "ios" | "android" | "mac" | "other";

export interface JoinApp {
  key: "maurice" | "carnet";
  name: string;
  /** maurice://join?… or carnet://join?… — the "Open" button, for every case. */
  scheme: string;
  iosBundle: string;
  androidPackage: string;
  /** Where each platform installs it; absent where the app does not exist. */
  install: Partial<Record<"ios" | "mac" | "android", string>>;
  /** A second Android link: the latest release page, for a plain APK. */
  androidReleases: string;
}

const obtainium = (repo: string) =>
  `https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/chezmaurice/${repo}`;

export const JOIN_APPS: JoinApp[] = [
  {
    key: "maurice",
    name: "Maurice",
    scheme: "maurice",
    iosBundle: "eu.chezmaurice.maurice",
    androidPackage: "eu.chezmaurice.maurice",
    install: {
      ios: process.env.MAURICE_INSTALL_URL || "https://testflight.apple.com/join/CS3ufwEd",
      mac: process.env.MAURICE_INSTALL_URL || "https://testflight.apple.com/join/CS3ufwEd",
      android: process.env.MAURICE_INSTALL_ANDROID_URL || obtainium("maurice-android-releases"),
    },
    androidReleases: "https://github.com/chezmaurice/maurice-android-releases/releases/latest",
  },
  {
    key: "carnet",
    name: "Carnet",
    scheme: "carnet",
    iosBundle: "eu.chezmaurice.carnet.app",
    androidPackage: "eu.chezmaurice.carnet",
    install: {
      ios: process.env.CARNET_INSTALL_URL || "https://testflight.apple.com/join/utR99CxB",
      android: process.env.CARNET_INSTALL_ANDROID_URL || obtainium("carnet-android-releases"),
    },
    androidReleases: "https://github.com/chezmaurice/carnet-android-releases/releases/latest",
  },
];

/** The device a /join page is read on, from its User-Agent. Safari on an
 *  iPad reports a Mac, so the page treats "mac" as "Mac or iPad": it offers
 *  Carnet there too, saying it is for iPhone and iPad. */
export function joinPlatform(userAgent: string | undefined): Platform {
  const ua = userAgent ?? "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "other";
}

/** /.well-known/apple-app-site-association */
export function appleAppSiteAssociation() {
  return {
    applinks: {
      details: [
        {
          appIDs: JOIN_APPS.map((a) => `${APPLE_TEAM}.${a.iosBundle}`),
          components: [{ "/": "/join", "?": { code: "?*" }, comment: "an invitation" }],
        },
      ],
    },
  };
}

/** /.well-known/assetlinks.json */
export function assetLinks() {
  return JOIN_APPS.map((a) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: a.androidPackage,
      sha256_cert_fingerprints: [ANDROID_CERT],
    },
  }));
}
