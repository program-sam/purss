export default {
  sourcePicks: {
    none: "You don't follow any sources yet. Add one first.",
    inCollections: (names: string) => `In ${names}`,
    notInCollection: "Not in a collection",
  },
  queryBuilder: {
    hint: "Items must meet every condition. Leave a condition empty to skip it.",
    text: "Contains all of these words",
    textPlaceholder: "tide ferry timetable",
    fromSources: "From these sources",
    chooseSources: "Choose sources…",
    type: "Type",
    state: "State",
    kept: "Kept in a basket",
    keptEither: "Either way",
    keptOnly: "Only kept items",
    keptNot: "Only items not kept",
    date: "Date",
    published: "Published",
    arrived: "Arrived here",
    keptDate: "Kept",
  },
  emojiField: {
    label: "Symbol (optional)",
  },
};
