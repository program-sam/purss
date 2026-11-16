import type { WorkflowState } from "@purss/domain";
import type { PlaybackWorkflow } from "../outbox/entries.ts";
import { canPlaybackStart } from "./logic.ts";

/**
 * Pressing Play here on a YouTube video starts it, so it is In progress. The embedded player cannot be asked when the video ends
 * without YouTube's player script, which the page's policy does not allow (and the messages it would send without that script are not
 * a documented interface), so an embedded video is never marked Finished by itself.
 */
export function youtubeStartWorkflow(platform: string, workflow: WorkflowState, workflowRevision: number, sessionId: string): {
  from: WorkflowState;
  to: "inprogress";
  playback: PlaybackWorkflow;
} | null {
  if (platform !== "YouTube" || !canPlaybackStart(workflow)) return null;
  return {
    from: workflow,
    to: "inprogress",
    playback: { sessionId, expectedWorkflowRevision: workflowRevision, startedWorkflowRevision: workflowRevision },
  };
}
