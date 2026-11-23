import test from "node:test";
import assert from "node:assert/strict";
import { youtubeStartWorkflow } from "./embedded-workflow.ts";

test("YouTube's Play here action starts In progress without claiming the embed can report completion", () => {
  assert.deepEqual(youtubeStartWorkflow("YouTube", "undecided", 7, "play-yt"), {
    from: "undecided", to: "inprogress",
    playback: { sessionId: "play-yt", expectedWorkflowRevision: 7, startedWorkflowRevision: 7 },
  });
  assert.equal(youtubeStartWorkflow("Vimeo", "undecided", 7, "play-vimeo"), null);
  assert.equal(youtubeStartWorkflow("YouTube", "ignored", 7, "play-yt"), null);
  assert.equal(youtubeStartWorkflow("YouTube", "finished", 7, "play-yt"), null);
  assert.equal(youtubeStartWorkflow("YouTube", "inprogress", 7, "play-yt"), null, "already In progress: nothing to do, and nothing here can say it has ended");
  assert.equal(youtubeStartWorkflow("YouTube", "toread", 7, "play-yt")?.from, "toread", "To watch is To read");
});
