/** Copy for the browser extension (apps/extension): one file per area. */
import api from "./api.ts";
import background from "./background.ts";
import connect from "./connect.ts";
import manifest from "./manifest.ts";
import options from "./options.ts";
import popup from "./popup.ts";

export const extension = {
  api,
  background,
  connect,
  manifest,
  options,
  popup,
};
