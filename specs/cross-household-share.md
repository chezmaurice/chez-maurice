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

---

## As built — server (3 November 2026)

Sections A, B, C and E on the server. Where it differs from the text above,
this section is what the server does.

### Routes

The garden routes live under the real prefix `/api/v1/garden`, not `/api/garden`.

**A. Guests invited by a member** (`src/routes/me.ts`, `src/services/invites.ts`)

    POST   /api/me/guest-invite          → 201 { code, link, expires_at, created_at }
                                         → 403 { error: "not_allowed" }  (guest, child not allowed)
                                         → 403 { error: "not with an API token" }
    GET    /api/me/guest-invites         → { allowed, invites: [{ code, link, expires_at, created_at }],
                                             guests: [{ id, username, display_name, avatar_color, avatar_url, joined_at }] }
    GET    /api/me/guest-invites/:code   → { state: "pending" | "used" | "expired" }  (404: not the caller's)
    DELETE /api/me/guest-invites/:code   → { ok: true }                    (404: not the caller's, or used)

`link` is `<household>/join?code=<code>`. Single use, seven days. Redeemed by
`POST /api/auth/enroll` like any open invitation; its first answer (no name)
now also says `role: "guest"` and `invited_by: "<inviter's display name>"`;
the second answers `role: "guest", needs_pin: false`. The guest's
`guest_contacts` is the inviter alone; the admin's `GET /api/users/invites`
does not list member-made guest invitations.

**B. Export**

    GET /api/v1/garden/entries/:c/:l/:s/export
      → 200 {
          entry:  { collection, locale, slug, title, kind, author, cover?, date, tags, rating, meta },
          source: { kind: "article", url, canonical_url, text, styles: [{ start, end, kind }], image? }
                | { kind: "book", calibre: { title, authors, isbn?, cover? } } | null,
          fiche:  { prose, notes: [{ id, date, author, text, quote?, page?, chapter? }] },
          highlights: [{ id, date, text, chapter?, note? }],
          card:   { body, status, url? } | null,
          conversations: [{ id, title, date, message_count, summary?, shareable, reason? }]
        }
      → 403 with ?owner=<someone else>; 404 not the caller's entry

    GET /api/conversations/:id/export
      → 200 { title, date, messages: [{ role, author?, text, data?, at }] }
      → 403 { error: "others_took_part" }; 404 not a participant

Differences: an article's text is stored as plain text plus styles, so it
travels as `text` + `styles` (the ranges `GET …/articles/:slug/text` already
gives), not `html`. Pictures (`cover`, `image`, a book's `cover`) travel as
`data:image/…;base64,` URIs — B cannot reach A's files — or as a web address
when that is what A holds. `meta` drops what is A's reading or A's household
(`opened`, `read_at`, `progress`, `shared_by`, `given_from`, `calibre_id`,
`image`, …). Notes another member signed on a shared entry are left out
entirely. Messages carry `at`; pictures attached to messages are stripped.

**C. Import**

    POST /api/v1/garden/entries/import
      { entry, source?, prose?, notes?[], highlights?[], card?,
        conversations?: [{ id?, mode: "whole" | "summary", title?, date?, summary?, messages? }],
        share_with?: <username or member id>, from_household }
      → 201 { collection, locale, slug }
      → 409 { error: "exists", collection, locale, slug }
      → 403 { error: "not_reachable" }   (share_with a member the caller cannot reach)
      → 404 { error: "Unknown member" }; 400 bad input; 413 too large

`entry`, `source`, notes and highlights are taken as the export gives them.
Differences:
- *Already there* means: an article with the same canonical URL; a book with
  the same ISBN, else the same title; any other work with the same title.
- `meta.opened: false` only when nothing of the caller's came with it: an
  unopened fiche shows nothing written in it.
- **With `share_with`, the entry is shared live, whatever its kind — an
  article too** (property 3 wins, Candide, 3 November 2026): no copy is given
  to the friend. The household's own rule — an article shared is given as a
  copy, `copyArticleTo` — stays for ordinary in-household shares only. The
  shelf tells the two apart by the fiche's `meta.given_from`: a shared article
  carrying it is listed to the friend as the owner's (`@<owner>/articles/…`,
  `source.captured` true), and its page shows the notes; the friend adds signed
  notes to it as to any shared entry (`POST …/notes?owner=`), and reads its text
  with `GET /api/v1/garden/articles/:slug/text?locale=…&owner=<username>`
  (only for an article given from another household and shared with them).

**E. Read-only conversations**

- `conversations.imported_from` and `conversations.read_only` (0/1). Both are
  on `GET /api/conversations` rows and `GET /api/conversations/:id`
  (`read_only` a boolean).
- The import sets `entry_ref` (held from the new entry) as well as a
  `conversation_entries` row. Its summary is written as the fiche's fragment
  for that conversation, keyed on the transcript as it now stands — that is
  what shows on the fiche; `conversation_summaries` is the composer's own
  cache and is not written.
- `POST /api/conversations/:id/messages` → 409 `{ error: "read_only" }`.
- The settle sweep skips read-only conversations.
- `GET /api/conversations/:id` gives `entry` to the friend too, with Carnet's
  id for a shared entry (`ref: "@<owner>/<c>/<l>/<s>"`, `web_path: null`).
  `POST /api/conversations { entry: "@<owner>/…" }` accepts an entry shared
  with the caller; the composer reads that fiche in the owner's notes.

### Schema

- `household_invites.role TEXT NOT NULL DEFAULT 'standard'`,
  `household_invites.contact_of TEXT REFERENCES users(id) ON DELETE CASCADE`.
- `users.may_invite_guests INTEGER NOT NULL DEFAULT 0` — a separate flag
  mirroring `may_publish` (console: member page, beside *may publish*). The
  console also shows *invité par @x* on a guest made this way.
- `conversations.imported_from TEXT`, `conversations.read_only INTEGER NOT NULL DEFAULT 0`.

### Members cap

Nothing in this repository enforces a member limit. The only count is the
tower's (`chezmaurice-tower/stats.ts`, `SELECT count(*) FROM users`), which
includes guests: to change there (`WHERE role != 'guest'`).
