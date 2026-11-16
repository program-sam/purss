import test from "node:test";
import assert from "node:assert/strict";
import type { StateChange } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { HttpError } from "../http.ts";
import { applySyncBatch } from "./sync.ts";
import { getItem } from "./items.ts";
import { applyUndo, bulk, changeState, setWorkflowByFilter } from "./state.ts";

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Slow Radio", "feed/1", { kind: "podcast" });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { title: "Episode one" })]));
  const id = app.db.get<{ id: string }>("SELECT id FROM items")!.id;
  return { app, p, id, cleanup };
}

/** The player's own change, as the web app sends it. */
const auto = (workflow: "inprogress" | "finished", session: string, expected: number, started: number, expectedRevision = 0): StateChange =>
  ({ workflow, expectedRevision, expectedWorkflowRevision: expected, playbackSessionId: session, playbackStartedWorkflowRevision: started });
const session = (app: ReturnType<typeof setup>["app"], id: string) =>
  app.db.get<{ playback_workflow_session: string | null }>("SELECT playback_workflow_session FROM item_state WHERE item_id = ?", id)!.playback_workflow_session;
const refused = (err: unknown) => err instanceof HttpError && err.status === 409;

test("the player moves an item In progress and then Finished, whatever happens to its reading progress meanwhile", (t) => {
  const { app, p, id, cleanup } = setup();
  t.after(cleanup);
  const before = getItem(app, p, id);
  assert.equal(before.workflowRevision, 0);
  assert.equal(before.playbackWorkflowSessionId, null);

  const progress = changeState(app, p, id, { progress: 0.5, expectedRevision: before.revision });
  assert.equal(progress.item.revision, before.revision + 1);
  assert.equal(progress.item.workflowRevision, 0, "reading progress does not move the workflow revision");

  // The player knows only the item's revision from when it opened it, which progress has since moved.
  const started = changeState(app, p, id, auto("inprogress", "play-1", 0, 0, before.revision));
  assert.equal(started.item.workflow, "inprogress");
  assert.equal(started.item.workflowRevision, 1);
  assert.equal(started.item.playbackWorkflowSessionId, "play-1");
  assert.equal(started.item.fresh, false, "it has been seen, as for any change");
  assert.equal(started.item.progress, 0.5, "progress is untouched");

  const moreProgress = changeState(app, p, id, { progress: 0.8, expectedRevision: started.item.revision });
  assert.equal(moreProgress.item.workflowRevision, 1);
  const finished = changeState(app, p, id, auto("finished", "play-1", 1, 0));
  assert.equal(finished.item.workflow, "finished");
  assert.equal(finished.item.workflowRevision, 2);
  assert.equal(finished.item.progress, 0.8);

  const log = app.db.all<{ from_state: string; to_state: string }>("SELECT from_state, to_state FROM state_log WHERE item_id = ? ORDER BY rowid", id);
  assert.deepEqual(log.map((r) => `${r.from_state}>${r.to_state}`), ["new>inprogress", "inprogress>finished"], "logged like any workflow change");

  applyUndo(app, p, finished.undoToken);
  assert.equal(getItem(app, p, id).workflow, "inprogress", "an automatic change has the same Undo token as any other");
  assert.equal(session(app, id), null, "and Undo is a change by hand: it ends the session");
});

test("an item can be finished directly from New or To read, and is moved once", (t) => {
  const { app, p, id, cleanup } = setup();
  t.after(cleanup);
  const done = changeState(app, p, id, auto("finished", "play-1", 0, 0));
  assert.equal(done.item.workflow, "finished");
  assert.throws(() => changeState(app, p, id, auto("finished", "play-1", 1, 0)), refused, "nothing more to do once it is Finished");
  assert.throws(() => changeState(app, p, id, auto("inprogress", "play-1", 1, 0)), refused);
});

test("a state set by hand after playback started is never overridden, even by the same state or another device", (t) => {
  const { app, p, id, cleanup } = setup();
  t.after(cleanup);
  const before = getItem(app, p, id);
  const started = changeState(app, p, id, auto("inprogress", "play-2", 0, 0));

  // The person sets To read, and then In progress by hand: the same state the player made, but theirs.
  const movedBack = changeState(app, p, id, { workflow: "toread", expectedRevision: started.item.revision });
  assert.equal(session(app, id), null);
  assert.throws(() => changeState(app, p, id, auto("finished", "play-2", movedBack.item.workflowRevision, 0)), refused, "the session cannot move it after a hand-set state");
  const byHand = changeState(app, p, id, { workflow: "inprogress", expectedRevision: movedBack.item.revision });
  assert.equal(byHand.item.workflowRevision, before.workflowRevision + 3);
  assert.equal(session(app, id), null);
  assert.throws(() => changeState(app, p, id, auto("finished", "play-2", byHand.item.workflowRevision, 0)), refused);
  assert.throws(() => changeState(app, p, id, auto("finished", "play-2", 1, 0)), refused, "an old view of the item, either");
  assert.equal(getItem(app, p, id).workflow, "inprogress");
});

test("a state set by hand before the player's first change stops it, whichever state it was", (t) => {
  const { app, p, id, cleanup } = setup();
  t.after(cleanup);
  // Playback started with the item New (workflow revision 0); the person marks it To read on another device before 30 seconds passed.
  const toread = changeState(app, p, id, { workflow: "toread", expectedRevision: 0 });
  assert.throws(() => changeState(app, p, id, auto("inprogress", "play-3", 0, 0)), refused, "it was made against a state that has since moved");
  assert.throws(() => changeState(app, p, id, auto("inprogress", "play-3", toread.item.workflowRevision, 0)), refused, "and not against the newer one either: playback began before it");
  assert.equal(getItem(app, p, id).workflow, "toread");
});

test("an item that was already In progress when playback began can be finished by it, but only from the state it began with", (t) => {
  const { app, p, id, cleanup } = setup();
  t.after(cleanup);
  const inprogress = changeState(app, p, id, { workflow: "inprogress", expectedRevision: 0 });
  const rev = inprogress.item.workflowRevision;
  assert.throws(() => changeState(app, p, id, auto("inprogress", "play-4", rev, rev)), refused, "In progress is not made again");
  const away = changeState(app, p, id, { workflow: "toread", expectedRevision: inprogress.item.revision });
  const back = changeState(app, p, id, { workflow: "inprogress", expectedRevision: away.item.revision });
  assert.throws(() => changeState(app, p, id, auto("finished", "play-4", back.item.workflowRevision, rev)), refused, "it moved and came back since playback began");
  const finished = changeState(app, p, id, auto("finished", "play-5", back.item.workflowRevision, back.item.workflowRevision));
  assert.equal(finished.item.workflow, "finished");
});

test("Ignored and Finished items are never moved by playback", (t) => {
  const { app, p, id, cleanup } = setup();
  t.after(cleanup);
  const ignored = changeState(app, p, id, { workflow: "ignored", expectedRevision: 0 });
  assert.throws(() => changeState(app, p, id, auto("inprogress", "play-6", ignored.item.workflowRevision, ignored.item.workflowRevision)), refused);
  assert.throws(() => changeState(app, p, id, auto("finished", "play-6", ignored.item.workflowRevision, ignored.item.workflowRevision)), refused);
  const finished = changeState(app, p, id, { workflow: "finished", expectedRevision: ignored.item.revision });
  assert.throws(() => changeState(app, p, id, auto("inprogress", "play-7", finished.item.workflowRevision, finished.item.workflowRevision)), refused);
  assert.equal(getItem(app, p, id).workflow, "finished");
});

test("every other way of changing the workflow moves the workflow revision and ends the session", (t) => {
  const { app, p, id, cleanup } = setup();
  t.after(cleanup);
  const start = () => changeState(app, p, id, auto("inprogress", "play-8", getItem(app, p, id).workflowRevision, getItem(app, p, id).workflowRevision)).item;

  const first = start();
  assert.equal(session(app, id), "play-8");
  bulk(app, p, [id], { type: "workflow", workflow: "toread" });
  const afterBulk = getItem(app, p, id);
  assert.equal(afterBulk.workflowRevision, first.workflowRevision + 1);
  assert.equal(afterBulk.playbackWorkflowSessionId, null);

  const second = start();
  app.db.tx(() => setWorkflowByFilter(app, p, id, "inprogress", "ignored"));
  const afterFilter = getItem(app, p, id);
  assert.equal(afterFilter.workflowRevision, second.workflowRevision + 1);
  assert.equal(afterFilter.playbackWorkflowSessionId, null);
  assert.equal(afterFilter.workflow, "ignored");
});

test("choosing the state an item already has moves nothing", (t) => {
  const { app, p, id, cleanup } = setup();
  t.after(cleanup);
  const before = getItem(app, p, id);
  const same = changeState(app, p, id, { workflow: "new", expectedRevision: before.revision });
  assert.equal(same.item.workflowRevision, before.workflowRevision);
  assert.equal(same.item.stateVersion, before.stateVersion);
});

test("another account's item is not there for playback to move", (t) => {
  const { app, p, id, cleanup } = setup();
  t.after(cleanup);
  const other = makeOwner(app);
  assert.throws(() => changeState(app, other, id, auto("inprogress", "play-9", 0, 0)), (err: unknown) => err instanceof HttpError && err.status === 404);
  assert.equal(getItem(app, p, id).workflow, "new");
});
