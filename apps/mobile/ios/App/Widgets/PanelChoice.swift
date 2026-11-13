import Foundation
import AppIntents
import WidgetKit

/// What a Collection or Source widget is set to (plan/38). Compiled into the widget extension, which offers the
/// choice, and into the app, which reads each placed widget's choice (`WidgetCenter.getCurrentConfigurations`) to know
/// which lists to fetch. The choices come from `widget-choices.json`, written by the app from the PURSS's own answer
/// (private sources left out); the extension never asks the PURSS for anything.

/// An entity's id carries the key and the generation of the choices file it was picked from: `<generation>|<key>`.
/// After a disconnect or a refused token the generation changes, and a widget set before it asks to be set again.
enum PanelChoiceId {
    static func make(generation: Int, key: String) -> String {
        "\(generation)|\(key)"
    }

    /// The generation and the (collection or source) key in an id, or nil when it isn't one.
    static func parse(_ id: String) -> (generation: Int, key: String)? {
        guard let bar = id.firstIndex(of: "|"), let generation = Int(id[id.startIndex..<bar]) else { return nil }
        let key = String(id[id.index(after: bar)...])
        guard WidgetLists.isKey(key), WidgetLists.configurable(key) else { return nil }
        return (generation, key)
    }
}

/// A collection a widget can show. An empty `name` means the choices file no longer lists it.
@available(iOS 17.0, *)
struct CollectionChoice: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Collection"
    static var defaultQuery = CollectionChoiceQuery()

    var id: String
    var name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name.isEmpty ? "Unavailable" : name)")
    }
}

@available(iOS 17.0, *)
struct CollectionChoiceQuery: EntityQuery {
    func entities(for identifiers: [CollectionChoice.ID]) async throws -> [CollectionChoice] {
        let choices = WidgetLists.decodeChoices(WidgetFiles.read(WidgetFiles.choicesName))
        return identifiers.compactMap { id -> CollectionChoice? in
            guard let parsed = PanelChoiceId.parse(id), parsed.key.hasPrefix("collection:") else { return nil }
            let known = choices?.collections.first(where: { $0.key == parsed.key })
            return CollectionChoice(id: id, name: known?.name ?? "")
        }
    }

    func suggestedEntities() async throws -> [CollectionChoice] {
        guard let choices = WidgetLists.decodeChoices(WidgetFiles.read(WidgetFiles.choicesName)) else { return [] }
        return choices.collections.map { CollectionChoice(id: PanelChoiceId.make(generation: choices.generation, key: $0.key), name: $0.name) }
    }
}

/// The Collection widget's setting. Not offered to Shortcuts: it only configures the widget.
@available(iOS 17.0, *)
struct CollectionIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Collection"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Collection")
    var collection: CollectionChoice?
}

/// A followed source a widget can show (never a private one). An empty `name` means the choices file no longer lists it.
@available(iOS 17.0, *)
struct SourceChoice: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Source"
    static var defaultQuery = SourceChoiceQuery()

    var id: String
    var name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name.isEmpty ? "Unavailable" : name)")
    }
}

@available(iOS 17.0, *)
struct SourceChoiceQuery: EntityQuery {
    func entities(for identifiers: [SourceChoice.ID]) async throws -> [SourceChoice] {
        let choices = WidgetLists.decodeChoices(WidgetFiles.read(WidgetFiles.choicesName))
        return identifiers.compactMap { id -> SourceChoice? in
            guard let parsed = PanelChoiceId.parse(id), parsed.key.hasPrefix("source:") else { return nil }
            let known = choices?.sources.first(where: { $0.key == parsed.key })
            return SourceChoice(id: id, name: known?.name ?? "")
        }
    }

    func suggestedEntities() async throws -> [SourceChoice] {
        guard let choices = WidgetLists.decodeChoices(WidgetFiles.read(WidgetFiles.choicesName)) else { return [] }
        return choices.sources.map { SourceChoice(id: PanelChoiceId.make(generation: choices.generation, key: $0.key), name: $0.name) }
    }
}

/// The Source widget's setting.
@available(iOS 17.0, *)
struct SourceIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Source"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Source")
    var source: SourceChoice?
}
