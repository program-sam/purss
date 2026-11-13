import Foundation

/// The home-screen panels' lists (plan/38), the same rules as Android's WidgetLists.kt. Compiled into the app,
/// which fetches the lists, and into the widget extension, which draws them. A list key is `toread`, `tolisten`,
/// `new`, `collection:<id>` or `source:<id>`; each has one request (the table in apps/mobile/widget-lists.json).
/// Lists hold titles, ids and dates: never the token or the PURSS's address, and never items of private sources
/// (`exceptPrivate=1`).

/// The `kind` of each widget the extension offers. The first widget's kind stays as it was, so a copy placed before
/// the panels existed keeps working as the To read panel.
enum WidgetKinds {
    static let toRead = "WorkspaceWidget"
    static let toListen = "ToListenWidget"
    static let new = "NewWidget"
    static let collection = "CollectionWidget"
    static let source = "SourceWidget"

    /// The list a widget of this kind always shows; nil for the collection and source widgets (they show the one chosen).
    static func fixedKey(_ kind: String) -> String? {
        switch kind {
        case toRead: return "toread"
        case toListen: return "tolisten"
        case new: return "new"
        default: return nil
        }
    }
}

/// The files the app writes into the app group's container and the extension reads. Never the token or the
/// PURSS's address.
enum WidgetFiles {
    /// Must match the App and Widgets entitlements and `plugins.CapacitorShareTarget.appGroupId` in capacitor.config.ts.
    static let appGroupId = "group.app.purss"
    /// The page's part: look and episode (apps/web/src/device/widget.ts). Absent when not connected.
    static let snapshotName = "widget.json"
    /// The lists, by key (WidgetLists.encode).
    static let listsName = "widget-lists.json"
    /// What a Collection or Source widget can be set to (WidgetLists.encodeChoices).
    static let choicesName = "widget-choices.json"

    static func url(_ name: String) -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)?.appendingPathComponent(name)
    }

    static func read(_ name: String) -> Data? {
        guard let url = url(name) else { return nil }
        return try? Data(contentsOf: url)
    }
}

enum WidgetLists {
    /// The most rows a panel keeps.
    static let rows = 8
    private static let limit = 10

    // MARK: Keys

    static func isKey(_ key: String) -> Bool {
        if key == "toread" || key == "tolisten" || key == "new" { return true }
        for prefix in ["collection:", "source:"] where key.hasPrefix(prefix) {
            let id = Array(key.utf8.dropFirst(prefix.utf8.count))
            return (1...64).contains(id.count) && id.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x5f }
        }
        return false
    }

    static func configurable(_ key: String) -> Bool {
        key.hasPrefix("collection:") || key.hasPrefix("source:")
    }

    /// An item id as the PURSS makes them (`itm_…`).
    static func isId(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        return (1...64).contains(bytes.count) && bytes.allSatisfy {
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x5f || $0 == 0x2d
        }
    }

    /// The request for a list, or nil for anything that isn't a key.
    static func path(_ key: String) -> String? {
        guard isKey(key) else { return nil }
        let tail = "&limit=\(limit)&exceptPrivate=1"
        switch key {
        case "toread": return "/api/items?scope=toread&filter=active&sort=newest&type=articles,videos" + tail
        case "tolisten": return "/api/items?scope=toread&filter=active&sort=oldest&type=podcasts" + tail
        case "new": return "/api/items?scope=all&filter=fresh&sort=newest" + tail
        default: return "/api/items?scope=" + key.replacingOccurrences(of: ":", with: "%3A") + "&filter=active&sort=newest" + tail
        }
    }

    // MARK: Lists

    struct Row {
        let id: String
        let title: String
        let sourceTitle: String
        /// When the item was published, else when the PURSS found it (an ISO time).
        let at: String?
    }

    /// A list as stored. `state`: `ok`; `loading` (chosen, not fetched yet); `gone` (the chosen collection or source is
    /// no longer in the PURSS); `private` (the chosen source is private, so nothing of it shows on a home screen).
    /// `name` is the chosen collection's or source's name, nil for the fixed lists.
    struct Stored {
        let rows: [Row]
        let total: Int64?
        let state: String
        let name: String?
    }

    static func clip(_ s: String) -> String {
        s.count > 200 ? String(s.prefix(199)) + "…" : s
    }

    /// The answer of a list request: up to `rows` rows (items whose id couldn't be a plain id left out) and the
    /// total when the PURSS says it. Nil when the answer isn't a page.
    static func parsePage(_ data: Data) -> (rows: [Row], total: Int64?)? {
        guard let page = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let items = page["items"] as? [[String: Any]] else { return nil }
        var found: [Row] = []
        for item in items {
            guard let id = item["id"] as? String, isId(id) else { continue }
            let title = (item["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let at: String?
            if let published = item["publishedAt"] as? String {
                at = published
            } else if let discovered = item["discoveredAt"] as? String, !discovered.isEmpty {
                at = discovered
            } else {
                at = nil
            }
            found.append(Row(id: id, title: clip(title.isEmpty ? "Untitled" : title), sourceTitle: clip(item["sourceTitle"] as? String ?? ""), at: at))
            if found.count == rows { break }
        }
        return (found, (page["total"] as? NSNumber)?.int64Value)
    }

    private static func orNull<T>(_ value: T?) -> Any {
        value.map { $0 as Any } ?? NSNull()
    }

    /// The lists as the file keeps them: `{"<key>": {"rows": [{id, title, sourceTitle, at}], "total", "state", "name"}}`.
    static func encode(_ lists: [String: Stored]) -> Data? {
        var object: [String: Any] = [:]
        for (key, stored) in lists where isKey(key) {
            let rows: [[String: Any]] = stored.rows.map { row in
                ["id": row.id, "title": row.title, "sourceTitle": row.sourceTitle, "at": orNull(row.at)]
            }
            object[key] = ["rows": rows, "total": orNull(stored.total), "state": stored.state, "name": orNull(stored.name)] as [String: Any]
        }
        return try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    /// The stored lists; damaged entries and unknown keys are left out.
    static func decode(_ data: Data?) -> [String: Stored] {
        guard let data = data, let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        var lists: [String: Stored] = [:]
        for (key, value) in object where isKey(key) {
            guard let entry = value as? [String: Any], let rawRows = entry["rows"] as? [[String: Any]] else { continue }
            var rows: [Row] = []
            var damaged = false
            for raw in rawRows {
                guard let id = raw["id"] as? String else { damaged = true; break }
                if isId(id) { rows.append(Row(id: id, title: raw["title"] as? String ?? "", sourceTitle: raw["sourceTitle"] as? String ?? "", at: raw["at"] as? String)) }
            }
            if damaged { continue }
            lists[key] = Stored(rows: rows, total: (entry["total"] as? NSNumber)?.int64Value, state: entry["state"] as? String ?? "ok", name: entry["name"] as? String)
        }
        return lists
    }

    // MARK: Collections and sources

    struct Choice {
        let key: String
        let name: String
    }

    /// What the PURSS's `/api/bootstrap` says about collections and followed sources, reduced to keys and names:
    /// the widgets' setup lists and the check that a chosen one still exists. Private sources are kept here (in
    /// `privateSources`) so a chosen source that became private can say so; setup leaves them out.
    struct Catalog {
        let collections: [Choice]
        let sources: [Choice]
        let privateSources: Set<String>

        func name(_ key: String) -> String? {
            (collections + sources).first(where: { $0.key == key })?.name
        }

        /// `collection` or `source`: what setup offers; sources without the private ones.
        func choices(_ kind: String) -> [Choice] {
            kind == "collection" ? collections : sources.filter { !privateSources.contains($0.key) }
        }
    }

    static func parseCatalog(_ data: Data) -> Catalog? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let rawCollections = object["collections"] as? [[String: Any]] ?? []
        let rawSources = object["sources"] as? [[String: Any]] ?? []
        var collections: [Choice] = []
        for entry in rawCollections {
            let key = "collection:" + (entry["id"] as? String ?? "")
            guard isKey(key) else { continue }
            let emoji = entry["emoji"] as? String ?? ""
            let name = [emoji, entry["name"] as? String ?? ""].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: " ")
            collections.append(Choice(key: key, name: clip(name)))
        }
        var sources: [Choice] = []
        var privateSources = Set<String>()
        for entry in rawSources {
            let key = "source:" + (entry["id"] as? String ?? "")
            guard isKey(key) else { continue }
            sources.append(Choice(key: key, name: clip(entry["title"] as? String ?? "")))
            if entry["kind"] as? String == "private" { privateSources.insert(key) }
        }
        sources.sort { a, b in
            let x = a.name.lowercased(), y = b.name.lowercased()
            return x == y ? a.key < b.key : x < y
        }
        return Catalog(collections: collections, sources: sources, privateSources: privateSources)
    }

    /// A chosen list's state from the catalog: gone when the PURSS no longer has it, private for a private source.
    static func chosenState(_ key: String, _ catalog: Catalog) -> String {
        if catalog.name(key) == nil { return "gone" }
        if catalog.privateSources.contains(key) { return "private" }
        return "ok"
    }

    /// What a Collection or Source widget can be set to, as the file keeps it. `generation` changes whenever the
    /// account's data is wiped (a disconnect or a refused token): a widget set under an older one asks to be set again.
    struct Choices {
        let generation: Int
        let collections: [Choice]
        let sources: [Choice]
    }

    /// `{"generation": n, "collections": [{key, name}], "sources": [{key, name}]}`, the private sources left out.
    static func encodeChoices(generation: Int, catalog: Catalog) -> Data? {
        func list(_ choices: [Choice]) -> [[String: String]] {
            choices.map { ["key": $0.key, "name": $0.name] }
        }
        let object: [String: Any] = ["generation": generation, "collections": list(catalog.choices("collection")), "sources": list(catalog.choices("source"))]
        return try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    static func decodeChoices(_ data: Data?) -> Choices? {
        guard let data = data, let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let generation = (object["generation"] as? NSNumber)?.intValue else { return nil }
        func list(_ name: String) -> [Choice] {
            (object[name] as? [[String: Any]] ?? []).compactMap { entry -> Choice? in
                guard let key = entry["key"] as? String, isKey(key), let title = entry["name"] as? String else { return nil }
                return Choice(key: key, name: title)
            }
        }
        return Choices(generation: generation, collections: list("collections"), sources: list("sources"))
    }

    // MARK: Times

    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let withoutFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// An ISO time as the PURSS writes it (`2026-11-12T09:30:00.000Z`, or with an offset or without the fraction); nil for anything else.
    static func date(_ iso: String) -> Date? {
        withFraction.date(from: iso) ?? withoutFraction.date(from: iso)
    }
}
