import test from "node:test";
import assert from "node:assert/strict";
import { readOpenLink } from "./open-link.ts";

const item = "itm_0123456789abcdefghjkmnpqrs";
const source = "src_0123456789abcdefghjkmnpqrs";

test("a widget's link and a notification's link are read the same way, and only ever navigate", () => {
  assert.deepEqual(readOpenLink(`purss://open?item=${item}`), { itemId: item, sourceId: null }, "a widget's row");
  assert.deepEqual(readOpenLink(`purss://open?item=${item}&source=${source}`), { itemId: item, sourceId: source }, "a notification");
  assert.deepEqual(readOpenLink("purss://open"), { itemId: null, sourceId: null }, "Home");
  assert.deepEqual(readOpenLink(`purss://open/?item=${item}#x`), { itemId: item, sourceId: null });
  assert.deepEqual(readOpenLink(`PURSS://open?item=${item}&dialog=delete`), { itemId: item, sourceId: null }, "other parameters do nothing");
  assert.deepEqual(readOpenLink(`purss://open/?source=${source}&action=delete`), { itemId: null, sourceId: source });
  for (const bad of ["../x", "", "a%2Fb", `${item}x`, "javascript:alert(1)"]) {
    assert.deepEqual(readOpenLink(`purss://open?item=${bad}&source=${bad}`), { itemId: null, sourceId: null }, bad);
  }
  assert.equal(readOpenLink(`purss://connect?item=${item}`), null);
  assert.equal(readOpenLink(`https://evil.example/open?item=${item}`), null);
});
