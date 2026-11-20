// App copy: apps/web/src/annotations
export default {
  reader: {
    tooLong: (max: string) => `That passage is too long to highlight. Select up to ${max} characters.`,
    highlighted: "Highlighted",
    highlightedWithComment: "Highlighted with your comment",
    commentSaved: "Comment saved",
    highlightRemoved: "Highlight removed",
    noteRemoved: "Note removed",
  },
  selectionBar: {
    highlight: "Highlight",
    addComment: "Add comment",
  },
  highlightDialog: {
    titleNew: "Add a comment",
    titleEdit: "Your highlight",
    remove: "Remove highlight",
    cancel: "Cancel",
    saveNew: "Save highlight",
    save: "Save",
    comment: "Comment",
    placeholder: "What you think about this passage (optional)",
  },
  syncNote: {
    waiting: "Waiting to sync",
    couldntSave: "Couldn't save: ",
    tryAgain: "Try again",
    discard: "Discard this change",
  },
  notes: {
    title: "Your notes and highlights",
    waiting: (n: number) => `${n === 1 ? "1 change is" : `${n} changes are`} waiting to sync. ${n === 1 ? "It is" : "They are"} saved on this device and sent when the connection is back.`,
    unavailable: "Your notes on this item can't be shown without a connection. Anything you add now is kept and synced later.",
    saved: "Note saved",
    added: "Note added",
    meta: (date: string) => `Note · ${date}`,
    edit: "Edit",
    remove: "Remove",
    addNote: "Add a note",
    notFound: "Not found in the text shown. Your highlight is kept with its quote.",
    showInText: "Show in text",
    selectHint: "Select text in the article to highlight it or add a comment.",
  },
  noteEditor: {
    placeholder: "Your note about this item",
    save: "Save note",
    cancel: "Cancel",
  },
  sync: {
    otherAccounts: (n: number) => `${n === 1 ? "1 highlight or note" : `${n} highlights or notes`} from another account ${n === 1 ? "is" : "are"} waiting on this device. Copy or discard ${n === 1 ? "it" : "them"} in Settings → This device.`,
  },
  outbox: {
    highlight: "Highlight",
    note: "Note",
    entry: (kind: string, at: string, itemId: string) => `${kind} · ${at} · item ${itemId}`,
  },
};
