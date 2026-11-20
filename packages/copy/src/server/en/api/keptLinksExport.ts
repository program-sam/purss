// Server copy: apps/api/src/services/kept-links-export.ts
export default {
  note: "The links go to the original pages, which may change or disappear. What you kept is also saved in your PURSS.",
  published: (date: string) => `published ${date}`,
  kept: (date: string) => `kept ${date}`,
  nothingKeptHtml: "<p class=\"meta\">Nothing kept here yet.</p>\n",
  nothingKeptMarkdown: "_Nothing kept here yet._\n",
  title: (date: string) => `Kept links, ${date}`,
  heading: "Kept links",
  exported: (date: string) => `Exported ${date}.`,
};
