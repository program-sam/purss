// Server copy: apps/api (errors people read, emails, public pages, notes)
import shared from "./api/shared.ts";
import app from "./api/app.ts";
import accounts from "./api/accounts.ts";
import oidc from "./api/oidc.ts";
import passkeys from "./api/passkeys.ts";
import passwords from "./api/passwords.ts";
import signup from "./api/signup.ts";
import billing from "./api/billing.ts";
import appAssociation from "./api/appAssociation.ts";
import connectClients from "./api/connectClients.ts";
import devices from "./api/devices.ts";
import gate from "./api/gate.ts";
import http from "./api/http.ts";
import mailTemplates from "./api/mailTemplates.ts";
import mcpServer from "./api/mcpServer.ts";
import mcpTools from "./api/mcpTools.ts";
import oauthAuthorize from "./api/oauthAuthorize.ts";
import oauthClients from "./api/oauthClients.ts";
import annotationsRoute from "./api/annotationsRoute.ts";
import appBundle from "./api/appBundle.ts";
import connectRoute from "./api/connectRoute.ts";
import frameCheckRoute from "./api/frameCheckRoute.ts";
import portabilityRoute from "./api/portabilityRoute.ts";
import pushRoute from "./api/pushRoute.ts";
import httpServer from "./api/httpServer.ts";
import accountEmail from "./api/accountEmail.ts";
import activity from "./api/activity.ts";
import admin from "./api/admin.ts";
import aiFilters from "./api/aiFilters.ts";
import annotations from "./api/annotations.ts";
import archiveFormat from "./api/archiveFormat.ts";
import assistant from "./api/assistant.ts";
import captures from "./api/captures.ts";
import collections from "./api/collections.ts";
import content from "./api/content.ts";
import deletion from "./api/deletion.ts";
import discover from "./api/discover.ts";
import failures from "./api/failures.ts";
import frameCheck from "./api/frameCheck.ts";
import icons from "./api/icons.ts";
import images from "./api/images.ts";
import itemReminders from "./api/itemReminders.ts";
import items from "./api/items.ts";
import jobs from "./api/jobs.ts";
import keptLinksExport from "./api/keptLinksExport.ts";
import links from "./api/links.ts";
import preferences from "./api/preferences.ts";
import newsAddress from "./api/newsAddress.ts";
import news from "./api/news.ts";
import notifications from "./api/notifications.ts";
import opmlImport from "./api/opmlImport.ts";
import opml from "./api/opml.ts";
import plans from "./api/plans.ts";
import portability from "./api/portability.ts";
import publicPages from "./api/publicPages.ts";
import push from "./api/push.ts";
import reconcile from "./api/reconcile.ts";
import reminders from "./api/reminders.ts";
import shares from "./api/shares.ts";
import sources from "./api/sources.ts";
import state from "./api/state.ts";
import statistics from "./api/statistics.ts";
import storage from "./api/storage.ts";
import publicRoute from "./api/publicRoute.ts";
import sharingRoute from "./api/sharingRoute.ts";

export default {
  shared,
  app,
  accounts,
  oidc,
  passkeys,
  passwords,
  signup,
  billing,
  appAssociation,
  connectClients,
  devices,
  gate,
  http,
  mailTemplates,
  mcpServer,
  mcpTools,
  oauthAuthorize,
  oauthClients,
  annotationsRoute,
  appBundle,
  connectRoute,
  frameCheckRoute,
  portabilityRoute,
  pushRoute,
  httpServer,
  accountEmail,
  activity,
  admin,
  aiFilters,
  annotations,
  archiveFormat,
  assistant,
  captures,
  collections,
  content,
  deletion,
  discover,
  failures,
  frameCheck,
  icons,
  images,
  itemReminders,
  items,
  jobs,
  keptLinksExport,
  links,
  preferences,
  newsAddress,
  news,
  notifications,
  opmlImport,
  opml,
  plans,
  portability,
  publicPages,
  push,
  reconcile,
  reminders,
  shares,
  sources,
  state,
  statistics,
  storage,
  publicRoute,
  sharingRoute,
};
