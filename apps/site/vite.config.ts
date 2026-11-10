import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { createServer, defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin, type ViteDevServer } from "vite";
import { placeholders, siteFrom, type Site } from "./src/site.ts";

type Pages = typeof import("./src/pages.ts");
const PAGES_MODULE = "/src/pages.ts";

/**
 * Renders every page's HTML and head into its HTML file, in `vite dev` and `vite build`, and
 * serves or writes robots.txt and sitemap.xml. Pages are loaded through Vite so edits show on reload.
 */
function prerender(site: Site): Plugin {
  let dev: ViteDevServer | undefined;
  // One loader for the whole build; pages are transformed in parallel.
  let loader: Promise<ViteDevServer> | undefined;
  const pages = async (): Promise<Pages> => {
    const server = dev ?? await (loader ??= createServer({ configFile: false, root: import.meta.dirname, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom" }));
    return (await server.ssrLoadModule(PAGES_MODULE)) as Pages;
  };
  const files = async (): Promise<Record<string, string>> => {
    const p = await pages();
    return { "robots.txt": p.robots(site), "sitemap.xml": p.sitemap(site) };
  };
  return {
    name: "purss-site-prerender",
    configureServer(server) {
      dev = server;
      server.middlewares.use(async (req, res, next) => {
        const name = req.url?.split("?")[0]?.slice(1) ?? "";
        const body = (await files())[name];
        if (body === undefined) return next();
        res.setHeader("Content-Type", name.endsWith(".xml") ? "application/xml" : "text/plain");
        res.end(body);
      });
    },
    buildStart() {
      const missing = placeholders(site);
      if (missing.length) this.warn(`placeholder addresses in use; set ${missing.join(", ")} before publishing (see apps/site/README.md)`);
    },
    transformIndexHtml: {
      order: "pre",
      async handler(html, ctx) {
        const key = basename(ctx.filename, ".html");
        const p = await pages();
        if (!(key in p.PAGES)) throw new Error(`${ctx.filename} has no entry in src/pages.ts`);
        const page = key as keyof Pages["PAGES"];
        return html.replace("<!--head-->", p.head(site, page)).replace("<!--page-->", p.render(site, page));
      },
    },
    async generateBundle() {
      for (const [fileName, source] of Object.entries(await files())) this.emitFile({ type: "asset", fileName, source });
    },
    async closeBundle() {
      const server = loader;
      loader = undefined;
      await (await server)?.close();
    },
  };
}

// The public website: static pages, served by `vite dev` and built with `vite build`.
const root = searchForWorkspaceRoot(process.cwd());
export default defineConfig(({ mode }) => ({
  plugins: [prerender(siteFrom({ ...loadEnv(mode, import.meta.dirname, "SITE_"), ...process.env }))],
  server: {
    port: Number(process.env.PURSS_SITE_PORT ?? 5181),
    strictPort: true,
    // node_modules may be a link to another checkout; allow its real location too.
    fs: { allow: [root, realpathSync(`${root}/node_modules`)] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: { index: "index.html", terms: "terms.html", legal: "legal.html", privacy: "privacy.html", 404: "404.html" } },
  },
}));
