# Giving an entry to someone in another household — design, iOS being built

Settled with Candide on 3 November 2026. The scene: I run into a friend; we
both have Maurice, each in our own household. I want to give them something
from my Carnet — an article, a book, a film — with, if I choose, what I wrote
about it. They invite me into their household as a guest; from then on they
are among the people I can share with, and the entry goes.

Three properties, decided:

1. **A gift, not a link.** The entry is *copied* into the friend's household,
   as a shared article already is inside one (`copyArticleTo`, 2 November
   2026: "an article is given, not lent"). Nothing ties the two households
   afterwards; no server ever talks to another.
2. **I choose every element that leaves, and I see all of it first.** The
   source, the fiche's prose, each dated note, the highlights, the card (even
   a draft), each conversation with Maurice cited on the fiche — the summary
   or the whole conversation. A preview shows exactly what will arrive.
3. **We can go on talking about it there.** The copy lands in *my* notes in
   the friend's household and is shared with them by the live in-household
   share that exists (`entry_shares`, signed notes). We both write on it,
   there. What is written there never comes back to my fiche at home — that
   would be federation, and it is out of scope.

---

## What exists

- **Carnet holds several households** (`CarnetSession.households`, a session
  token per household, `switchHousehold`). The device signed into both is the
  only thing that sees both — it is the courier.
- **Guests** (`role = 'guest'`, `guest_contacts`, `guestCanReach()` both
  ways): a guest sees only their contacts in the roster and shares only with
  them. But a guest is made **only in the console**; an invitation from the
  app (`household_invites`) always makes a standard member, and only an admin
  makes one.
- **In-household entry sharing** (`entry_shares`, `data-api/services/entryShares.ts`,
  `POST/DELETE …/entries/:c/:l/:s/participants`): one file in the owner's
  notes, signed notes `DATE — @username — text`, owner adds and removes.
- **Article copy** (`gardenArticles.ts: copyArticleTo`): captured text and
  styles, image, both summaries, `meta.shared_by`, no duplicate by canonical
  URL. This is the model for the import.
- **Conversations about an entry**: `conversation_entries (conversation_id,
  member_id, entry_ref)`, the fiche's fragment per conversation in
  `conversation_summaries`, the conversation itself in `conversations` /
  `messages` / `conversation_participants`.
- **Highlights and reading position** are per member, in SQLite, not in the
  fiche.

## What is missing

| Piece | Where | Size |
|---|---|---|
| A. A member invites a guest from the app | server + Maurice app + Carnet | ~1 day |
| B. Export of an entry, element by element | server, household A | ~½ day |
| C. Import of a ready-made entry | server, household B | ~½–1 day |
| D. The sending sheet and its preview | Carnet (iOS first) | ~1 day |
| E. A conversation copied read-only | server B + Maurice app | ~½–1 day |

About three to four days. Federation (notes flowing back to A) is not in it.

---

## A. "Invite a friend as a guest"

The friend, in household B, invites me. Today only B's admin could, and only
as a full member — which would show me everyone in B and count me as one of
its members.

- **Who may**: any member who is not a guest (admin or standard), not a child
  unless the admin allowed it — same rule as *Add a device*.
- **What it makes**: a single-use `household_invites` row with two new
  columns, `role = 'guest'` and `contact_of = <inviter id>`. Redeeming it
  creates a guest whose `guest_contacts` is the inviter alone. Guests enroll
  without a PIN (existing).
- **Where**: Settings → *Inviter un ami comme invité* in the Maurice app, and
  the same from Carnet's member menu. The same QR code / link / code screen as
  *Add a device*, worded for someone else: « Votre ami verra seulement vous
  dans ce foyer, et vous seulement pourrez partager avec lui. »
- **The admin** sees guests in the console as today, can widen their contacts
  or remove them. A guest made this way shows *invité par @friend*.
- **Members cap**: guests do not count against the household's member limit.
  
- **Maurice for a guest**: a guest can talk to Maurice in B, on B's budget,
  through the personas open to guests. Nothing new — but the inviter should
  know it; one line on the invite screen. 

Tests: an invite with `role=guest` redeemed → guest, contacts = inviter;
standard member may create one, guest may not, child may not unless allowed;
the guest's roster shows only the inviter.

## B. Export (household A)

    GET /api/garden/entries/:c/:l/:s/export
      → 200 {
          entry:   { collection, locale, slug, title, kind, author, cover?, meta… },
          source:  { kind: "article", html, styles, image? } | { kind: "book", calibre: {title, authors, isbn?, cover?} } | null,
          fiche:   { prose: string, notes: [{ id, date, author, text, quote?, page? }] },
          highlights: [{ id, text, chapter?, note? }],
          card:    { body, status: "draft"|"published", url? } | null,
          conversations: [{
            id, title, date, message_count, summary?,
            shareable: boolean,          // false when another human took part
            reason?: "others_took_part"
          }]
        }

    GET /api/conversations/:id/export
      → 200 { title, date, messages: [{ role, author?, text, data? }] }
      → 403 unless the caller is the only human participant

Read-only, the owner's own entries only (`?owner=` refused). Each note gets a
stable `id` (its position + hash) so the client can tick notes one by one.
Highlights are read from the member's own rows. Nothing is written in A,
nothing records that a share happened (A has nobody to tell).

## C. Import (household B)

    POST /api/garden/entries/import
      { entry, source?, prose?, notes?[], highlights?[], card?, conversations?[],
        share_with?: <username>, from_household: "<display name of A>" }
      → 201 { collection, locale, slug }
      → 409 { error: "exists", collection, locale, slug }   // same canonical URL / ISBN

- Writes an ordinary fiche **in the caller's notes in B**, built like
  `copyArticleTo`: source and image copied, `meta.shared_by` = the caller,
  `meta.given_from` = `from_household`, `opened: false`.
- The selected prose and notes go in as the caller's own (unsigned — they are
  the owner's in B too); highlights become quote blocks (`> passage` +
  chapter), since in B they have no book position to hang on.
- The card, when sent, is written as the entry's card **in draft**, whatever
  its status in A: publishing in B is a separate act.
- Each conversation sent whole becomes a read-only conversation (E); a
  conversation sent as summary only becomes a dated note "Conversation avec
  Maurice, <date> — <summary>".
- With `share_with`, the entry is then shared with that member through
  `shareEntry()` — the existing live share, so `guestCanReach()` applies.
- Sizes bounded (body, images) as the article capture already is.
- A second gift of the same entry (409): the client offers to add only the
  newly ticked notes to the existing copy — or, simpler for v1, says it is
  already there and opens it. *(v1: the latter.)*

## D. The sending sheet (Carnet)

The *Partager* sheet of an entry (`WhoIsHereView`) gains a section per other
household the device is signed into, listing the members the caller can reach
there (a guest: their contacts; a member: everyone). Choosing someone in
another household opens the sending sheet:

```
┌───────────────────────────────────────────┐
│  Envoyer à Paul · Foyer Martin        ✕   │
│                                           │
│  ☑ L'article                              │
│      « Le temps long des forêts »         │
│  ☐ Ma fiche                               │
│      ☐ Le texte de la fiche               │
│      ☐ 12 mars — « Relire le passage… »   │
│      ☐ 14 mars — p. 32 : « … »            │
│  ☐ Mes passages surlignés (7)             │
│  ☐ Ma carte  · brouillon                  │
│  ☐ Conversations avec Maurice             │
│      ☐ 15 mars · Forêts et climat         │
│          ○ le résumé   ○ toute la conv.   │
│      ⊘ 20 mars · Avec Aline               │
│          d'autres y ont participé         │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │          Voir ce qui part           │  │
│  └─────────────────────────────────────┘  │
└───────────────────────────────────────────┘
```

- **Everything unticked but the source.** Ticking a parent ticks its
  children; each child can be unticked.
- **Voir ce qui part** opens the preview: the entry as it will look in B —
  the two faces, the notes, the quotes, each conversation in full, the
  messages as Carnet already reads a conversation. Its button is the only
  *Envoyer*. Nothing leaves without the preview having been shown.
- A conversation another human took part in is shown but cannot be ticked.
- After sending: « Envoyé à Paul. Vous la retrouvez aussi dans le foyer
  Martin, où vous pouvez continuer d'en parler ensemble. » with *Ouvrir*.
- Errors in the language of the app: already there (opens it), Paul no longer
  reachable, B offline.

Android/desktop (`maurice-android`) follow once iOS is settled.

## E. A conversation, read-only, in household B

- `conversations` gains `imported_from TEXT` (A's display name) and
  `read_only INTEGER`. The import creates the conversation with the caller and
  the friend as participants, copies the messages (text and `data` cards; no
  tool calls, no attachments in v1), links it to the entry
  (`conversation_entries`), and stores its summary in
  `conversation_summaries` so the fiche shows it as any other.
- `POST /api/conversations/:id/messages` refuses a read-only conversation
  (409). The Maurice app shows it with a band « Conversation reçue du foyer
  Dupont — en lecture seule » and *Nouvelle conversation à partir de celle-ci*,
  which opens a new one from the entry, its fiche as context (existing).
- The settle/summary job skips read-only conversations.

---

## Privacy

- Nothing leaves without the caller ticking it and seeing it in full.
- Only conversations where the caller is the sole human can leave; another
  member's words never do.
- What Maurice cited in a conversation (mail, domains) travels with it — the
  preview is where that is caught, and the sheet says so in one line under
  the conversations: « Relisez-les : Maurice a pu y citer votre courrier ou
  vos domaines. »
- B learns only what was sent and the display name of A. A learns nothing.

## Not in this design

- Notes flowing back from B to the fiche in A (federation; a manual *Reprendre
  ses notes* could come later).
- Giving to someone in a household the device is not signed into.
- A book's file (only its catalogue record travels).

## Decided (Candide, 3 November 2026)

1. Guests do not count against the household's member limit.
2. A guest invited by a member gets Maurice in B, on B's budget, as guests
   today; the invite screen says so in one line.
3. A child member may not invite a guest unless the admin allowed it (the
   *may publish* flag's model).
4. iOS first (server, Maurice app, Carnet); Android and desktop after.
