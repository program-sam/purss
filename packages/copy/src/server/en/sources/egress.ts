// Server copy: apps/egress (messages people read about their sources)
export default {
  bridge: {
    feedTitle: (key: string, service: string) => `${key} on ${service}`,
  },
  rss: {
    untitled: "Untitled",
  },
};
