import { app } from "@purss/translations/app";
import { Outlet, createRootRouteWithContext, createRoute, lazyRouteComponent, notFound, redirect, useParams, useRouter } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import type { SessionInfo, Sort, ViewMode } from "@purss/domain";
import { inApp } from "./app-base.ts";
import { Button, IconSprite } from "@purss/ui";
import { SignInPage } from "./auth/SignIn.tsx";
import { safeNext } from "./auth/next.ts";
import { ApiError, get, messageOf } from "./api/client.ts";
import { readRecord } from "./offline/store.ts";
import { savedItemNumbered } from "./offline/pack.ts";
import { sessionQuery } from "./api/queries.ts";
import { LIST_FILTERS, SORT_ORDER, VIEW_MODES } from "./lib/constants.ts";
import { typesParam } from "./lib/list-filters.ts";
import type { ListFilter } from "./lib/constants.ts";
import type { ListSearch } from "./nav.ts";
import { HomePage } from "./pages/Home.tsx";
import { ListingPage } from "./pages/Listing.tsx";
import { purssPages } from "./plugins.ts";
import { Shell } from "./shell/Shell.tsx";

// Pages few visits need load when first opened, so PURSS starts with less code.
const SetupPage = lazyRouteComponent(() => import("./auth/Setup.tsx"), "SetupPage");
const ConnectPage = lazyRouteComponent(() => import("./features/connect/ConnectPage.tsx"), "ConnectPage");
const AuthorizePage = lazyRouteComponent(() => import("./features/assistant/AuthorizePage.tsx"), "AuthorizePage");
const InvitePage = lazyRouteComponent(() => import("./auth/Invite.tsx"), "InvitePage");
const SignupPage = lazyRouteComponent(() => import("./auth/Signup.tsx"), "SignupPage");
const VerifyEmailPage = lazyRouteComponent(() => import("./auth/EmailLinks.tsx"), "VerifyEmailPage");
const ResetPasswordPage = lazyRouteComponent(() => import("./auth/EmailLinks.tsx"), "ResetPasswordPage");
const StatsPage = lazyRouteComponent(() => import("./pages/Stats.tsx"), "StatsPage");

export type RouterContext = { queryClient: QueryClient };

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
function oneOf<T extends string>(list: readonly T[]) {
  return (v: unknown): T | undefined => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined);
}
const view = oneOf<ViewMode>(VIEW_MODES);
const filter = oneOf<ListFilter>(LIST_FILTERS);
const sort = oneOf<Sort>(SORT_ORDER);

/** Drop undefined so the URL only carries what's set. */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
/**
 * Text handed over in a deep link (a page's address and title, a search). The router reads values
 * that look like JSON as JSON, so a title "1984" arrives as a number: take it back as text.
 */
const handed = (max: number) => (v: unknown): string | undefined => {
  const t = typeof v === "number" || typeof v === "boolean" ? String(v) : v;
  return typeof t === "string" && t && t.length <= max ? t : undefined;
};
const linkUrl = handed(2000);
const linkTitle = handed(300);
const searchText = handed(200);
/** Deep links that open a popup with what they carry (see DIALOGS in Shell.tsx): ?dialog=add&url=…, ?dialog=keep&url=…&title=…, ?dialog=search&q=… */
const deepLink = (s: Record<string, unknown>) => ({ dialog: str(s.dialog), url: linkUrl(s.url), title: linkTitle(s.title), q: searchText(s.q) });
const itemAndDialog = (s: Record<string, unknown>): ListSearch => compact({ item: str(s.item), ...deepLink(s) });
const lengthOf = oneOf<"short" | "long">(["short", "long"]);
const mutedOf = oneOf<"show">(["show"]);
const captureOf = oneOf<"failed">(["failed"]);
const homeSearch = (s: Record<string, unknown>): ListSearch => compact({ ...itemAndDialog(s), muted: mutedOf(s.muted) });
const listSearch = (s: Record<string, unknown>): ListSearch => compact({
  item: str(s.item), view: view(s.view), filter: filter(s.filter), sort: sort(s.sort), source: str(s.source), without: str(s.without),
  type: typesParam(s.type), length: lengthOf(s.length), muted: mutedOf(s.muted), capture: captureOf(s.capture), ...deepLink(s),
});

async function sessionOf(qc: QueryClient): Promise<SessionInfo> {
  return qc.ensureQueryData(sessionQuery);
}
const whereTo = (s: SessionInfo) => (s.state === "unclaimed" ? "/setup" : s.state === "signed_out" ? "/signin" : "/");

/** Shown when the page can't even find out who is signed in, for example when opened with no connection and nothing saved. */
function LoadFailed({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="splash">
      <div className="empty card-like" style={{ maxWidth: 440 }}>
        <h2>{app.shell.app.openFailed}</h2>
        <p>{messageOf(error)}</p>
        <Button variant="primary" onClick={() => { reset(); void router.invalidate(); }}>{app.words.tryAgain}</Button>
      </div>
    </div>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <><IconSprite /><Outlet /></>,
  errorComponent: LoadFailed,
  notFoundComponent: () => (
    <div className="splash"><div className="empty card-like" style={{ maxWidth: 440 }}><h2>{app.shell.app.pageMissing}</h2><a className="btn primary" href={inApp("/")}>{app.words.goToHome}</a></div></div>
  ),
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/setup", component: SetupPage,
  beforeLoad: async ({ context }) => { const s = await sessionOf(context.queryClient); if (s.state !== "unclaimed") throw redirect({ to: whereTo(s) }); },
});
const signinRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/signin", component: SignInPage,
  validateSearch: (s: Record<string, unknown>) => compact({ error: str(s.error), provider: str(s.provider), next: safeNext(s.next), notice: str(s.notice), due: str(s.due) }),
  beforeLoad: async ({ context, search }) => {
    const s = await sessionOf(context.queryClient);
    if (s.state === "signed_in" && search.next) throw redirect({ href: search.next });
    if (s.state !== "signed_out") throw redirect({ to: whereTo(s) });
  },
});
/** A connected app's approval page: outside the PURSS shell, after sign-in. */
const connectRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/connect", component: ConnectPage,
  beforeLoad: async ({ context, location }) => {
    const s = await sessionOf(context.queryClient);
    // The page reads its parameters from the address itself (see ConnectPage), so return to it as written.
    const here = window.location.pathname === "/connect" ? `/connect${window.location.search}` : location.href;
    if (s.state === "signed_out") throw redirect({ to: "/signin", search: { next: here } });
    if (s.state !== "signed_in") throw redirect({ to: whereTo(s) });
  },
});
/** An assistant's OAuth consent page: outside the PURSS shell, after sign-in. */
const authorizeRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/oauth/authorize", component: AuthorizePage,
  beforeLoad: async ({ context }) => {
    const s = await sessionOf(context.queryClient);
    // Like /connect: come back to the request exactly as the assistant wrote it.
    if (s.state === "signed_out") throw redirect({ to: "/signin", search: { next: `/oauth/authorize${window.location.search}` } });
    if (s.state !== "signed_in") throw redirect({ to: whereTo(s) });
  },
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/invite", component: InvitePage, validateSearch: (s: Record<string, unknown>) => compact({ code: str(s.code), email: str(s.email) }),
  beforeLoad: async ({ context }) => {
    const s = await sessionOf(context.queryClient);
    if (s.state !== "signed_out") throw redirect({ to: whereTo(s) });
  },
});
const signupRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/signup", component: SignupPage, validateSearch: (s: Record<string, unknown>) => compact({ token: str(s.token) }),
  beforeLoad: async ({ context }) => {
    const s = await sessionOf(context.queryClient);
    if (s.state !== "signed_out" || s.installation.signup !== "open") throw redirect({ to: whereTo(s) });
  },
});

// Opened from links in account emails; they work signed in or out.
const tokenSearch = (s: Record<string, unknown>) => compact({ token: str(s.token) });
const verifyEmailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/verify-email", component: VerifyEmailPage, validateSearch: tokenSearch });
const resetPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reset-password", component: ResetPasswordPage, validateSearch: tokenSearch });

const purssRoute = createRoute({
  getParentRoute: () => rootRoute, id: "purss", component: Shell,
  beforeLoad: async ({ context, location }) => {
    const s = await sessionOf(context.queryClient);
    // A link into PURSS (a basket, or a deep link from the extension or a bookmarklet) survives signing in.
    if (s.state === "signed_out" && location.href !== "/") throw redirect({ to: "/signin", search: { next: safeNext(location.href) } });
    if (s.state !== "signed_in") throw redirect({ to: whereTo(s) });
  },
});

/**
 * An item's short link, /i/ and the item's number (itemPath): the item over Home. The number is looked up in what this device
 * saved first, so a saved item's link opens without a connection, and asked of the PURSS otherwise.
 */
const shortItemRoute = createRoute({
  getParentRoute: () => purssRoute, path: "/i/$number",
  beforeLoad: async ({ context, params }) => {
    if (!/^[1-9][0-9]{0,14}$/.test(params.number)) throw notFound();
    const number = Number(params.number);
    const s = await sessionOf(context.queryClient);
    let id = s.account ? savedItemNumbered(readRecord(s.account.id).items, number) : null;
    if (!id) {
      try {
        id = (await get<{ id: string }>(`/api/items/number/${number}`)).id;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw notFound();
        if (err instanceof ApiError && err.code === "offline") throw new ApiError(err.status, err.code, app.shell.app.itemNotSaved);
        throw err;
      }
    }
    throw redirect({ to: "/", search: { item: id }, replace: true });
  },
});

const homeRoute = createRoute({ getParentRoute: () => purssRoute, path: "/", validateSearch: homeSearch, component: HomePage });

function listing(t: "c" | "s" | "b" | "r") {
  return createRoute({
    getParentRoute: () => purssRoute, path: `/${t}/$id`, validateSearch: listSearch,
    component: function ListingRoute() {
      const { id } = useParams({ strict: false }) as { id: string };
      return <ListingPage key={`${t}:${id}`} place={{ t, id }} />;
    },
  });
}

/** Private statistics for a collection or a source, reached from its page header. */
function statsPage(t: "c" | "s") {
  return createRoute({
    getParentRoute: () => purssRoute, path: `/${t}/$id/stats`, validateSearch: itemAndDialog,
    component: function StatsRoute() {
      const { id } = useParams({ strict: false }) as { id: string };
      return <StatsPage key={`${t}:${id}`} place={{ t, id }} />;
    },
  });
}

/**
 * Pages registered in plugins.ts (storage, data, sharing, admin) are mounted here under the shell.
 * Reading the registry when the tree is built means a page registered before startup gets its route.
 */
function pluginRoutes() {
  return purssPages.map((p) => createRoute({ getParentRoute: () => purssRoute, path: p.path, validateSearch: itemAndDialog, component: p.component }));
}

export function buildRouteTree() {
  return rootRoute.addChildren([
    setupRoute, signinRoute, inviteRoute, signupRoute, connectRoute, authorizeRoute, verifyEmailRoute, resetPasswordRoute,
    purssRoute.addChildren([homeRoute, shortItemRoute, listing("c"), listing("s"), listing("b"), listing("r"), statsPage("c"), statsPage("s"), ...pluginRoutes()]),
  ]);
}
