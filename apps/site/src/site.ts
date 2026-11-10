/**
 * Launch facts the site links to and puts in its metadata. Each value can be set at build time
 * with the environment variable named next to it; until then the site uses the placeholder.
 * Placeholders on `.example` addresses can never resolve, so a build that still uses one warns.
 */
export type Site = {
  /** Where this website is served: canonical links, link previews and the sitemap. `SITE_ORIGIN` */
  origin: string;
  /** The hosted PURSS: dashboard and sign-up links. A path is on this site's own origin. `SITE_APP_URL` */
  app: string;
  /** The public source repository: source, docs and install links. `SITE_REPO_URL` */
  repo: string;
};

const DEFAULTS: Site = {
  origin: "https://purss.app",
  app: "/app",
  repo: "https://github.com/program-sam/purss",
};

const ENV: Record<keyof Site, string> = { origin: "SITE_ORIGIN", app: "SITE_APP_URL", repo: "SITE_REPO_URL" };

export function siteFrom(env: Record<string, string | undefined>): Site {
  const pick = (k: keyof Site) => (env[ENV[k]]?.trim() || DEFAULTS[k]).replace(/\/+$/, "");
  return { origin: pick("origin"), app: pick("app"), repo: pick("repo") };
}

/** Names of the variables still on a placeholder `.example` address. */
export function placeholders(site: Site): string[] {
  return (Object.keys(ENV) as (keyof Site)[]).filter((k) => /\.example(\/|$)/.test(site[k])).map((k) => ENV[k]);
}

/** Where each link on the site goes. */
export const links = (site: Site) => ({
  dashboard: `${site.app}/`,
  signUp: `${site.app}/signup`,
  source: site.repo,
  docs: `${site.repo}/blob/main/docs/README.md`,
  install: `${site.repo}/blob/main/docs/install.md`,
  clone: `${site.repo}.git`,
});
