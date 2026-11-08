/**
 * Chrome and Firefox never show the microphone question over a popup, so the
 * popup sends the member here once. The answer belongs to the extension, not
 * to this tab: once allowed, dictation works from the popup from then on.
 */

import { lang } from "./strings.js";

const words = {
  en: {
    asking: "Allow the microphone",
    askingBody: "To dictate your notes, the browser needs your permission once.",
    granted: "Microphone allowed",
    grantedBody: "Close this tab and open the extension again: the note you started is still there.",
    refused: "Microphone not allowed",
    refusedBody: "Allow it in the browser's site settings for this extension, then try again.",
    again: "Try again",
  },
  fr: {
    asking: "Autoriser le micro",
    askingBody: "Pour dicter vos notes, le navigateur demande votre accord une fois.",
    granted: "Micro autorisé",
    grantedBody: "Fermez cet onglet et rouvrez l'extension : la note commencée vous attend.",
    refused: "Micro refusé",
    refusedBody: "Autorisez-le dans les réglages du navigateur pour cette extension, puis réessayez.",
    again: "Réessayer",
  },
}[lang];

const el = (id) => document.getElementById(id);
document.documentElement.classList.add(/Macintosh|iPhone|iPad/.test(navigator.userAgent) ? "apple" : "material");
el("again").textContent = words.again;
el("again").addEventListener("click", ask);
ask();

async function ask() {
  el("heading").textContent = words.asking;
  el("text").textContent = words.askingBody;
  el("again").hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    el("mark").hidden = false;
    el("heading").textContent = words.granted;
    el("text").textContent = words.grantedBody;
  } catch {
    el("heading").textContent = words.refused;
    el("text").textContent = words.refusedBody;
    el("again").hidden = false;
  }
}
