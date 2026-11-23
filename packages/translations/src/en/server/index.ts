/** Copy the server sends to people: API errors, emails, public pages, source messages and the push relay's notification. */
import api from "./api.ts";
import { pushRelay, sources } from "./sources.ts";

export const server = {
  // What several places say, written once.
  words: {
    resetYourPassword: "Reset your password",
    rssFeed: "RSS feed",
    untitled: "Untitled",
  },
  api,
  sources,
  pushRelay,
};
