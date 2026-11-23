/** Copy for the web app, which the desktop and mobile apps also run: one file per part of the app. */
import words from "./words.ts";
import screens from "./screens.ts";
import dialogs from "./dialogs.ts";
import account from "./account.ts";
import admin from "./admin.ts";
import features from "./features.ts";

export const app = {
  ...words,
  ...screens,
  ...dialogs,
  ...account,
  ...admin,
  ...features,
};
