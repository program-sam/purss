/* Smart filters (plan/36): the numbers the browser shows, apart from the schemas so the web app ships no validation library. */

/** The longest description of what to keep or drop, in characters. */
export const AI_FILTER_TEXT_MAX = 600;

/** How many recent posts a preview judges. */
export const AI_FILTER_PREVIEW_POSTS = 20;

/**
 * Input tokens a week (ISO week, UTC) the Pro plan allows for Smart filters on the server's key (Jev bills input tokens only): a
 * safeguard for administrators, never shown to people.
 */
export const SMART_FILTER_WEEKLY_TOKENS = 25_000_000;
