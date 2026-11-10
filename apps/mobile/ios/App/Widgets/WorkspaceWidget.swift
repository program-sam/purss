import WidgetKit
import SwiftUI

/// The home-screen widget (plan/38): the next To read items and the current or last episode, drawn from the
/// snapshot the app and its background job keep in the app group (`widget.json`, apps/web/src/device/widget.ts).
/// It holds no credentials. Tapping a row opens `purss://open?item=<id>`; there is no play/pause on iOS.

// MARK: Snapshot

struct WidgetSnapshot: Decodable {
    struct Row: Decodable {
        let id: String
        let title: String
        let sourceTitle: String
    }
    struct Episode: Decodable {
        let id: String
        let title: String
        let sourceTitle: String
        let playing: Bool
        let positionSeconds: Int
    }
    let appearance: String
    let toRead: [Row]
    let toReadTotal: Int?
    let episode: Episode?
}

struct WorkspaceEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct WorkspaceProvider: TimelineProvider {
    private static let appGroupId = "group.app.purss"

    func placeholder(in context: Context) -> WorkspaceEntry {
        WorkspaceEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (WorkspaceEntry) -> Void) {
        completion(WorkspaceEntry(date: Date(), snapshot: Self.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WorkspaceEntry>) -> Void) {
        let entry = WorkspaceEntry(date: Date(), snapshot: Self.read())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(30 * 60))))
    }

    /// The snapshot, or nil when none was written (not connected) or it is damaged.
    private static func read() -> WidgetSnapshot? {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)?.appendingPathComponent("widget.json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}

// MARK: Look

/// The app's colours: accent HSL(212, 82%, 40%) in light, accent ink HSL(212, 92%, 79%) in dark; e-ink is black on white.
private struct Palette {
    let background: Color
    let primary: Color
    let secondary: Color
    let accent: Color
    let eink: Bool

    init(dark: Bool, eink: Bool) {
        self.eink = eink
        if eink {
            background = .white; primary = .black; secondary = .black; accent = .black
        } else if dark {
            background = Color(red: 0.09, green: 0.10, blue: 0.12)
            primary = Color(red: 0.94, green: 0.95, blue: 0.96)
            secondary = Color(red: 0.94, green: 0.95, blue: 0.96).opacity(0.65)
            accent = Color(red: 0.596, green: 0.776, blue: 0.984)
        } else {
            background = .white
            primary = Color(red: 0.09, green: 0.10, blue: 0.12)
            secondary = Color(red: 0.09, green: 0.10, blue: 0.12).opacity(0.62)
            accent = Color(red: 0.071, green: 0.376, blue: 0.729)
        }
    }
}

/// The address a widget opens for an item, encoded as the page's encodeURIComponent does.
private func openLink(_ id: String) -> URL? {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-_.!~*'()")
    return URL(string: "purss://open?item=\(id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id)")
}

private func clock(_ seconds: Int) -> String {
    let s = max(0, seconds)
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

private extension View {
    @ViewBuilder
    func widgetBackground(_ color: Color) -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(color, for: .widget)
        } else {
            background(color)
        }
    }
}

// MARK: Views

private struct RowView: View {
    let title: String
    let source: String
    let detail: String?
    let titleLines: Int
    let palette: Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundColor(palette.primary)
                .lineLimit(titleLines)
                .fixedSize(horizontal: false, vertical: true)
            Text(detail.map { source.isEmpty ? $0 : "\(source) · \($0)" } ?? source)
                .font(.caption2)
                .foregroundColor(palette.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(source.isEmpty ? title : "\(title), from \(source)")
    }
}

private struct WorkspaceWidgetView: View {
    let entry: WorkspaceEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var systemScheme

    private var forcedScheme: ColorScheme? {
        switch entry.snapshot?.appearance {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    var body: some View {
        let eink = entry.snapshot?.appearance == "eink"
        let scheme = eink ? ColorScheme.light : (forcedScheme ?? systemScheme)
        let palette = Palette(dark: scheme == .dark, eink: eink)
        content(palette)
            .environment(\.colorScheme, scheme)
            .widgetBackground(palette.background)
            .widgetURL(primaryLink)
    }

    /// Small and accessory widgets can't hold separate links: the whole widget opens the first row.
    private var primaryLink: URL? {
        guard let snapshot = entry.snapshot else { return nil }
        if let episode = snapshot.episode { return openLink(episode.id) }
        return snapshot.toRead.first.flatMap { openLink($0.id) }
    }

    @ViewBuilder
    private func content(_ palette: Palette) -> some View {
        if let snapshot = entry.snapshot {
            if #available(iOS 16.0, *), family == .accessoryRectangular {
                accessory(snapshot)
            } else {
                list(snapshot, palette)
            }
        } else {
            Text("Open the app to connect")
                .font(.footnote.weight(.semibold))
                .foregroundColor(palette.primary)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .multilineTextAlignment(.center)
        }
    }

    private func heading(_ snapshot: WidgetSnapshot, _ palette: Palette) -> some View {
        HStack(spacing: 4) {
            Text("To read")
                .font(.footnote.weight(.bold))
                .foregroundColor(palette.accent)
            if let total = snapshot.toReadTotal {
                Text("\(total)")
                    .font(.footnote)
                    .foregroundColor(palette.secondary)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private func list(_ snapshot: WidgetSnapshot, _ palette: Palette) -> some View {
        let small = family == .systemSmall
        let slots = small ? 3 : 4
        let rows = Array(snapshot.toRead.prefix(max(0, slots - (snapshot.episode == nil ? 0 : 1))))
        // Three small rows get one title line each so that all of them fit; fewer get two.
        let shown = rows.count + (snapshot.episode == nil ? 0 : 1)
        let titleLines = small && shown < 3 ? 2 : 1
        return VStack(alignment: .leading, spacing: 4) {
            heading(snapshot, palette)
            if let episode = snapshot.episode, let link = openLink(episode.id) {
                Link(destination: link) {
                    RowView(title: episode.title, source: episode.sourceTitle,
                            detail: "\(episode.playing ? "Playing" : "Paused") \(clock(episode.positionSeconds))",
                            titleLines: titleLines, palette: palette)
                }
            }
            if rows.isEmpty && snapshot.episode == nil {
                Text("Nothing To read")
                    .font(.footnote)
                    .foregroundColor(palette.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
            ForEach(rows, id: \.id) { row in
                if let link = openLink(row.id) {
                    Link(destination: link) {
                        RowView(title: row.title, source: row.sourceTitle, detail: nil, titleLines: titleLines, palette: palette)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func accessory(_ snapshot: WidgetSnapshot) -> some View {
        let first = snapshot.episode.map { ($0.title, $0.sourceTitle) } ?? snapshot.toRead.first.map { ($0.title, $0.sourceTitle) }
        VStack(alignment: .leading, spacing: 1) {
            Text(snapshot.toReadTotal.map { "To read \($0)" } ?? "To read")
                .font(.caption.weight(.bold))
            if let first = first {
                Text(first.0).font(.caption).lineLimit(2)
                    .accessibilityLabel(first.1.isEmpty ? first.0 : "\(first.0), from \(first.1)")
            } else {
                Text("Nothing To read").font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct WorkspaceWidget: Widget {
    private var families: [WidgetFamily] {
        var all: [WidgetFamily] = [.systemSmall, .systemMedium]
        if #available(iOS 16.0, *) { all.append(.accessoryRectangular) }
        return all
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "WorkspaceWidget", provider: WorkspaceProvider()) { entry in
            WorkspaceWidgetView(entry: entry)
        }
        .configurationDisplayName("To read")
        .description("The next items to read and the episode you are on.")
        .supportedFamilies(families)
    }
}

@main
struct WorkspaceWidgetBundle: WidgetBundle {
    var body: some Widget {
        WorkspaceWidget()
    }
}
