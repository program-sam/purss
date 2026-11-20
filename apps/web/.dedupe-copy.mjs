// Step 1: find repeated catalog text per audience, write `words`, delete the repeats; prints the map for step 2.
import { parseAst } from "rolldown/parseAst";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const EN = path.resolve("../../packages/copy/src/en");
// [audience, file, how the file's value maps into the audience: "default:<prefix>" | "const:<name>:<prefix>"]
const FILES = [
  ["app", "app/screens.ts", "default:"], ["app", "app/dialogs.ts", "default:"], ["app", "app/account.ts", "default:"], ["app", "app/admin.ts", "default:"], ["app", "app/features.ts", "default:"],
  ["server", "server/api.ts", "default:api"], ["server", "server/sources.ts", "const:sources:sources"], ["server", "server/sources.ts", "const:pushRelay:pushRelay"],
  ...["compare", "desktop", "home", "kit", "legal", "pages"].map((s) => ["site", "site.ts", `const:${s}:${s}`]),
  ["extension", "extension.ts", "const:extension:"], ["common", "common.ts", "const:common:"], ["ui", "ui.ts", "const:ui:"],
];
const leaves = []; // {aud, file, path, text, start, end}
for (const [aud, file, how] of FILES) {
  const src = readFileSync(path.join(EN, file), "utf8"); const ast = parseAst(src, { lang: "ts" });
  const [kind, a, b] = how.split(":"); let obj, prefix;
  if (kind === "default") { obj = ast.body.find((s) => s.type === "ExportDefaultDeclaration").declaration; prefix = a; }
  else { obj = ast.body.filter((s) => s.type === "ExportNamedDeclaration").map((s) => s.declaration.declarations[0]).find((d) => d.id.name === a).init; prefix = b; }
  const walk = (o, p) => { for (const prop of o.properties) { const key = prop.key.name ?? prop.key.value; const q = p ? `${p}.${key}` : key;
    if (prop.value.type === "ObjectExpression") walk(prop.value, q);
    else if (prop.value.type === "Literal" && typeof prop.value.value === "string") leaves.push({ aud, file, path: q, text: prop.value.value, start: prop.start, end: prop.end });
    else if (prop.value.type === "TemplateLiteral" && prop.value.expressions.length === 0) leaves.push({ aud, file, path: q, text: prop.value.quasis[0].value.cooked, start: prop.start, end: prop.end }); } };
  walk(obj, prefix);
}
const camel = (t) => { const w = t.normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean).slice(0, 6); if (!w.length) return "text"; return w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join("").replace(/^(\d)/, "n$1"); };
const out = { remove: [], inline: [], words: {} };
for (const aud of ["app", "server", "site", "extension", "common", "ui"]) {
  const mine = leaves.filter((l) => l.aud === aud);
  const byText = new Map(); for (const l of mine) { if (!byText.has(l.text)) byText.set(l.text, []); byText.get(l.text).push(l); }
  const words = {}; const used = new Set();
  for (const [text, ls] of byText) {
    if (!/\p{L}/u.test(text)) { for (const l of ls) out.inline.push({ ...l }); continue; } // punctuation, numbers: back to code
    if (ls.length < 2) continue;
    let key = camel(text); if (/^\s|\s$/.test(text)) key += "Spaced"; let k = key, i = 2; while (used.has(k)) k = key + i++; used.add(k);
    words[k] = text; for (const l of ls) out.remove.push({ ...l, word: k });
  }
  out.words[aud] = words;
}
// delete the properties, last first per file
const byFile = new Map(); for (const l of [...out.remove, ...out.inline]) { if (!byFile.has(l.file)) byFile.set(l.file, []); byFile.get(l.file).push(l); }
for (const [file, ls] of byFile) {
  let src = readFileSync(path.join(EN, file), "utf8");
  const uniq = [...new Map(ls.map((l) => [l.start, l])).values()].sort((a, b) => b.start - a.start);
  for (const l of uniq) { let s = l.start, e = l.end; if (src[e] === ",") e++; const ls0 = src.lastIndexOf("\n", s - 1) + 1; if (/^\s*$/.test(src.slice(ls0, s)) && src[e] === "\n") { s = ls0; e++; } src = src.slice(0, s) + src.slice(e); }
  // objects left empty go too
  for (let again = true; again;) { const before = src; src = src.replace(/\n[ \t]*(?:"[^"]+"|[\w$]+): \{\s*\},?(?=\n)/g, ""); again = src !== before; }
  writeFileSync(path.join(EN, file), src);
}
writeFileSync("../../.output/dedupe-map.json", JSON.stringify(out, null, 1));
for (const [aud, w] of Object.entries(out.words)) console.log(aud, "words", Object.keys(w).length);
console.log("removed", out.remove.length, "inlined", out.inline.length);
