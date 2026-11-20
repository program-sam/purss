/** Copy the server sends to people: API errors, emails, public pages, source messages and the push relay's fallback notification. */
import api from "./api.ts";
import pushRelay from "./push-relay.ts";
import sources from "./sources.ts";

export const server = {
  api,
  pushRelay,
  sources,
};
