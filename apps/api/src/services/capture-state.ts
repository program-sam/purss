/*
 * What an item's readable copies add up to. One meaning, used wherever the question is asked:
 *
 *  - An item has a *settled* copy when one is on its way, or one is finished and passed the checks (the full text, or the text the
 *    person's browser sent). A copy that is only part of the page is kept and shown, but does not settle the item: a try that fails
 *    after it is a failed copy, told about in the bell and listed by `capture=failed`, and Try again is offered.
 *  - An item that has *any* finished copy, a partial one included, is not fetched again by itself: keeping it into another basket
 *    or a source's full-articles setting leaves it alone, and no room is held for a fetch nobody asked for. Only Try again fetches
 *    the page again, and its result replaces the copy only when it is better (full beats partial; among partials the longer body).
 *
 * Each of these is SQL over an item id expression: `fullCopy`, `pendingCopy` and `settledCopy` say what the item has, `failedCopy`
 * says its readable copy couldn't be saved.
 */

/** The item has a finished copy that passed the checks: the full text, or the text the person's browser sent. */
export const fullCopy = (itemId: string): string =>
  `EXISTS (SELECT 1 FROM captures dc WHERE dc.item_id = ${itemId} AND dc.status = 'done' AND dc.quality IS NOT 'partial')`;

/** A copy of the item is on its way. */
export const pendingCopy = (itemId: string): string =>
  `EXISTS (SELECT 1 FROM captures pc WHERE pc.item_id = ${itemId} AND pc.status = 'pending')`;

/** The item has a settled copy. */
export const settledCopy = (itemId: string): string =>
  `EXISTS (SELECT 1 FROM captures sc WHERE sc.item_id = ${itemId} AND (sc.status = 'pending' OR (sc.status = 'done' AND sc.quality IS NOT 'partial')))`;

/** A readable copy failed and none is settled (on its way, or finished and passed the checks), so the item says so. */
export const failedCopy = (itemId: string): string =>
  `(EXISTS (SELECT 1 FROM captures fc WHERE fc.item_id = ${itemId} AND fc.status = 'failed') AND NOT ${settledCopy(itemId)})`;
