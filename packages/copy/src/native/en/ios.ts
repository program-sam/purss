// Native copy: the iOS app's own text, where it differs from Android's (NativeCopy.Ios in Swift): its widgets are
// edited from their touch-and-hold menu, not tapped. `panelChoice` is the widget settings' App Intent names, which
// Xcode reads at build time, so the generator writes them into PanelChoice.swift itself.
export default {
  widget: {
    chooseCollection: "Edit this widget to choose a collection.",
    chooseSource: "Edit this widget to choose a source.",
    collectionGone: "This collection is gone. Edit this widget to choose another.",
    sourceGone: "You don't follow this source any more. Edit this widget to choose another.",
    privateSource: "This source is private, so it isn't shown on the home screen. Edit this widget to choose another.",
    untitled: "Untitled",
    now: "now",
  },
  // The sample rows a widget shows while iOS draws it before it has data.
  placeholder: {
    first: "A headline that might be here",
    second: "Another one, a little longer than the first",
    third: "And a third",
    source: "Source",
  },
  panelChoice: {
    collection: "Collection",
    source: "Source",
    unavailable: "Unavailable",
  },
  notification: {
    more: "{count} more in your PURSS",
  },
};
