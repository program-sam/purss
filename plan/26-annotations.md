# Annotations

The owner lifted the plan/01 non-goal for annotation and asked for highlights, notes and
comments on items that also work on content read offline. This document records the build
decisions. The earlier proposal is `plan/adjacent/08-notes-pkm-sync.md`; only its first phase
(annotations in the reader, in the export, out of publications) is built here.

## Model

| Concern | Decision | Reason |
| --- | --- | --- |
| Storage | One table, `annotations` (migration 027), tenant-scoped by `account_id`, `workspace_id` and its item | Separate from workflow, reading progress, collection and basket membership, and retention |
| Kinds | `highlight` (passage, optional comment) and `note` (text about the whole item, not tied to a passage) | What was asked; colours and tags are not |
| Not reused | `items.curator_note` stays the incoming curator's note from a followed publication | It is someone else's words |
| Anchor | Text-quote selector (exact passage, up to 32 characters before and after) over the reader's text with white space and block boundaries collapsed to one space, plus a position hint | Survives edits and a new capture; the hint makes the common case exact and fast |
| Text version | `target_kind` + `target_id`: the readable-text capture or item version (feed or kept copy) the reader showed; `GET /api/items/:id` now names them (`contentRef`, `latestRef`) | The reader can show a capture, a kept copy or the current version |
| Re-anchoring | On the text shown, the client looks at the hint, then every occurrence of the passage scored by matching context, then nearness to the hint; exact words only | A guessed (fuzzy) anchor could mark the wrong passage |
| Detached | A passage not in the text shown is listed as *Not found in the text shown* with its quote; it is never deleted or moved | The person's writing is never lost |
| IDs | Chosen by the client (`ann_` + 26, same shape as other IDs); an id in use by another workspace is answered 404 and never overwritten | Offline creation |
| Writes | `PUT /api/items/:id/annotations/:annotationId` (whole annotation) and `DELETE` (with the time); both idempotent; the later `updatedAt` wins per annotation, ties keep what is stored, a client clock ahead of the server is capped at the server's time | Last write wins, as asked; the outbox can resend safely |
| Removal | Tombstone: `deleted_at` set, text, passage and target cleared, search entry and ledger record removed. An older write arriving later is ignored; a newer one restores the annotation. Tombstones are kept as long as the item (a few dozen bytes each, no text), so a late write is judged against the removal however late it arrives. An annotation id the server has no row for has never been written, so its first write is accepted whatever its time: a device whose clock is wrong (months or decades behind) can still make annotations | Deleted writing is gone from the server, a late offline edit can't silently undo a removal, and a wrong device clock never blocks new writing |
| Limits | Comment or note ≤ 10,000 characters, passage ≤ 5,000, context ≤ 64, 500 live annotations per item, request ≤ 96 kB | Bounded input |
| Storage | Each live annotation is one small "Other" record (`annotation:<id>`, with its item), re-measured on edit, admitted with the control headroom like workflow changes | Counted once, never "kept"; writing a note still works when the quota is full |
| Events | Each applied change emits `{ type: "annotations", itemId }`; other open pages refresh that item's list | Two tabs or devices stay current |

## Retention decision

Annotations are not a retention pin: they pin no version and make no copy (the passage is stored on
the annotation, so it outlives the text it marked). What can lose the person's writing is the
deletion of the item itself, and there are two kinds:

- **Rule-based deletion** — *Clean up old items* (storage) and unfollowing with *Also delete the items
  you haven't kept* — selects items by rules the person didn't check one by one. Both skip any item
  with a live annotation, re-checked at confirmation like kept and published items, and the cleanup
  preview counts them among the protected items.
- **Explicit permanent delete** of chosen items names the items that carry annotations and how many,
  needs the same explicit tick as kept items, and then deletes the annotations with the item.

Chosen over "block with a message" because a cleanup that refuses to run when one old item has a
note would make cleanup unusable, while skipping keeps the two concepts apart: the annotation only
excludes its item from rule-based selection; it changes no storage category, keeps no copy and
doesn't make the item "kept". For the same reason annotated items stay in lists and search after
their source is unfollowed (`VISIBLE_SOURCE`), so the person's notes stay findable.

## Offline

- `/api/items/:id/annotations` is on the service worker's allow-list. The offline pack saves it for
  queued items that have annotations, when their text is fetched or when `ItemDTO.annotatedAt` (when the
  server last accepted a change, removals included, in server time) differs from what it saved. An item never annotated needs no copy.
- Every change goes through an annotation-specific outbox in IndexedDB (`purss-annotations`): recorded,
  shown at once over the server's list, then sent in order. Because a write carries the whole
  annotation, a new change replaces any unsent change of the same annotation. Offline, a busy server or
  an ended session leave it waiting (*Waiting to sync*, also counted in the item panel); a refusal
  (item deleted, too many, storage full beyond the headroom) marks it failed with the reason, with
  *Try again* and *Discard this change*; a refused removal is dropped, as nothing of the person's is in
  it. It is sent at start, on reconnect, when the page is shown again and every ten seconds while something
  waits. No other change is queued.
- Entries belong to an account. In a browser, signing out deletes them, after a warning in *Settings →
  Security* when any wait; another account signing in deletes the previous account's (a browser may be
  shared). An expired session keeps them, so the same person signing back in loses nothing. In the
  apps, *Disconnect this app* deletes them after the same warning, but a lost connection (the device
  was disconnected from the PURSS) keeps them, and so does connecting with another account: they
  are sent when their account connects again, and *Settings → This device* offers to copy them as text
  or discard them. Nothing unsent is deleted without the person's say.
- The outbox works whether or not *Offline reading on this device* is on, so a note survives a
  dropped connection in an ordinary tab too; when the connection is fine an entry lives only until
  the server answers.

## Reader

Select text (mouse, touch handles, or keyboard selection with caret browsing or a screen reader) and a
bar under the selection offers **Highlight** and **Add comment** (`h` and `c` do the same). Highlights
are `<mark>` pieces drawn into the prepared article HTML; overlaps share pieces. Pressing one, or
`Enter` on its first piece (focusable, labelled with the passage), opens a dialog to change the
comment or remove it. *Your notes and highlights* in the item panel adds, edits and removes notes and
lists highlights with *Show in text*; removals have Undo. The same components serve the mobile app.

## Search, portability, assistants, sharing

- Search (lists, the search palette, filter collections with a text condition, MCP `search_items`)
  matches items whose own text or whose live annotations (passage and comment or note) match, through
  a separate `annotations_fts` table.
- The JSON export gains an optional `annotations` section (live ones only, with their text references);
  older files without it still import. Import maps text references for items it creates, drops them
  for items already here (the passage finds itself), skips an annotation equal to one already on the
  item (kind, passage, words, creation time), allocates new ids, caps the file's creation and change
  times at the moment of import (a future time would win every later edit), and counts the bytes in
  the preview.
- MCP `get_item` returns the item's annotations within `maxChars`, with `passageFromPublisher` and
  `writtenByThePerson` fields, and the server instructions say which is which. Assistants can't write
  annotations.
- Publications never include annotations (tested).

## Not built

- A change feed (`GET …/annotations/changes?cursor=`) for sync clients beyond the web app, vault or
  Markdown export, citation export, and push integrations (Zotero, Notion): the later phases of the
  proposal, each needing the owner's go-ahead.
- Colours, tags, or annotations on images, audio or video positions.
- Fuzzy re-anchoring of a passage whose words changed slightly; such highlights are listed as detached.
- Assistant tools that create or change annotations.
- Sharing annotations, or showing them on sharing pages.

## Open question

- Should signing out ask before deleting unsynced annotation changes, rather than only warning in
  *Settings → Security*? The conservative build warns and deletes, matching how offline copies leave
  a device at sign-out.
