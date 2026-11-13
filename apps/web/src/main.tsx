import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { appHistory } from "./app-base.ts";
import "@fontsource-variable/nunito/wght.css";
import "@purss/ui";
import "./app.css";
import "./extra.css";
import "./eink.css";
import { ApiError, configureClient } from "./api/client.ts";
import { keys, sessionQuery } from "./api/queries.ts";
import { buildRouteTree } from "./routes.tsx";
import { OverlayProvider } from "./state/overlays.tsx";
import { ToastProvider } from "./state/toasts.tsx";
import { readVisualHint } from "./state/ui-store.ts";
import { initSounds } from "./lib/sound.ts";
import { applyDisplayMode, displayMode } from "./lib/display.ts";
import { initTextSize } from "./lib/text-size.ts";
import { OfflineController } from "./offline/OfflineController.tsx";
import { AppUpdateNotice } from "./shell/AppUpdates.tsx";
import { OutboxController } from "./outbox/OutboxController.tsx";
import { wipeOfflineCopies } from "./offline/worker-link.ts";
import { AnnotationSync } from "./annotations/use-annotations.ts";
import { LateProgressSync } from "./state/late-progress-sync.ts";
import { initPlatform, platform } from "./platform/index.ts";
import { registerDevicePages } from "./downloads/pages.ts";

// First paint: use the last known look so a reload doesn't flash the wrong theme. An e-ink display is always light.
applyDisplayMode();
const hint = readVisualHint();
if (displayMode() === "eink") document.documentElement.dataset.theme = "light";
if (hint) {
  const root = document.documentElement;
  if (displayMode() !== "eink") root.dataset.theme = hint.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : hint.theme;
  root.dataset.skin = hint.skin;
  root.dataset.density = hint.density;
}

initSounds();
initTextSize();

const queryClient = new QueryClient({
  queryCache: new QueryCache(),
  defaultOptions: {
    queries: {
      // Ask even when the browser says it is offline: the service worker may hold a saved copy of the answer.
      networkMode: "offlineFirst",
      // When the browser says it is offline there is nothing to retry: the saved copy, if any, was already tried.
      retry: (count, err) => !(err instanceof ApiError && ((err.code === "offline" && navigator.onLine === false) || (err.status >= 400 && err.status < 500))) && count < 2,
      // Coming back to the page (or the app, see platform/native) asks again for what is older than this, so changes made
      // on another device show up; a page left open on Home never keeps showing items already dealt with elsewhere.
      staleTime: 15_000,
    },
  },
});

const boot = await initPlatform();
const root = createRoot(document.getElementById("root")!);

if (boot.screen) {
  // The apps, before they are connected to a PURSS: only the first-run screen.
  root.render(<StrictMode>{boot.screen}</StrictMode>);
} else {
  registerDevicePages();
  const router = createRouter({ routeTree: buildRouteTree(), history: appHistory(), context: { queryClient }, defaultPreload: false, defaultNotFoundComponent: undefined });

  configureClient({
    onSessionLost: () => {
      // In the apps the device was disconnected: everything goes, back to the first screen.
      if (platform.connection) { platform.connection.lost(); return; }
      void wipeOfflineCopies();
      void queryClient.invalidateQueries({ queryKey: keys.session }).then(() => router.invalidate());
    },
    refreshCsrf: async () => (await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 })).csrf,
  });

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <OverlayProvider>
            <OfflineController />
            <AppUpdateNotice />
            <OutboxController />
            <AnnotationSync keepOtherAccounts={platform.kind === "app"} />
            <LateProgressSync keepOtherAccounts={platform.kind === "app"} />
            <RouterProvider router={router} />
          </OverlayProvider>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
