import { describe, expect, test } from "bun:test";
import {
  MAX_PAGE_CHARS, formatWebPage, normalizePageUrl, pageFromHtml, readWebPage, webPageCard,
} from "../src/services/webPage";

const para = (n: number, word: string) => Array.from({ length: n }, () => word).join(" ");

describe("read_web_page", () => {
  test("a bare domain is read as https", () => {
    expect(normalizePageUrl(" chezmaurice.eu/tarifs ")).toBe("https://chezmaurice.eu/tarifs");
    expect(normalizePageUrl("http://example.org")).toBe("http://example.org");
    expect(() => normalizePageUrl("")).toThrow();
  });

  test("the household's own network is out of reach", async () => {
    await expect(readWebPage("http://localhost:3001/")).rejects.toThrow(/non-public/);
    await expect(readWebPage("http://192.168.1.10/")).rejects.toThrow(/non-public/);
    await expect(readWebPage("file:///etc/passwd")).rejects.toThrow(/http/);
  });

  test("a landing page is read whole, not cut down to one section", () => {
    const html = `<html><head><title>Maison</title></head><body>
      <section><h1>Une maison</h1><p>${para(30, "accueil")}</p></section>
      <section><h2>Les prix</h2><p>${para(30, "tarif")}</p></section>
      <section><h2>Les questions</h2><p>${para(30, "question")}</p></section>
      <footer>Mentions légales</footer></body></html>`;
    const page = pageFromHtml("https://example.org/", html);
    expect(page.text).toContain("tarif");
    expect(page.text).toContain("question");
    expect(page.text).toContain("## Les prix");
    expect(page.thin).toBe(false);
  });

  test("an article keeps its body without the page around it", () => {
    const html = `<html><head><title>Un article</title></head><body>
      <nav><a href="/">Accueil</a> <a href="/a">Rubrique</a></nav>
      <article><h1>Un article</h1>${Array.from({ length: 8 }, () => `<p>${para(60, "texte")}.</p>`).join("")}</article>
      <footer>Pied de page</footer></body></html>`;
    const page = pageFromHtml("https://example.org/article", html);
    expect(page.text).toContain("texte");
    expect(page.text).not.toContain("Pied de page");
  });

  test("an empty page says so instead of letting the title stand in", () => {
    const page = pageFromHtml("https://app.example.org/", `<html><head><title>App</title></head><body><div id="root"></div><script>boot()</script></body></html>`);
    expect(page.thin).toBe(true);
    expect(formatWebPage(page)).toContain("could not read its content");
  });

  test("a long page is cut, and the cut is said", () => {
    const html = `<html><body>${Array.from({ length: 400 }, () => `<p>${para(20, "longueur")}</p>`).join("")}</body></html>`;
    const page = pageFromHtml("https://example.org/long", html);
    expect(page.cut).toBe(true);
    expect(page.text.length).toBe(MAX_PAGE_CHARS);
    expect(formatWebPage(page)).toContain("[Cut at");
  });

  test("the card is the page, as one web source", () => {
    const page = pageFromHtml("https://www.example.org/x", `<html><head><title>Titre</title><meta property="og:description" content="Résumé"></head><body><p>${para(50, "mot")}</p></body></html>`);
    expect(webPageCard(page)).toEqual({
      card: "sources", origin: "web", count: 1,
      results: [{ title: "Titre", kind: "web", url: "https://www.example.org/x", subtitle: "example.org", snippet: "Résumé" }],
    });
  });
});
