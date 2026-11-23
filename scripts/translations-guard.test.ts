// Visible text in the app, the UI kit and the extension comes from @purss/translations: a component that writes words people see
// inline fails here. Words only screen readers announce (inside className "sr"), keys in <kbd> (and the shortcut list's <K>), code in
// <code>, and an <option> with no value attribute (its text is the value it stands for, like a unit) may stay.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["apps/web/src", "packages/ui/src", "apps/extension/src"];
/** Attributes whose text is shown on screen. */
const SHOWN = new Set(["title", "placeholder", "alt", "data-tip"]);
const ALLOWED_PARENTS = new Set(["kbd", "K", "code"]);

type Node = { type: string; [k: string]: unknown };
const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && typeof (v as Node).type === "string";

function elementName(el: Node): string {
  const name = (el.openingElement as Node | undefined)?.name as Node | undefined;
  return name?.type === "JSXIdentifier" ? String(name.name) : "";
}
function hasScreenReaderClass(el: Node): boolean {
  const attrs = ((el.openingElement as Node | undefined)?.attributes ?? []) as Node[];
  return attrs.some((a) => a.type === "JSXAttribute" && (a.name as Node).name === "className" && (a.value as Node | null)?.type === "Literal" && String((a.value as Node).value).split(/\s+/).includes("sr"));
}

function isValueOption(el: Node): boolean {
  const attrs = ((el.openingElement as Node | undefined)?.attributes ?? []) as Node[];
  return elementName(el) === "option" && !attrs.some((a) => a.type === "JSXAttribute" && (a.name as Node).name === "value");
}

function inlineCopy(file: string): string[] {
  const ast = parseAst(readFileSync(path.join(ROOT, file), "utf8"), { lang: "tsx" });
  const found: string[] = [];
  const walk = (n: unknown, exempt: boolean): void => {
    if (Array.isArray(n)) { for (const c of n) walk(c, exempt); return; }
    if (!isNode(n)) return;
    let skip = exempt;
    if (n.type === "JSXElement") skip ||= ALLOWED_PARENTS.has(elementName(n)) || hasScreenReaderClass(n) || isValueOption(n);
    if (n.type === "JSXText" && !skip && /\p{L}/u.test(String(n.value))) found.push(`${file}: ${JSON.stringify(String(n.value).trim())}`);
    if (n.type === "JSXAttribute" && SHOWN.has(String((n.name as Node).name)) && (n.value as Node | null)?.type === "Literal") {
      const value = String((n.value as Node).value);
      if (/\p{L}{2}/u.test(value) && !/^https?:\/\//.test(value)) found.push(`${file}: ${String((n.name as Node).name)}=${JSON.stringify(value)}`);
    }
    for (const [k, v] of Object.entries(n)) if (k !== "type") walk(v, skip);
  };
  walk(ast, false);
  return found;
}

test("components show only catalog text: no words written inline where people see them", () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...ROOTS.map((r) => `${r}/*.tsx`)], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => f && !f.endsWith(".test.tsx"));
  assert.ok(files.length > 50, "the components were found");
  assert.deepEqual(files.flatMap(inlineCopy), [], "move these to packages/translations (see its README)");
});
