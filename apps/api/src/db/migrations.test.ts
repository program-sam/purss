import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database, migrate } from "./database.ts";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

test("005 removes hand-picked collections and their membership table and leaves the other collections alone", () => {
  const db = new Database(":memory:");
  try {
    // A database as it was before 005, with one collection of each kind that existed then.
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "005")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.exec("PRAGMA foreign_keys = OFF"); // seed rows without building the whole account tree
    const add = (id: string, mode: string, position: number) =>
      db.run("INSERT INTO collections (id, workspace_id, name, mode, view, position, created_at) VALUES (?, 'ws_1', ?, ?, 'list', ?, '2026-01-01T00:00:00.000Z')", id, `Collection ${id}`, mode, position);
    add("col_sources", "sources", 0);
    add("col_manual", "manual", 1);
    add("col_query", "query", 2);
    db.run("INSERT INTO collection_sources (collection_id, source_id) VALUES ('col_sources', 'src_1')");
    db.run("INSERT INTO collection_items (collection_id, item_id, added_at) VALUES ('col_manual', 'itm_1', '2026-01-01T00:00:00.000Z')");
    db.exec("PRAGMA foreign_keys = ON");

    assert.equal(migrate(db), files.filter((f) => f >= "005").length, "005 and anything after it runs");

    assert.deepEqual(db.all<{ id: string }>("SELECT id FROM collections ORDER BY position").map((c) => c.id), ["col_sources", "col_query"]);
    assert.equal(db.all("SELECT 1 FROM collection_sources WHERE collection_id = 'col_sources'").length, 1, "source grouping is untouched");
    assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name = 'collection_items'"), undefined, "the membership table is gone");
    assert.equal(migrate(db), 0, "and it does not run twice");
  } finally {
    db.close();
  }
});

test("006 drops saved searches and leaves filter collections, which keep their own filter, working", () => {
  const db = new Database(":memory:");
  try {
    // A database as it was before 006, with a saved search and a filter collection.
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "006")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.exec("PRAGMA foreign_keys = OFF"); // seed rows without building the whole account tree
    const filter = JSON.stringify({ field: "text", value: "sediment" });
    db.run("INSERT INTO saved_queries (id, workspace_id, name, query, created_at) VALUES ('qry_1', 'ws_1', 'Sediment', ?, '2026-01-01T00:00:00.000Z')", filter);
    db.run("INSERT INTO collections (id, workspace_id, name, mode, query, view, position, created_at) VALUES ('col_filter', 'ws_1', 'Sediment', 'query', ?, 'list', 0, '2026-01-01T00:00:00.000Z')", filter);
    db.exec("PRAGMA foreign_keys = ON");

    assert.equal(migrate(db), files.filter((f) => f >= "006").length, "006 and anything after it runs");

    assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name = 'saved_queries'"), undefined, "the saved searches table is gone");
    assert.equal(db.get<{ query: string }>("SELECT query FROM collections WHERE id = 'col_filter'")?.query, filter, "the filter collection keeps its own filter");
    assert.equal(migrate(db), 0, "and it does not run twice");
  } finally {
    db.close();
  }
});

test("008 keeps every existing passkey and linked sign-in and accepts one password per account", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "008")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.run("INSERT INTO accounts (id, created_at) VALUES ('acc_1', '2026-01-01T00:00:00.000Z'), ('acc_2', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, credential_id, public_key, counter, created_at) VALUES ('sim_pk', 'acc_1', 'passkey', 'Laptop', 'cred1', x'0102', 7, '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, used_at, created_at) VALUES ('sim_rc', 'acc_1', 'recovery', 'abcd', 'salt$hash', NULL, '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO sign_in_methods (id, account_id, kind, issuer, subject, created_at) VALUES ('sim_oi', 'acc_1', 'oidc', 'https://id.example', 'sub1', '2026-01-01T00:00:00.000Z')");
    // Recovery codes were removed later (054) together with the column that marked them used.
    const kept = "id, account_id, kind, label, credential_id, public_key, counter, transports, issuer, subject, secret_hash, created_at, last_used_at";
    const before = db.all(`SELECT ${kept} FROM sign_in_methods WHERE kind <> 'recovery' ORDER BY id`);

    assert.equal(migrate(db), files.filter((f) => f >= "008").length);
    assert.deepEqual(db.all(`SELECT ${kept} FROM sign_in_methods ORDER BY id`), before, "rows survive the rebuild unchanged");

    db.run("INSERT INTO sign_in_methods (id, account_id, kind, secret_hash, created_at) VALUES ('sim_pw1', 'acc_1', 'password', 'h', '2026-01-02T00:00:00.000Z')");
    db.run("INSERT INTO sign_in_methods (id, account_id, kind, secret_hash, created_at) VALUES ('sim_pw2', 'acc_2', 'password', 'h', '2026-01-02T00:00:00.000Z')");
    assert.throws(() => db.run("INSERT INTO sign_in_methods (id, account_id, kind, secret_hash, created_at) VALUES ('sim_pw3', 'acc_1', 'password', 'h', '2026-01-02T00:00:00.000Z')"), /UNIQUE/, "one password per account");
  } finally {
    db.close();
  }
});

test("054 deletes the recovery codes and what only they needed, and keeps every other sign-in method and session", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "054")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    const at = "2026-01-01T00:00:00.000Z";
    db.run("INSERT INTO accounts (id, created_at) VALUES ('acc_1', ?), ('acc_2', ?)", at, at);
    db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, credential_id, public_key, counter, transports, created_at, last_used_at) VALUES ('sim_pk', 'acc_1', 'passkey', 'Laptop', 'cred1', x'0102', 7, '[\"internal\"]', ?, ?)", at, at);
    db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at, last_used_at) VALUES ('sim_pw', 'acc_1', 'password', 'parent', 'scrypt$1$8$1$s$h', ?, ?)", at, at);
    db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES ('sim_oi', 'acc_2', 'oidc', 'Provider', 'https://id.example', 'sub1', ?)", at);
    db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, used_at, created_at) VALUES ('sim_rc1', 'acc_1', 'recovery', 'abcd', 'salt$hash', NULL, ?), ('sim_rc2', 'acc_2', 'recovery', 'efgh', 'salt$hash', ?, ?)", at, at, at);
    db.run("INSERT INTO account_enrollment (account_id, recovery_generation, recovery_acknowledged_generation, durable_method_exists) VALUES ('acc_1', 1, 1, 1)");
    db.run("INSERT INTO sessions (id, account_id, csrf, created_at, expires_at, last_seen_at, auth_at, method, user_agent, session_class, setup_permission_expires_at) VALUES ('ses_1', 'acc_1', 'c', ?, '2027-01-01T00:00:00.000Z', ?, ?, 'recovery', 'ua', 'shared', ?)", at, at, at, at);
    db.run("INSERT INTO signup_attempts (attempt_hash, account_id, session_id, created_at) VALUES ('hash1', 'acc_1', 'ses_1', ?)", at);
    const kept = "id, account_id, kind, label, credential_id, public_key, counter, transports, issuer, subject, secret_hash, created_at, last_used_at";
    // Usernames went later (055): a password's label is cleared then, and the index that kept them unique dropped.
    const methods = db.all<Record<string, unknown>>(`SELECT ${kept} FROM sign_in_methods WHERE kind <> 'recovery' ORDER BY id`).map((m) => ({ ...m, ...(m.kind === "password" ? { label: null } : {}) }));
    const sessionColumns = "id, account_id, csrf, created_at, expires_at, last_seen_at, auth_at, method, user_agent, session_class";
    const sessions = db.all(`SELECT ${sessionColumns} FROM sessions`);
    const indexes = () => db.all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sign_in_methods' AND sql IS NOT NULL ORDER BY name");
    const indexesBefore = indexes().filter((i) => (i as { name: string }).name !== "sign_in_methods_username");

    assert.equal(migrate(db), files.filter((f) => f >= "054").length);
    assert.equal(db.get("SELECT 1 FROM sign_in_methods WHERE kind = 'recovery'"), undefined, "the recovery codes are deleted, used or not");
    assert.deepEqual(db.all<object>(`SELECT ${kept} FROM sign_in_methods ORDER BY id`).map((m) => ({ ...m })), methods, "the passkey, password and linked sign-in are as they were");
    assert.deepEqual(db.all(`SELECT ${sessionColumns} FROM sessions`), sessions, "sessions are as they were");
    assert.deepEqual(indexes(), indexesBefore, "and so are the table's indexes");
    const columns = (t: string) => db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name);
    assert.ok(!columns("sign_in_methods").includes("used_at"), "the single-use mark is gone");
    assert.ok(!columns("sessions").some((c) => c.startsWith("setup_permission")), "so is the setup permission");
    assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name = 'account_enrollment'"), undefined, "and the enrollment table");
    assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name = 'signup_attempts'"), undefined, "and the sign-up attempts");

    assert.throws(() => db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES ('sim_rc3', 'acc_1', 'recovery', 'abcd', 'h', ?)", at), /CHECK/, "no recovery code can be made again");
    assert.throws(() => db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES ('sim_pw3', 'acc_1', 'password', 'other', 'h', ?)", at), /UNIQUE/, "and an account still has one password");
    assert.throws(() => db.run("INSERT INTO sign_in_methods (id, account_id, kind, issuer, subject, created_at) VALUES ('sim_oi2', 'acc_1', 'oidc', 'https://id.example', 'sub1', ?)", at), /UNIQUE/, "and a linked identity belongs to one account");
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.equal(migrate(db), 0, "and it does not run twice");
  } finally {
    db.close();
  }
});

test("055 makes the address the sign-in: the first to confirm a shared address keeps it, usernames and address-less invitations go", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "055")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    const account = (id: string, email: string | null, verified: string | null, created: string) =>
      db.run("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?, ?, ?, ?)", id, email, verified, created);
    // Three share an address in different cases: the one that confirmed it first keeps it, though another is older.
    account("acc_old", "Pat@Example.org", null, "2026-01-01T00:00:00.000Z");
    account("acc_late", "pat@example.org", "2026-03-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    account("acc_first", "PAT@example.org", "2026-02-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    // Two share one nobody confirmed: the older keeps it.
    account("acc_a", "sam@example.org", null, "2026-01-01T00:00:00.000Z");
    account("acc_b", "Sam@example.org", null, "2026-01-02T00:00:00.000Z");
    account("acc_solo", "solo@example.org", null, "2026-01-01T00:00:00.000Z");
    account("acc_none", null, null, "2026-01-01T00:00:00.000Z");
    db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES ('sim_pw', 'acc_solo', 'password', 'solo', 'h', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO invites (id, created_by, created_at, expires_at, used_at, used_by) VALUES ('inv_used', 'acc_solo', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'acc_a'), ('inv_open', 'acc_solo', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', NULL, NULL)");

    assert.equal(migrate(db), files.filter((f) => f >= "055").length);
    const emails = Object.fromEntries(db.all<{ id: string; email: string | null; email_verified_at: string | null }>("SELECT id, email, email_verified_at FROM accounts").map((a) => [a.id, [a.email, a.email_verified_at]]));
    assert.deepEqual(emails, {
      acc_old: [null, null], acc_late: [null, null], acc_first: ["PAT@example.org", "2026-02-01T00:00:00.000Z"],
      acc_a: ["sam@example.org", null], acc_b: [null, null], acc_solo: ["solo@example.org", null], acc_none: [null, null],
    });
    assert.equal(db.get<{ label: string | null }>("SELECT label FROM sign_in_methods WHERE id = 'sim_pw'")!.label, null, "the username is gone");
    assert.deepEqual(db.all<{ id: string }>("SELECT id FROM invites").map((i) => i.id), ["inv_used"], "an unused invitation without an address ends");
    assert.throws(() => db.run("UPDATE accounts SET email = 'SOLO@example.org' WHERE id = 'acc_none'"), /UNIQUE/, "an address belongs to one account, in any case");
    db.run("UPDATE accounts SET email = NULL WHERE id = 'acc_solo'");
    db.run("UPDATE accounts SET email = NULL WHERE id = 'acc_a'");
    assert.equal(db.all("SELECT 1 FROM accounts WHERE email IS NULL").length, 6, "any number of accounts may have none (their data was removed)");
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.equal(migrate(db), 0);
  } finally {
    db.close();
  }
});

test("025 fills in the address key of existing items and indexes it per workspace", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "025")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.exec("PRAGMA foreign_keys = OFF");
    const add = (id: string, url: string | null) =>
      db.run("INSERT INTO items (id, account_id, workspace_id, kind, title, url, discovered_at, created_at, updated_at) VALUES (?, 'acc_1', 'ws_1', 'article', 't', ?, 'x', 'x', 'x')", id, url);
    add("itm_1", "https://Example.org/post/?utm_source=feed#top");
    add("itm_2", null);
    add("itm_3", "mailto:someone@example.org");
    db.exec("PRAGMA foreign_keys = ON");

    assert.equal(migrate(db), files.filter((f) => f >= "025").length);
    const keys = Object.fromEntries(db.all<{ id: string; url_key: string | null }>("SELECT id, url_key FROM items").map((r) => [r.id, r.url_key]));
    assert.deepEqual(keys, { itm_1: "example.org/post", itm_2: null, itm_3: null });
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM items WHERE workspace_id = 'ws_1' AND url_key = 'example.org/post'").map((r) => r.detail).join(" ");
    assert.match(plan, /items_ws_url_key/, "lookups use the index");
  } finally {
    db.close();
  }
});

test("026 keeps every storage ledger row, its is_current flags and 022's triggers while teaching it the media kind", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "026")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.run("INSERT INTO accounts (id, created_at) VALUES ('acc_1', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO workspaces (id, account_id, created_at) VALUES ('wsp_1', 'acc_1', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, bytes, created_at) VALUES ('obj_1', 'acc_1', 'wsp_1', 'record', 'state:x', NULL, 64, '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, bytes, created_at, released_at) VALUES ('obj_2', 'acc_1', 'wsp_1', 'capture', 'cap_1', 'itm_1', 900, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')");
    db.exec("PRAGMA foreign_keys = OFF"); // an item and its two versions, without the whole account tree
    db.run("INSERT INTO items (id, account_id, workspace_id, kind, title, discovered_at, current_version_id, created_at, updated_at) VALUES ('itm_1', 'acc_1', 'wsp_1', 'article', 't', 'x', 'ver_1', 'x', 'x')");
    db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, bytes, created_at, is_current) VALUES ('obj_v1', 'acc_1', 'wsp_1', 'item_version', 'ver_1', 'itm_1', 30, 'x', 1), ('obj_v2', 'acc_1', 'wsp_1', 'item_version', 'ver_2', 'itm_1', 40, 'x', 0)");
    db.exec("PRAGMA foreign_keys = ON");
    const schema = () => db.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE (type = 'index' AND tbl_name = 'stored_objects') OR type = 'trigger' ORDER BY type, name");
    const before = db.all("SELECT * FROM stored_objects ORDER BY id");
    const schemaBefore = schema();
    assert.equal(migrate(db), files.filter((f) => f >= "026").length);
    assert.deepEqual(db.all(`SELECT ${Object.keys(before[0]!).join(", ")} FROM stored_objects ORDER BY id`), before, "rows survive the rebuild unchanged, is_current included");
    assert.deepEqual(schema(), schemaBefore, "022's indexes and triggers come back exactly");
    db.run("UPDATE items SET current_version_id = 'ver_2' WHERE id = 'itm_1'");
    assert.deepEqual(db.all<{ id: string; is_current: number }>("SELECT id, is_current FROM stored_objects WHERE kind = 'item_version' ORDER BY id").map((r) => [r.id, r.is_current]), [["obj_v1", 0], ["obj_v2", 1]], "and the triggers still keep the flag");
    db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, bytes, created_at) VALUES ('obj_3', 'acc_1', 'wsp_1', 'media', 'med_1', 10, '2026-01-03T00:00:00.000Z')");
    assert.throws(() => db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, bytes, created_at) VALUES ('obj_4', 'acc_1', 'wsp_1', 'media', 'med_1', 10, '2026-01-03T00:00:00.000Z')"), /UNIQUE/, "one live object per media file");
  } finally {
    db.close();
  }
});

test("017 adds account deletions to a populated database without rebuilding or changing accounts", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "017")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    const at = "2026-01-01T00:00:00.000Z";
    db.run("INSERT INTO accounts (id, display_name, created_at) VALUES ('acc_1', 'Ann', ?), ('acc_2', NULL, ?)", at, at);
    db.run("INSERT INTO workspaces (id, account_id, created_at) VALUES ('wsp_1', 'acc_1', ?), ('wsp_2', 'acc_2', ?)", at, at);
    db.run("INSERT INTO engine_users (id, account_id, workspace_id, username, created_at) VALUES ('eng_1', 'acc_1', 'wsp_1', 'purss1', ?)", at);
    db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, created_at) VALUES ('src_1', 'acc_1', 'wsp_1', 'feed', 'Feed', 'RSS feed', ?)", at);
    // Later migrations may add columns to accounts (028); this one neither changes a row nor rebuilds the table.
    const cols = db.all<{ name: string }>("SELECT name FROM pragma_table_info('accounts')").map((c) => c.name).join(", ");
    const before = { accounts: db.all(`SELECT ${cols} FROM accounts ORDER BY id`), root: db.get<{ rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE name = 'accounts'")!.rootpage };

    assert.equal(migrate(db), files.filter((f) => f >= "017").length);
    assert.deepEqual(db.all(`SELECT ${cols} FROM accounts ORDER BY id`), before.accounts, "accounts are unchanged");
    assert.equal(db.get<{ rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE name = 'accounts'")!.rootpage, before.root, "and the table wasn't rebuilt");
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources")!.n, 1);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM account_deletions")!.n, 0, "nobody is being deleted");

    db.run("INSERT INTO account_deletions (account_id, request_id, requested_at, due_at, state) VALUES ('acc_1', 'adr_1', ?, ?, 'pending')", at, at);
    assert.throws(() => db.run("INSERT INTO account_deletions (account_id, request_id, requested_at, due_at, state) VALUES ('acc_2', 'adr_1', ?, ?, 'pending')", at, at), /UNIQUE/, "one request id per request");
    assert.throws(() => db.run("INSERT INTO account_deletions (account_id, request_id, requested_at, due_at, state) VALUES ('acc_2', 'adr_2', ?, ?, 'gone')", at, at), /CHECK/);
    assert.throws(() => db.run("INSERT INTO account_deletions (account_id, request_id, requested_at, due_at, state) VALUES ('acc_x', 'adr_3', ?, ?, 'pending')", at, at), /FOREIGN KEY/);
    assert.equal(migrate(db), 0, "and it does not run twice");
  } finally {
    db.close();
  }
});

test("029 keeps pending connection codes while teaching the table OAuth codes", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "029")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.run("INSERT INTO accounts (id, created_at) VALUES ('acc_1', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO connect_codes (code_hash, account_id, kind, redirect_uri, code_challenge, device_name, created_at, expires_at) VALUES ('h1', 'acc_1', 'mobile', 'purss://connect', 'c', 'Pixel 8', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')");
    assert.equal(migrate(db), files.filter((f) => f >= "029").length);
    assert.deepEqual({ ...db.get<Record<string, unknown>>("SELECT kind, client_id, redirect_uri, label, scope FROM connect_codes WHERE code_hash = 'h1'")! }, { kind: "mobile", client_id: null, redirect_uri: "purss://connect", label: "Pixel 8", scope: null });
    const oauth = (clientId: string | null, scope: string | null, redirect: string | null) => () => db.run(
      "INSERT INTO connect_codes (code_hash, account_id, kind, client_id, redirect_uri, code_challenge, label, scope, created_at, expires_at) VALUES (?, 'acc_1', 'oauth', ?, ?, 'c', 'Claude', ?, 'x', 'y')",
      `h-${clientId}-${scope}-${redirect}`, clientId, redirect, scope);
    oauth("https://claude.ai/oauth/x", "write", "https://claude.ai/cb")();
    assert.throws(oauth(null, "read", "https://claude.ai/cb"), /CHECK/, "an OAuth code names its client");
    assert.throws(oauth("https://claude.ai/oauth/x", "admin", "https://claude.ai/cb"), /CHECK/);
    assert.throws(oauth("https://claude.ai/oauth/x", "read", null), /CHECK/, "and its redirect URI");
    assert.throws(() => db.run("INSERT INTO connect_codes (code_hash, account_id, kind, client_id, code_challenge, label, created_at, expires_at) VALUES ('h3', 'acc_1', 'mobile', 'https://x.example/c', 'c', 'n', 'x', 'y')"), /CHECK/, "apps have no OAuth client id");
  } finally {
    db.close();
  }
});

test("030 keeps every capture, its columns and indexes while teaching captures the browser kind, one per item", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "030")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.run("INSERT INTO accounts (id, created_at) VALUES ('acc_1', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO workspaces (id, account_id, created_at) VALUES ('wsp_1', 'acc_1', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO items (id, account_id, workspace_id, kind, title, url, discovered_at, created_at, updated_at) VALUES ('itm_1', 'acc_1', 'wsp_1', 'article', 't', 'https://example.org/a', 'x', 'x', 'x')");
    db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, text, html, final_url, created_at, completed_at) VALUES ('cap_1', 'wsp_1', 'itm_1', 'fulltext', 'done', 'Text', '<p>Text</p>', 'https://example.org/a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z')");
    db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, error, created_at, failure_notified_for) VALUES ('cap_2', 'wsp_1', 'itm_1', 'fulltext', 'failed', 'gone', '2026-01-02T00:00:00.000Z', 'cap_2')");
    const before = db.all("SELECT * FROM captures ORDER BY id");
    assert.equal(migrate(db), files.filter((f) => f >= "030").length);
    // Later migrations add columns; the ones the rows had before keep their values.
    assert.deepEqual(db.all(`SELECT ${Object.keys(before[0]!).join(", ")} FROM captures ORDER BY id`), before, "rows survive the rebuild unchanged");
    db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, created_at) VALUES ('cap_3', 'wsp_1', 'itm_1', 'browser', 'done', '2026-01-03T00:00:00.000Z')");
    assert.throws(() => db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, created_at) VALUES ('cap_4', 'wsp_1', 'itm_1', 'browser', 'done', '2026-01-03T00:00:00.000Z')"), /UNIQUE/, "one browser capture per item");
    assert.throws(() => db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, created_at) VALUES ('cap_5', 'wsp_1', 'itm_1', 'other', 'done', '2026-01-03T00:00:00.000Z')"), /CHECK/);
    assert.deepEqual(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'captures' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name), ["captures_browser_item", "captures_completed", "captures_item", "captures_pending", "captures_unchecked"]);
  } finally {
    db.close();
  }
});

test("a populated database built from main's migrations (001-024) takes ours: every row, column, index and trigger survives", () => {
  const db = new Database(":memory:");
  try {
    // The server's database has main's 001-024 when ours (025 onwards) first run on it.
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const mains = files.filter((f) => f < "025");
    for (const file of mains) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    const at = "2026-01-01T00:00:00.000Z";
    db.run("INSERT INTO accounts (id, display_name, created_at) VALUES ('acc_1', 'Ann', ?), ('acc_2', 'Bo', ?)", at, at);
    db.run("INSERT INTO workspaces (id, account_id, created_at, last_visit_at) VALUES ('wsp_1', 'acc_1', ?, ?), ('wsp_2', 'acc_2', ?, NULL)", at, at, at);
    db.run("INSERT INTO account_enrollment (account_id, recovery_generation, durable_method_exists) VALUES ('acc_1', 1, 1)");    db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, created_at, home_share, posts_per_day) VALUES ('src_1', 'acc_1', 'wsp_1', 'feed', 'Feed', 'RSS feed', ?, 'own', 2.5)", at);
    db.exec("PRAGMA foreign_keys = OFF"); // items and their versions point at each other
    db.run("INSERT INTO items (id, account_id, workspace_id, source_id, kind, title, url, discovered_at, current_version_id, created_at, updated_at) VALUES ('itm_1', 'acc_1', 'wsp_1', 'src_1', 'article', 't', 'https://Example.org/a?utm_source=x', ?, 'ver_1', ?, ?)", at, at, at);
    db.run("INSERT INTO item_versions (id, workspace_id, item_id, title, content_hash, summary_html, created_at, content_omitted) VALUES ('ver_1', 'wsp_1', 'itm_1', 't', 'h', '<p>s</p>', ?, 1)", at);
    db.exec("PRAGMA foreign_keys = ON");
    db.run("INSERT INTO item_state (item_id, workspace_id, workflow, revision, fresh, progress, updated_at, state_version) VALUES ('itm_1', 'wsp_1', 'toread', 3, 0, 0, ?, 7)", at);
    db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, error, created_at, failure_notified_for) VALUES ('cap_1', 'wsp_1', 'itm_1', 'fulltext', 'failed', 'gone', ?, 'cap_1')", at);
    db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, bytes, created_at, is_current) VALUES ('obj_1', 'acc_1', 'wsp_1', 'item_version', 'ver_1', 'itm_1', 40, ?, 1)", at);
    db.run("INSERT INTO storage_accounts (account_id, used_bytes) VALUES ('acc_1', 40)");
    db.run("INSERT INTO account_deletions (account_id, request_id, requested_at, due_at, state) VALUES ('acc_2', 'adr_1', ?, ?, 'pending')", at, at);

    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' AND name <> 'schema_migrations'").map((r) => r.name);
    const columnsOf = (t: string) => db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name);
    const rowsOf = (t: string, cols: string[]) => db.all(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${t}" ORDER BY rowid`);
    const before = new Map(tables.map((t) => [t, { cols: columnsOf(t), rows: rowsOf(t, columnsOf(t)) }]));
    const objects = () => db.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name");
    const objectsBefore = objects();

    assert.equal(migrate(db), files.length - mains.length, "every one of ours applies");
    // Separate "shared collections" were removed when sharing moved onto baskets and collections (043, owner decision).
    // The enrollment record went with the recovery codes (054).
    const removed = new Set(["publications", "publication_items", "account_enrollment"]);
    // The posting rate behind the "busy" hint went with the Fewer share of Home (050), and the share of Home itself (052): owner decisions.
    // The setup permission and the single-use mark of recovery codes went with them (054).
    const droppedColumns = new Set(["sources.posts_per_day", "sources.home_share", "sessions.setup_permission_expires_at", "sessions.setup_permission_used_at", "sign_in_methods.used_at"]);
    for (const t of removed) assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name = ?", t), undefined, `${t} is gone`);
    for (const [t, b] of before) {
      if (removed.has(t)) continue;
      const after = columnsOf(t);
      const kept = b.cols.filter((c) => !droppedColumns.has(`${t}.${c}`));
      for (const c of kept) assert.ok(after.includes(c), `${t}.${c} is still there`);
      const was = kept.length === b.cols.length ? b.rows : b.rows.map((r) => Object.assign(Object.create(null), Object.fromEntries(Object.entries(r as object).filter(([c]) => kept.includes(c)))));
      assert.deepEqual(rowsOf(t, kept), was, `${t}: every row as it was`);
    }
    const after = new Map(objects().map((o) => [(o as { name: string }).name, o]));
    // Usernames went when the address became the sign-in (055), and with them the index that kept them unique.
    const droppedIndexes = new Set(["sign_in_methods_username"]);
    for (const o of objectsBefore) {
      if (removed.has((o as { tbl_name: string }).tbl_name) || droppedIndexes.has((o as { name: string }).name)) continue;
      assert.deepEqual(after.get((o as { name: string }).name), o, `${(o as { name: string }).name} is unchanged`);
    }
    assert.equal(db.get<{ url_key: string }>("SELECT url_key FROM items WHERE id = 'itm_1'")!.url_key, "example.org/a");
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.equal(db.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check, "ok");
    assert.equal(migrate(db), 0);
  } finally {
    db.close();
  }
});

test("every migration applies in order from an empty database, once, and leaves foreign keys and the rebuilt tables intact", () => {
  const db = new Database(":memory:");
  try {
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    assert.equal(new Set(files.map((f) => f.slice(0, 3))).size, files.length, "no two migrations share a number");
    assert.equal(migrate(db), files.length);
    assert.equal(migrate(db), 0, "nothing runs twice");
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.equal(db.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check, "ok");
    // The tables 029 and 030 rebuild or create exist under their own names, with no leftovers from the rebuild.
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    for (const t of ["connect_codes", "captures", "oauth_grants", "oauth_access_tokens", "oauth_refreshes"]) assert.ok(tables.includes(t), t);
    assert.ok(!tables.includes("oauth_tokens"));
    assert.deepEqual(tables.filter((t) => t.endsWith("_new")), []);
  } finally {
    db.close();
  }
});

test("033 releases what was saved on the server: ledger, used bytes, open reservations and downloads go; everything else is left as it was", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "033")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    const at = "2026-10-01T00:00:00.000Z";
    for (const n of [1, 2, 3]) {
      db.run("INSERT INTO accounts (id, created_at) VALUES (?, ?)", `acc_${n}`, at);
      db.run("INSERT INTO workspaces (id, account_id, created_at) VALUES (?, ?, ?)", `wsp_${n}`, `acc_${n}`, at);
    }
    db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, created_at, save_media, save_media_since) VALUES ('src_1', 'acc_1', 'wsp_1', 'podcast', 'Slow Radio', 'RSS feed', ?, 'new', ?), ('src_2', 'acc_2', 'wsp_2', 'feed', 'Tide Notes', 'RSS feed', ?, 'off', NULL)", at, at, at);
    for (const [id, acc, src] of [["itm_1", "acc_1", "src_1"], ["itm_2", "acc_1", "src_1"], ["itm_3", "acc_1", "src_1"], ["itm_4", "acc_2", "src_2"]] as const) {
      db.run("INSERT INTO items (id, account_id, workspace_id, source_id, kind, title, discovered_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'podcast', 'Episode', ?, ?, ?)", id, acc, `wsp_${acc.slice(4)}`, src, at, at, at);
    }
    // Saved files: acc_1 holds two (5000 and 700 bytes) and had one released earlier (300); acc_2 holds one (1000).
    const media = (id: string, acc: string, item: string, status: string, bytes: number | null) =>
      db.run("INSERT INTO saved_media (id, item_id, account_id, workspace_id, url, origin, status, content_type, bytes, sha256, requested_at, completed_at) VALUES (?, ?, ?, ?, 'https://cdn.example.org/a.mp3', 'manual', ?, 'audio/mpeg', ?, 'x', ?, ?)", id, item, acc, `wsp_${acc.slice(4)}`, status, bytes, at, at);
    media("med_1", "acc_1", "itm_1", "done", 5000);
    media("med_2", "acc_1", "itm_2", "done", 700);
    media("med_0", "acc_1", "itm_3", "failed", null);
    media("med_3", "acc_2", "itm_4", "done", 1000);
    let n = 0;
    const object = (id: string, acc: string, kind: string, ref: string, bytes: number, released: string | null = null) => {
      db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, bytes, created_at, released_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)", id, acc, `wsp_${acc.slice(4)}`, kind, ref, bytes, at, released);
      db.run("INSERT INTO usage_events (id, account_id, idempotency_key, object_id, delta_bytes, reason, at) VALUES (?, ?, ?, ?, ?, 'test', ?)", `use_${++n}`, acc, `admit:${id}`, id, bytes, at);
      if (released) db.run("INSERT INTO usage_events (id, account_id, idempotency_key, object_id, delta_bytes, reason, at) VALUES (?, ?, ?, ?, ?, 'test', ?)", `use_${++n}`, acc, `release:${id}`, id, -bytes, released);
    };
    object("obj_s1", "acc_1", "record", "state:itm_1", 64);
    object("obj_c1", "acc_1", "capture", "cap_1", 900);
    object("obj_m1", "acc_1", "media", "med_1", 5000);
    object("obj_m2", "acc_1", "media", "med_2", 700);
    object("obj_m0", "acc_1", "media", "med_0", 300, "2026-10-02T00:00:00.000Z");
    object("obj_s2", "acc_2", "record", "state:itm_4", 64);
    object("obj_m3", "acc_2", "media", "med_3", 1000);
    object("obj_s3", "acc_3", "record", "state:none", 10);
    const used = (acc: string, bytes: number) => db.run("INSERT INTO storage_accounts (account_id, used_bytes) VALUES (?, ?)", acc, bytes);
    used("acc_1", 64 + 900 + 5000 + 700);
    used("acc_2", 64 + 1000);
    used("acc_3", 10);
    db.run("INSERT INTO reservations (id, account_id, bytes, purpose, idempotency_key, created_at, expires_at) VALUES ('rsv_open', 'acc_1', 3000, 'media', 'media:med_9', ?, '2099-01-01T00:00:00.000Z')", at);
    db.run("INSERT INTO reservations (id, account_id, bytes, purpose, idempotency_key, created_at, expires_at, settled_at) VALUES ('rsv_done', 'acc_1', 5000, 'media', 'media:med_1', ?, '2099-01-01T00:00:00.000Z', ?)", at, at);
    db.run("INSERT INTO reservations (id, account_id, bytes, purpose, idempotency_key, created_at, expires_at) VALUES ('rsv_text', 'acc_1', 400, 'capture', 'capture:cap_9', ?, '2099-01-01T00:00:00.000Z')", at);
    for (const [id, kind, status] of [["job_1", "media.save", "queued"], ["job_2", "media.save", "leased"], ["job_3", "media.save", "done"], ["job_4", "engine.sync", "queued"], ["job_5", "capture.fulltext", "queued"]] as const) {
      db.run("INSERT INTO jobs (id, account_id, workspace_id, kind, payload, status, run_after, created_at, updated_at) VALUES (?, 'acc_1', 'wsp_1', ?, '{}', ?, ?, ?, ?)", id, kind, status, at, at, at);
    }
    db.run("INSERT INTO playback_positions (item_id, account_id, workspace_id, position_seconds, duration_seconds, updated_at) VALUES ('itm_1', 'acc_1', 'wsp_1', 61.5, 1800, ?)", at);

    const ledger = (acc: string) => ({ ...db.get<{ events: number; objects: number; used: number }>(
      `SELECT (SELECT COALESCE(SUM(delta_bytes), 0) FROM usage_events WHERE account_id = ?1) AS events,
              (SELECT COALESCE(SUM(bytes), 0) FROM stored_objects WHERE account_id = ?1 AND released_at IS NULL) AS objects,
              (SELECT used_bytes FROM storage_accounts WHERE account_id = ?1) AS used`, acc)! });
    assert.deepEqual([ledger("acc_1"), ledger("acc_2"), ledger("acc_3")], [
      { events: 6664, objects: 6664, used: 6664 }, { events: 1064, objects: 1064, used: 1064 }, { events: 10, objects: 10, used: 10 }], "before: the ledger, the objects and the total agree");
    const others = { objects: db.all("SELECT * FROM stored_objects WHERE kind <> 'media' ORDER BY id"), released: db.get("SELECT * FROM stored_objects WHERE id = 'obj_m0'"),
      jobs: db.all("SELECT * FROM jobs WHERE kind <> 'media.save' ORDER BY id"), playback: db.all("SELECT * FROM playback_positions"),
      reservations: db.all("SELECT * FROM reservations WHERE id <> 'rsv_open' ORDER BY id"), events: db.all("SELECT * FROM usage_events ORDER BY id"),
      sources: db.all("SELECT id, account_id, workspace_id, kind, title, origin, created_at FROM sources ORDER BY id"), items: db.all("SELECT * FROM items ORDER BY id") };

    assert.equal(migrate(db), files.filter((f) => f >= "033").length);

    assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name = 'saved_media'"), undefined, "the saved-media table is gone");
    assert.deepEqual(db.all<{ name: string }>("SELECT name FROM pragma_table_info('sources')").map((c) => c.name).filter((c) => c.startsWith("save_media")), [], "and the two source columns");
    assert.deepEqual([ledger("acc_1"), ledger("acc_2"), ledger("acc_3")], [
      { events: 964, objects: 964, used: 964 }, { events: 64, objects: 64, used: 64 }, { events: 10, objects: 10, used: 10 }], "after: the saved files' bytes are released, and the ledger, the objects and the total still agree");
    assert.equal(db.get("SELECT 1 FROM stored_objects WHERE kind = 'media' AND released_at IS NULL"), undefined, "no live media object is left");
    assert.deepEqual(db.all<{ id: string }>("SELECT id FROM stored_objects WHERE kind = 'media' AND released_at IS NOT NULL ORDER BY id").map((r) => r.id), ["obj_m0", "obj_m1", "obj_m2", "obj_m3"], "released, not deleted: the history stays");
    assert.deepEqual(db.all<{ object_id: string; delta_bytes: number }>("SELECT object_id, delta_bytes FROM usage_events WHERE reason = 'saved media removed' ORDER BY object_id").map((r) => ({ ...r })),
      [{ object_id: "obj_m1", delta_bytes: -5000 }, { object_id: "obj_m2", delta_bytes: -700 }, { object_id: "obj_m3", delta_bytes: -1000 }], "one release event per file that was live; the one released earlier gets none");
    assert.deepEqual(db.all("SELECT * FROM stored_objects WHERE kind <> 'media' ORDER BY id"), others.objects, "no other stored object changed");
    assert.deepEqual(db.get("SELECT * FROM stored_objects WHERE id = 'obj_m0'"), others.released, "a file released earlier keeps its own release time");
    assert.deepEqual(db.all("SELECT * FROM usage_events WHERE reason <> 'saved media removed' ORDER BY id"), others.events, "the usage history is only added to");
    assert.equal(db.get<{ released_at: string | null }>("SELECT released_at FROM reservations WHERE id = 'rsv_open'")!.released_at !== null, true, "room reserved for a download is given back");
    assert.deepEqual(db.all("SELECT * FROM reservations WHERE id <> 'rsv_open' ORDER BY id"), others.reservations, "other reservations, settled ones included, stay");
    assert.deepEqual(db.all<{ id: string }>("SELECT id FROM jobs ORDER BY id").map((j) => j.id), ["job_4", "job_5"], "every media.save job is gone");
    assert.deepEqual(db.all("SELECT * FROM jobs ORDER BY id"), others.jobs, "other jobs are untouched");
    assert.deepEqual(db.all("SELECT * FROM playback_positions"), others.playback, "playback positions stay");
    assert.deepEqual(db.all("SELECT id, account_id, workspace_id, kind, title, origin, created_at FROM sources ORDER BY id"), others.sources, "sources are unchanged apart from the two columns");
    assert.deepEqual(db.all("SELECT * FROM items ORDER BY id"), others.items, "items are unchanged");
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.equal(db.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check, "ok");
    assert.equal(migrate(db), 0, "it doesn't run twice");
  } finally {
    db.close();
  }
});

test("035 keeps every stored object, its indexes and triggers while teaching the ledger the image kind, and marks no earlier capture as checked", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "035")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.run("INSERT INTO accounts (id, created_at) VALUES ('acc_1', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO workspaces (id, account_id, created_at) VALUES ('wsp_1', 'acc_1', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO items (id, account_id, workspace_id, kind, title, url, discovered_at, created_at, updated_at) VALUES ('itm_1', 'acc_1', 'wsp_1', 'article', 't', 'https://example.org/a', 'x', 'x', 'x')");
    db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, text, html, created_at, completed_at) VALUES ('cap_1', 'wsp_1', 'itm_1', 'fulltext', 'done', 'Text', '<p>Text</p>', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z')");
    db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, bytes, created_at) VALUES ('obj_1', 'acc_1', 'wsp_1', 'capture', 'cap_1', 'itm_1', 40, 'x')");
    db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, bytes, created_at, released_at) VALUES ('obj_2', 'acc_1', 'wsp_1', 'media', 'med_1', 'itm_1', 9, 'x', 'y')");
    const objects = () => db.all("SELECT * FROM stored_objects ORDER BY id");
    const before = objects();
    const schema = () => db.all<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (tbl_name = 'stored_objects' OR (type = 'trigger' AND tbl_name = 'items')) ORDER BY name");
    const schemaBefore = schema();
    assert.equal(migrate(db), files.filter((f) => f >= "035").length);

    assert.deepEqual(objects(), before, "every object survives the rebuild unchanged");
    assert.deepEqual(db.all("SELECT * FROM captures").map((c) => [(c as { quality: unknown }).quality, (c as { partial_reason: unknown }).partial_reason]), [[null, null]], "an earlier capture is not checked until the app checks it");
    assert.deepEqual(db.all("SELECT requested FROM captures").map((c) => (c as { requested: number }).requested), [0], "and was not asked for by the person, as far as is known");
    assert.throws(() => db.run("UPDATE captures SET requested = 2"), /CHECK/);
    db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, bytes, created_at) VALUES ('obj_3', 'acc_1', 'wsp_1', 'image', 'img_1', 'itm_1', 9, 'x')");
    assert.throws(() => db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, bytes, created_at) VALUES ('obj_4', 'acc_1', 'wsp_1', 'other', 'x', 1, 'x')"), /CHECK/);
    assert.throws(() => db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, bytes, created_at) VALUES ('obj_5', 'acc_1', 'wsp_1', 'image', 'img_1', 1, 'x')"), /UNIQUE/, "one live object per picture");
    assert.deepEqual(schema().filter((o) => o.type !== "table").map((o) => [o.type, o.name, o.sql]), schemaBefore.filter((o) => o.type !== "table").map((o) => [o.type, o.name, o.sql]), "indexes and triggers are as they were");

    // The checks on the new columns and the new table.
    assert.throws(() => db.run("UPDATE captures SET quality = 'maybe'"), /CHECK/);
    assert.throws(() => db.run("UPDATE captures SET partial_reason = 'rude'"), /CHECK/);
    db.run("INSERT INTO item_images (id, item_id, workspace_id, url, role, content_type, bytes, sha256, data, created_at) VALUES ('img_1', 'itm_1', 'wsp_1', 'https://p.example/1.png', 'cover', 'image/png', 3, 'x', x'010203', 'x')");
    assert.throws(() => db.run("INSERT INTO item_images (id, item_id, workspace_id, url, role, content_type, bytes, sha256, data, created_at) VALUES ('img_2', 'itm_1', 'wsp_1', 'https://p.example/1.png', 'inline', 'image/png', 3, 'x', x'010203', 'x')"), /UNIQUE/, "one copy per address and item");
    assert.throws(() => db.run("INSERT INTO item_images (id, item_id, workspace_id, url, role, content_type, bytes, sha256, data, created_at) VALUES ('img_3', 'itm_1', 'wsp_1', 'https://p.example/3.png', 'banner', 'image/png', 3, 'x', x'010203', 'x')"), /CHECK/);
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.equal(db.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check, "ok");
    assert.equal(migrate(db), 0);
  } finally {
    db.close();
  }
});

test("044 adds Pro: every account keeps its plan, the AI add-on becomes Pro, and Pro is accepted from then on", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "044")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    const at = "2026-01-01T00:00:00.000Z";
    for (const [id, plan, addon] of [["acc_free", "free", 0], ["acc_plus", "plus", 0], ["acc_free_ai", "free", 1], ["acc_plus_ai", "plus", 1], ["acc_unl_ai", "unlimited", 1], ["acc_self", null, 0]] as const) {
      db.run("INSERT INTO accounts (id, display_name, created_at, plan, ai_addon) VALUES (?, NULL, ?, ?, ?)", id, at, plan, addon);
    }
    db.run("INSERT INTO workspaces (id, account_id, created_at) VALUES ('wsp_1', 'acc_plus', ?)", at);

    assert.equal(migrate(db), files.filter((f) => f >= "044").length);
    assert.deepEqual(Object.fromEntries(db.all<{ id: string; plan: string | null }>("SELECT id, plan FROM accounts").map((r) => [r.id, r.plan])),
      { acc_free: "free", acc_plus: "plus", acc_free_ai: "pro", acc_plus_ai: "pro", acc_unl_ai: "unlimited", acc_self: null });
    assert.ok(!db.all<{ name: string }>("SELECT name FROM pragma_table_info('accounts')").some((c) => c.name === "ai_addon" || c.name === "plan_next"), "the add-on column is gone");
    db.run("UPDATE accounts SET plan = 'pro' WHERE id = 'acc_free'");
    assert.throws(() => db.run("UPDATE accounts SET plan = 'gold' WHERE id = 'acc_free'"), /CHECK/);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workspaces WHERE account_id = 'acc_plus'")!.n, 1, "what points at accounts still does");
  } finally {
    db.close();
  }
});

test("047 lifts the automatic 2 GiB allocation and its pause, and keeps limits an administrator chose", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "047")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.exec("PRAGMA foreign_keys = OFF");
    const add = (id: string, bytes: number | null, paused: string | null) =>
      db.run("INSERT INTO storage_accounts (account_id, allocation_bytes, paused_reason) VALUES (?, ?, ?)", id, bytes, paused);
    add("acc_default", 2 * 1024 ** 3, "quota");
    add("acc_chosen", 500 * 1024 ** 2, "quota");
    add("acc_disk", 2 * 1024 ** 3, "disk");
    add("acc_none", null, null);
    db.exec("PRAGMA foreign_keys = ON");

    migrate(db);
    const rows = db.all<{ account_id: string; allocation_bytes: number | null; paused_reason: string | null }>("SELECT * FROM storage_accounts ORDER BY account_id");
    assert.deepEqual(rows.map((r) => [r.account_id, r.allocation_bytes, r.paused_reason]), [
      ["acc_chosen", 500 * 1024 ** 2, "quota"],
      ["acc_default", null, null],
      ["acc_disk", null, "disk"],
      ["acc_none", null, null],
    ]);
  } finally {
    db.close();
  }
});

test("049 adds the discovery misses table beside existing data: one row per day, site and reason, and no account in it", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "049")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.run("INSERT INTO accounts (id, created_at) VALUES ('acc_1', '2026-01-01T00:00:00.000Z')");
    assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name = 'discovery_misses'"), undefined);

    assert.equal(migrate(db), files.filter((f) => f >= "049").length);
    assert.equal(db.get<{ strict: number }>("SELECT strict FROM pragma_table_list('discovery_misses')")!.strict, 1);
    assert.deepEqual(db.all<{ name: string }>("SELECT name FROM pragma_table_info('discovery_misses') ORDER BY cid").map((c) => c.name), ["day", "site", "reason", "count"],
      "only the day, the site, the reason and a count: nothing that names an account or what was pasted");
    assert.equal(db.all("SELECT 1 FROM pragma_foreign_key_list('discovery_misses')").length, 0);

    db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES ('2026-11-08', 'bandcamp.com', 'nofeed', 3)");
    db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES ('2026-11-08', 'bandcamp.com', 'timeout', 1), ('2026-11-09', 'bandcamp.com', 'nofeed', 1)");
    assert.throws(() => db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES ('2026-11-08', 'bandcamp.com', 'nofeed', 1)"), /UNIQUE/, "one row per day, site and reason");
    assert.throws(() => db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES ('2026-11-08', 'x.example', 'nofeed', 0)"), /CHECK/, "a row is a count of at least one");
    assert.throws(() => db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES ('2026-11-08', 'x.example', 'nofeed', 'many')"), /cannot store TEXT value in INTEGER column/);
    db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES ('2026-11-08', 'bandcamp.com', 'unsupported', 1) ON CONFLICT (day, site, reason) DO UPDATE SET count = count + 1");
    db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES ('2026-11-08', 'bandcamp.com', 'nofeed', 1) ON CONFLICT (day, site, reason) DO UPDATE SET count = count + 1");
    assert.equal(db.get<{ count: number }>("SELECT count FROM discovery_misses WHERE day = '2026-11-08' AND site = 'bandcamp.com' AND reason = 'nofeed'")!.count, 4);

    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n, 1, "accounts are untouched");
    assert.equal(migrate(db), 0, "and it does not run twice");
  } finally {
    db.close();
  }
});

test("050 and 052 remove a source's share of Home and the posting rate, and keep every source", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "050")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    const at = "2026-01-01T00:00:00.000Z";
    db.run("INSERT INTO accounts (id, display_name, created_at) VALUES ('acc_1', 'Ann', ?)", at);
    db.run("INSERT INTO workspaces (id, account_id, created_at) VALUES ('wsp_1', 'acc_1', ?)", at);
    for (const [id, share] of [["src_n", "normal"], ["src_m", "more"], ["src_f", "fewer"], ["src_o", "own"]] as const) {
      db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, created_at, home_share, posts_per_day) VALUES (?, 'acc_1', 'wsp_1', 'feed', ?, 'RSS feed', ?, ?, 30)", id, id, at, share);
    }

    assert.equal(migrate(db), files.filter((f) => f >= "050").length);
    assert.deepEqual(db.all<{ id: string }>("SELECT id FROM sources ORDER BY id").map((r) => r.id), ["src_f", "src_m", "src_n", "src_o"]);
    const cols = db.all<{ name: string }>("SELECT name FROM pragma_table_info('sources')").map((c) => c.name);
    assert.ok(!cols.includes("posts_per_day") && !cols.includes("home_share") && !cols.includes("home_share_next"), "the posting rate and the share of Home are gone");
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("051 keeps Smart filter usage on the server's key only and forgets the mark of a refused personal key", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "051")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    const at = "2026-01-01T00:00:00.000Z";
    db.run("INSERT INTO accounts (id, display_name, created_at) VALUES ('acc_1', 'Ann', ?)", at);
    db.run("INSERT INTO workspaces (id, account_id, created_at, ai_key_rejected) VALUES ('wsp_1', 'acc_1', ?, 1)", at);
    db.run("INSERT INTO ai_usage (account_id, month, route, input_tokens, requests) VALUES ('acc_1', '2026-11', 'own', 300, 2), ('acc_1', '2026-11', 'server', 150, 1), ('acc_1', '2026-10', 'own', 90, 1)");

    db.exec(readFileSync(path.join(DIR, "051_server_jev_key_only.sql"), "utf8")); // 051 alone: 053 later counts per week afresh
    assert.deepEqual(db.all<{ account_id: string; month: string; input_tokens: number; requests: number }>("SELECT * FROM ai_usage").map((r) => [r.account_id, r.month, r.input_tokens, r.requests]), [["acc_1", "2026-11", 150, 1]]);
    assert.ok(!db.all<{ name: string }>("SELECT name FROM pragma_table_info('workspaces')").some((c) => c.name === "ai_key_rejected"));
    assert.ok(!db.all<{ name: string }>("SELECT name FROM pragma_table_info('ai_usage')").some((c) => c.name === "route"));
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("053 counts Smart filter use per ISO week, starting afresh", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files.filter((f) => f < "053")) {
      db.exec(readFileSync(path.join(DIR, file), "utf8"));
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, "2026-01-01T00:00:00.000Z");
    }
    db.run("INSERT INTO accounts (id, display_name, created_at) VALUES ('acc_1', 'Ann', '2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO ai_usage (account_id, month, input_tokens, requests) VALUES ('acc_1', '2026-11', 300, 2)");

    assert.equal(migrate(db), files.filter((f) => f >= "053").length);
    assert.equal(db.all("SELECT 1 FROM ai_usage").length, 0, "monthly totals don't carry into a week");
    assert.deepEqual(db.all<{ name: string }>("SELECT name FROM pragma_table_info('ai_usage')").map((c) => c.name), ["account_id", "week", "input_tokens", "requests"]);
    db.run("INSERT INTO ai_usage (account_id, week, input_tokens, requests) VALUES ('acc_1', '2026-W46', 10, 1)");
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  } finally {
    db.close();
  }
});
