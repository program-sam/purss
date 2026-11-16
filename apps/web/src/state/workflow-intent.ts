const listeners = new Set<(itemId: string) => void>();

/** A hand-set workflow choice ends automatic playback changes for that item in this browser session. */
export function noteManualWorkflowChange(itemId: string): void {
  for (const listener of listeners) listener(itemId);
}

export function onManualWorkflowChange(listener: (itemId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
