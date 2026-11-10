import test from "node:test";
import assert from "node:assert/strict";
import { bootDeletion, member } from "../deletion-testing.ts";
import { signIn } from "../features-testing.ts";
import { batch, entry, makeSource } from "../testing.ts";
import { applySyncBatch } from "../services/sync.ts";
import { listItems } from "../services/items.ts";
import { createBasket } from "../services/collections.ts";
import { keepItem } from "../services/state.ts";
import { IMAGE_BYTES_PER_ITEM } from "../services/images.ts";

const PNG = (extra: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);

test("the worker brings a kept item's pictures back through the internal listener, and the owner alone reads them from product storage", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  const owner = await member(b.app, "Owner", { admin: true });
  const other = await member(b.app, "Other");
  const p = { accountId: owner.accountId, workspaceId: owner.workspaceId, isAdmin: true, sessionId: "t", csrf: "x", authAt: new Date().toISOString() };
  makeSource(b.app, p, "Webcomic", "feed/1");
  const cover = "https://pictures.example/cover.png";
  const panel = "https://pictures.example/panel.png";
  applySyncBatch(b.app, owner.engineUserId, batch([entry("feed/1", { url: null, imageUrl: cover, contentHtml: `<p>Panel</p><img src="${panel}">` })]));
  const itemId = listItems(b.app, p, { scope: "all" }).items[0]!.id;
  keepItem(b.app, p, itemId, createBasket(b.app, p, { name: "Comics", captureMode: "text" }).id);

  // The worker leases the job, fetches (here: has) a cover of nearly the whole 10 MB room and a small panel, and answers as one result.
  const leased = (await b.worker("/internal/jobs/lease", { kinds: ["capture.images"], max: 1 })).json.jobs[0];
  assert.deepEqual(leased.payload, { itemId, urls: [cover, panel], maxBytes: IMAGE_BYTES_PER_ITEM });
  const big = PNG(IMAGE_BYTES_PER_ITEM - 5000);
  const done = await b.worker(`/internal/jobs/${leased.id}/complete`, { leaseId: leased.leaseId, result: { images: [
    { url: cover, contentType: "image/png", data: big.toString("base64") }, { url: panel, contentType: "image/png", data: PNG(100).toString("base64") }] } });
  assert.equal(done.status, 200, "a 10 MB answer, about 14 MB as JSON, is within what the listener accepts");
  assert.equal(b.app.db.get<{ result: string }>("SELECT result FROM jobs WHERE id = ?", leased.id)!.result, '{"pictures":2}', "the pictures are not kept in the job's result");

  const session = signIn(b.app, owner.accountId);
  const detail = await b.api(session, "GET", `/api/items/${itemId}`);
  assert.equal(detail.status, 200);
  const stored = b.app.db.all<{ id: string; url: string }>("SELECT id, url FROM item_images WHERE item_id = ?", itemId);
  const panelId = stored.find((s) => s.url === panel)!.id;
  const coverId = stored.find((s) => s.url === cover)!.id;
  assert.match(detail.json.contentHtml, new RegExp(`src="/api/items/${itemId}/images/${panelId}"`));
  assert.equal(detail.json.keptPicture, `/api/items/${itemId}/images/${coverId}`);
  assert.equal(detail.json.imageUrl, cover, "the item's own address is left as it is, so lists and the video reader work as before");

  const res = await fetch(`${b.base}/api/items/${itemId}/images/${panelId}`, { headers: { cookie: session.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.match(res.headers.get("cache-control")!, /private/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG(100));
  const again = await fetch(`${b.base}/api/items/${itemId}/images/${panelId}`, { headers: { cookie: session.cookie, "if-none-match": res.headers.get("etag")! } });
  assert.equal(again.status, 304);

  assert.equal((await fetch(`${b.base}/api/items/${itemId}/images/${panelId}`)).status, 401, "signed out");
  const stranger = signIn(b.app, other.accountId);
  assert.equal((await fetch(`${b.base}/api/items/${itemId}/images/${panelId}`, { headers: { cookie: stranger.cookie } })).status, 404, "another account");
  // Another last character, whatever the random id ends in.
  const missing = panelId.slice(0, -1) + (panelId.endsWith("x") ? "y" : "x");
  assert.equal((await fetch(`${b.base}/api/items/${itemId}/images/${missing}`, { headers: { cookie: session.cookie } })).status, 404, "a picture that isn't there");
});
