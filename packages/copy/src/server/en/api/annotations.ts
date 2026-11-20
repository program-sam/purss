// Server copy: apps/api/src/services/annotations.ts
export default {
  thatNote: "That note",
  kindChange: "A highlight can't be turned into a note, or a note into a highlight.",
  tooManyAnnotations: (max: number) => `An item can have up to ${max} highlights and notes. Remove some before adding more.`,
};
