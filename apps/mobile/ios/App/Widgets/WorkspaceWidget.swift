import WidgetKit
import SwiftUI

/// The home-screen panels (plan/38): To read, To listen, New, a chosen collection and a chosen source. They draw
/// what the app keeps in the app group (`widget.json`: the page's look and episode; `widget-lists.json`: the lists
/// the app fetches; `widget-choices.json`: what the Collection and Source widgets can be set to). They hold no
/// credentials and ask the PURSS for nothing. Tapping a row opens `purss://open?item=<id>`, a heading
/// `purss://open?list=<key>`; there is no play/pause on iOS. A panel looks as Android's (Panels.kt): a header band
/// across the top with the app's logo, heading and count, and rows that begin with the source's avatar.

// MARK: Data

struct WidgetSnapshot: Decodable {
    struct Episode: Decodable {
        let id: String
        let title: String
        let sourceTitle: String
        let playing: Bool
        let positionSeconds: Int
    }
    let appearance: String
    let episode: Episode?
}

/// The panels, in the order the widget gallery lists them.
enum PanelKind {
    case toRead, toListen, new, collection, source

    var kind: String {
        switch self {
        case .toRead: return WidgetKinds.toRead
        case .toListen: return WidgetKinds.toListen
        case .new: return WidgetKinds.new
        case .collection: return WidgetKinds.collection
        case .source: return WidgetKinds.source
        }
    }

    var heading: String {
        switch self {
        case .toRead: return "To read"
        case .toListen: return "To listen"
        case .new: return "New"
        case .collection: return "Collection"
        case .source: return "Source"
        }
    }

    var about: String {
        switch self {
        case .toRead: return "The items you marked To read"
        case .toListen: return "Your To read podcast episodes and the one you're listening to"
        case .new: return "New items from all your sources"
        case .collection: return "The newest items of a collection you choose"
        case .source: return "The newest items of a source you choose"
        }
    }

    /// The list the panel always shows; nil for the collection and source panels.
    var key: String? {
        switch self {
        case .toRead: return "toread"
        case .toListen: return "tolisten"
        case .new: return "new"
        case .collection, .source: return nil
        }
    }

    /// What a chosen list's key starts with.
    var keyPrefix: String {
        self == .collection ? "collection:" : "source:"
    }

    var empty: String {
        switch self {
        case .toRead: return "Nothing To read."
        case .toListen: return "Nothing To listen to."
        case .new: return "Nothing New."
        case .collection, .source: return "Nothing here yet."
        }
    }

    // A tap can't open the picker on iOS: the widget is edited from its touch-and-hold menu.
    var choose: String {
        self == .collection ? "Edit this widget to choose a collection." : "Edit this widget to choose a source."
    }

    var gone: String {
        self == .collection
            ? "This collection is gone. Edit this widget to choose another."
            : "You don't follow this source any more. Edit this widget to choose another."
    }

    static let privateSource = "This source is private, so it isn't shown on the home screen. Edit this widget to choose another."
    static let notConnected = "Open the app to connect it to your PURSS."
    static let loading = "Loading…"
}

struct PanelEntry: TimelineEntry {
    let date: Date
    let panel: PanelKind
    /// The page's snapshot; nil when none was written (not connected) or it is damaged.
    let snapshot: WidgetSnapshot?
    /// The list shown; nil for a collection or source panel that has no usable choice.
    let key: String?
    /// The chosen collection's or source's name as the choice carried it.
    let chosenName: String?
    /// The stored list for `key`, when the app has fetched it.
    let list: WidgetLists.Stored?

    /// The text shown instead of rows, or nil when there are rows.
    var message: String? {
        if snapshot == nil { return PanelKind.notConnected }
        if key == nil { return panel.choose }
        guard let list = list else { return PanelKind.loading }
        switch list.state {
        case "gone": return panel.gone
        case "private": return PanelKind.privateSource
        case "loading": return list.rows.isEmpty ? PanelKind.loading : nil
        default: return list.rows.isEmpty ? panel.empty : nil
        }
    }

    /// Whether the list itself is shown (a chosen one may be gone or private).
    var showsRows: Bool {
        guard snapshot != nil, key != nil, let list = list else { return false }
        return list.state != "gone" && list.state != "private"
    }

    var rows: [WidgetLists.Row] {
        showsRows ? (list?.rows ?? []) : []
    }

    var heading: String {
        list?.state == "private" ? panel.heading : (list?.name ?? chosenName ?? panel.heading)
    }

    var total: Int64? {
        showsRows ? list?.total : nil
    }

    /// The current or last played episode above the To listen list.
    var episode: WidgetSnapshot.Episode? {
        panel == .toListen && WidgetLists.isId(snapshot?.episode?.id ?? "") ? snapshot?.episode : nil
    }

    /// Where the heading leads: the list, when there is one worth opening.
    var listURL: URL? {
        guard showsRows, let key = key else { return nil }
        return WidgetLinks.list(key)
    }

    static func placeholder(_ panel: PanelKind) -> PanelEntry {
        let rows = ["A headline that might be here", "Another one, a little longer than the first", "And a third"].enumerated().map { index, title in
            WidgetLists.Row(id: "placeholder\(index)", title: title, sourceTitle: "Source", at: nil)
        }
        return PanelEntry(date: Date(), panel: panel, snapshot: WidgetSnapshot(appearance: "system", episode: nil),
                          key: panel.key ?? "placeholder", chosenName: nil, list: WidgetLists.Stored(rows: rows, total: nil, state: "ok", name: nil))
    }
}

/// Where the panels' taps lead, encoded as the page's encodeURIComponent does.
enum WidgetLinks {
    private static func encoded(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    static func item(_ id: String) -> URL? {
        URL(string: "purss://open?item=\(encoded(id))")
    }

    static func list(_ key: String) -> URL? {
        URL(string: "purss://open?list=\(encoded(key))")
    }
}

enum PanelData {
    /// The widget's own refresh: the app reloads the timelines whenever it writes; this is only a fallback.
    private static let refreshAfter: TimeInterval = 30 * 60

    static func snapshot() -> WidgetSnapshot? {
        guard let data = WidgetFiles.read(WidgetFiles.snapshotName) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }

    /// The entry for a panel. A collection or source panel passes what it was set to; a setting made under an older
    /// choices file (another connection) or for the other kind counts as none.
    static func entry(_ panel: PanelKind, chosen: (id: String, name: String)?, at date: Date) -> PanelEntry {
        var key = panel.key
        var name: String?
        if panel.key == nil, let chosen = chosen, let parsed = PanelChoiceId.parse(chosen.id), parsed.key.hasPrefix(panel.keyPrefix),
           let current = WidgetLists.decodeChoices(WidgetFiles.read(WidgetFiles.choicesName))?.generation, current == parsed.generation {
            key = parsed.key
            name = chosen.name.isEmpty ? nil : chosen.name
        }
        let list = key.flatMap { WidgetLists.decode(WidgetFiles.read(WidgetFiles.listsName))[$0] }
        return PanelEntry(date: date, panel: panel, snapshot: snapshot(), key: key, chosenName: name, list: list)
    }

    static func timeline(_ entry: PanelEntry) -> Timeline<PanelEntry> {
        Timeline(entries: [entry], policy: .after(entry.date.addingTimeInterval(refreshAfter)))
    }
}

// MARK: Providers

/// To read, To listen and New: one list each, nothing to choose.
struct FixedPanelProvider: TimelineProvider {
    let panel: PanelKind

    func placeholder(in context: TimelineProviderContext) -> PanelEntry {
        PanelEntry.placeholder(panel)
    }

    func getSnapshot(in context: TimelineProviderContext, completion: @escaping (PanelEntry) -> Void) {
        completion(PanelData.entry(panel, chosen: nil, at: Date()))
    }

    func getTimeline(in context: TimelineProviderContext, completion: @escaping (Timeline<PanelEntry>) -> Void) {
        completion(PanelData.timeline(PanelData.entry(panel, chosen: nil, at: Date())))
    }
}

@available(iOS 17.0, *)
struct CollectionProvider: AppIntentTimelineProvider {
    func placeholder(in context: TimelineProviderContext) -> PanelEntry {
        PanelEntry.placeholder(.collection)
    }

    func snapshot(for configuration: CollectionIntent, in context: TimelineProviderContext) async -> PanelEntry {
        PanelData.entry(.collection, chosen: configuration.collection.map { (id: $0.id, name: $0.name) }, at: Date())
    }

    func timeline(for configuration: CollectionIntent, in context: TimelineProviderContext) async -> Timeline<PanelEntry> {
        PanelData.timeline(PanelData.entry(.collection, chosen: configuration.collection.map { (id: $0.id, name: $0.name) }, at: Date()))
    }
}

@available(iOS 17.0, *)
struct SourceProvider: AppIntentTimelineProvider {
    func placeholder(in context: TimelineProviderContext) -> PanelEntry {
        PanelEntry.placeholder(.source)
    }

    func snapshot(for configuration: SourceIntent, in context: TimelineProviderContext) async -> PanelEntry {
        PanelData.entry(.source, chosen: configuration.source.map { (id: $0.id, name: $0.name) }, at: Date())
    }

    func timeline(for configuration: SourceIntent, in context: TimelineProviderContext) async -> Timeline<PanelEntry> {
        PanelData.timeline(PanelData.entry(.source, chosen: configuration.source.map { (id: $0.id, name: $0.name) }, at: Date()))
    }
}

// MARK: Look

/// A colour from its 0xRRGGBB value.
private func hex(_ rgb: UInt32) -> Color {
    Color(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
}

/// The app's colours: accent HSL(212, 82%, 40%) in light, accent ink HSL(212, 92%, 79%) in dark; e-ink is black on white.
/// The header band is the app's card header (a soft tint from top to bottom with a line under it), as on Android.
private struct Palette {
    let background: Color
    let primary: Color
    let secondary: Color
    let accent: Color
    let line: Color
    let bandTop: Color
    let bandBottom: Color
    let bandLine: Color
    let dark: Bool
    let eink: Bool

    init(dark: Bool, eink: Bool) {
        self.dark = dark
        self.eink = eink
        if eink {
            background = .white; primary = .black; secondary = .black; accent = .black; line = .black
            bandTop = .white; bandBottom = .white; bandLine = .black
        } else if dark {
            background = Color(red: 0.09, green: 0.10, blue: 0.12)
            primary = Color(red: 0.94, green: 0.95, blue: 0.96)
            secondary = Color(red: 0.94, green: 0.95, blue: 0.96).opacity(0.65)
            accent = Color(red: 0.596, green: 0.776, blue: 0.984)
            line = Color(red: 0.184, green: 0.208, blue: 0.235)
            bandTop = hex(0x273545); bandBottom = hex(0x212B36); bandLine = hex(0x354150)
        } else {
            background = .white
            primary = Color(red: 0.09, green: 0.10, blue: 0.12)
            secondary = Color(red: 0.09, green: 0.10, blue: 0.12).opacity(0.62)
            accent = Color(red: 0.071, green: 0.376, blue: 0.729)
            line = Color(red: 0.863, green: 0.890, blue: 0.918)
            bandTop = hex(0xF7FBFF); bandBottom = hex(0xE5F0FD); bandLine = hex(0xD3DFEE)
        }
    }

    /// An avatar's colours for a hue (0...359): a tint of it with a darker ink in light, a deep tint with a pale ink in dark;
    /// e-ink is black on white. The border is the ink at 25% (black in e-ink).
    func face(hue: Int) -> (background: Color, ink: Color, border: Color) {
        if eink { return (Color.white, Color.black, Color.black) }
        let h = Double(hue) / 360
        let ink = dark ? Color(hue: h, saturation: 0.18, brightness: 0.94) : Color(hue: h, saturation: 0.75, brightness: 0.36)
        let tint = dark ? Color(hue: h, saturation: 0.35, brightness: 0.32) : Color(hue: h, saturation: 0.10, brightness: 0.98)
        return (tint, ink, ink.opacity(0.25))
    }
}

/// A source's avatar as the app makes it (apps/web/src/components/item-bits.tsx initialsOf and hashHue), and as
/// Android's Panels.kt does. A source with no title is a link the person saved by hand.
private enum SourceFace {
    static func name(_ sourceTitle: String) -> String {
        sourceTitle.isEmpty ? "Saved link" : sourceTitle
    }

    /// What the app's `[^\p{L}\p{N} ]` keeps: letters and numbers.
    private static func keeps(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            return true
        default:
            return false
        }
    }

    /// The first letter of the first word and of the second (or else the second letter of the first), upper case.
    /// A name with no letter or number is "?". The app takes UTF-16 units where this takes whole characters, which
    /// differs only for a letter outside the Basic Multilingual Plane (the app's unit is half a character).
    static func initials(_ name: String) -> String {
        var words: [[Unicode.Scalar]] = []
        var word: [Unicode.Scalar] = []
        for scalar in name.unicodeScalars {
            if keeps(scalar) {
                word.append(scalar)
            } else if !word.isEmpty {
                words.append(word)
                word = []
            }
        }
        if !word.isEmpty { words.append(word) }
        guard let first = words.first else { return "?" }
        var text = String(Character(first[0]))
        if words.count > 1 {
            text.append(Character(words[1][0]))
        } else if first.count > 1 {
            text.append(Character(first[1]))
        }
        return text.uppercased()
    }

    /// The stable hue, 0...359: 31 times the hash so far plus each UTF-16 unit, modulo 2^32, then modulo 360.
    static func hue(_ name: String) -> Int {
        var h: UInt32 = 0
        for unit in name.utf16 { h = h &* 31 &+ UInt32(unit) }
        return Int(h % 360)
    }
}

/// The panels keep their own space (`side`, as Android's 14 dp) and lay out edge to edge, so that the header band
/// reaches the widget's edges. iOS 17 and later keep a margin around a widget's content, earlier systems keep none:
/// on iOS 17 the panels take the system's margins back with negative padding of exactly their size (`MarginBleed`).
private enum Metrics {
    static let side: CGFloat = 14
    static let rowGap: CGFloat = 6
}

@available(iOS 17.0, *)
private struct MarginBleed<Content: View>: View {
    @Environment(\.widgetContentMargins) private var margins
    let content: Content

    var body: some View {
        content.padding(EdgeInsets(top: -margins.top, leading: -margins.leading, bottom: -margins.bottom, trailing: -margins.trailing))
    }
}

private func clock(_ seconds: Int) -> String {
    let s = max(0, seconds)
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

private let relativeFormatter: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter
}()

/// How long ago, short ("3 hr. ago"); empty for a time that isn't one.
private func age(_ at: String?, now: Date) -> String {
    guard let at = at, let date = WidgetLists.date(at) else { return "" }
    if now.timeIntervalSince(date) < 60 { return "now" }
    return relativeFormatter.localizedString(for: date, relativeTo: now)
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

    /// Fills the whole widget, taking back the margin iOS 17 and later keep around the content (see `Metrics`).
    @ViewBuilder
    func bleedsIntoMargins() -> some View {
        if #available(iOS 17.0, *) {
            MarginBleed(content: self)
        } else {
            self
        }
    }
}

// MARK: Views

/// A source's initials on a tinted rounded square, as the app's avatars (packages/ui primitives.css .av).
private struct Avatar: View {
    let name: String
    let palette: Palette

    private var face: (background: Color, ink: Color, border: Color) {
        palette.face(hue: SourceFace.hue(name))
    }

    var body: some View {
        Text(SourceFace.initials(name))
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(face.ink)
            .lineLimit(1)
            .frame(width: 28, height: 28)
            .background(RoundedRectangle(cornerRadius: 8).fill(face.background))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(face.border, lineWidth: 1))
            .accessibilityHidden(true)
    }
}

/// A title over its source and age. `avatarName` is the source an avatar is drawn for (the episode and the small
/// widget have none).
private struct RowView: View {
    let title: String
    let meta: String
    let palette: Palette
    let avatarName: String?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            if let avatarName = avatarName {
                Avatar(name: avatarName, palette: palette)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(palette.primary)
                    .lineLimit(2)
                if !meta.isEmpty {
                    Text(meta)
                        .font(.caption2)
                        .foregroundColor(palette.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(meta.isEmpty ? title : "\(title), \(meta)")
    }
}

private struct PanelView: View {
    let entry: PanelEntry
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
            .widgetURL(entry.listURL)
    }

    /// Links work in the medium and large widgets only; the small one opens its list as a whole (widgetURL).
    private var linksWork: Bool {
        family != .systemSmall
    }

    /// The small widget is too narrow for an avatar beside a title.
    private var showsAvatars: Bool {
        family != .systemSmall
    }

    /// The height of a row whose title takes two lines (its source line below), the tallest a row gets, at the current
    /// text size; the number of rows shown is counted with it so that none is cut off.
    @ScaledMetric(relativeTo: .caption) private var rowHeight: CGFloat = 46

    /// How many list rows fit `height`: under the episode block (a row's height and its line, when there is one),
    /// and always at least one when there is no episode.
    private func rowsFit(_ height: CGFloat) -> Int {
        var free = height
        if entry.episode != nil { free -= rowHeight + 1 + 2 * Metrics.rowGap }
        let fit = Int(((free + Metrics.rowGap) / (rowHeight + Metrics.rowGap)).rounded(.down))
        return max(entry.episode == nil ? 1 : 0, fit)
    }

    @ViewBuilder
    private func content(_ palette: Palette) -> some View {
        if entry.snapshot == nil {
            Text(PanelKind.notConnected)
                .font(.footnote.weight(.semibold))
                .foregroundColor(palette.primary)
                .multilineTextAlignment(.center)
                .padding(Metrics.side)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .bleedsIntoMargins()
        } else if #available(iOS 16.0, *), family == .accessoryRectangular {
            accessory
        } else {
            panel(palette)
                .bleedsIntoMargins()
        }
    }

    /// The header on its band: the app's logo, the heading in the accent colour and the count in secondary ink.
    @ViewBuilder
    private func header(_ palette: Palette) -> some View {
        let line = HStack(spacing: 8) {
            Image(decorative: "PanelLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 22, height: 22)
                .clipShape(Circle())
                .accessibilityHidden(true)
            Text(entry.heading)
                .font(.subheadline.weight(.bold))
                .foregroundColor(palette.accent)
                .lineLimit(1)
            if let total = entry.total {
                Text("\(total)")
                    .font(.footnote)
                    .foregroundColor(palette.secondary)
                    .layoutPriority(1)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        let band = line
            .padding(EdgeInsets(top: 12, leading: Metrics.side, bottom: 10, trailing: Metrics.side))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(LinearGradient(gradient: Gradient(colors: [palette.bandTop, palette.bandBottom]), startPoint: .top, endPoint: .bottom))
        if linksWork, let url = entry.listURL {
            Link(destination: url) { band }
        } else {
            band
        }
    }

    @ViewBuilder
    private func episodeBlock(_ episode: WidgetSnapshot.Episode, _ palette: Palette) -> some View {
        let status = episode.playing ? "Playing" : (episode.positionSeconds > 0 ? "Paused at \(clock(episode.positionSeconds))" : "Paused")
        let meta = [episode.sourceTitle, status].filter { !$0.isEmpty }.joined(separator: " · ")
        let block = RowView(title: episode.title, meta: meta, palette: palette, avatarName: nil)
        if linksWork, let url = WidgetLinks.item(episode.id) {
            Link(destination: url) { block }
        } else {
            block
        }
        Rectangle().fill(palette.line).frame(height: 1)
    }

    @ViewBuilder
    private func rowView(_ row: WidgetLists.Row, _ palette: Palette) -> some View {
        let meta = [row.sourceTitle, age(row.at, now: entry.date)].filter { !$0.isEmpty }.joined(separator: ", ")
        let view = RowView(title: row.title, meta: meta, palette: palette, avatarName: showsAvatars ? SourceFace.name(row.sourceTitle) : nil)
        if linksWork, let url = WidgetLinks.item(row.id) {
            Link(destination: url) { view }
        } else {
            view
        }
    }

    /// The episode (To listen), then the message or the rows, as many as fit.
    private func list(_ palette: Palette) -> some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: Metrics.rowGap) {
                if let episode = entry.episode {
                    episodeBlock(episode, palette)
                }
                if let message = entry.message {
                    Text(message)
                        .font(.footnote)
                        .foregroundColor(palette.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                        .multilineTextAlignment(.center)
                }
                ForEach(Array(entry.rows.prefix(rowsFit(geometry.size.height))), id: \.id) { row in
                    rowView(row, palette)
                }
                Spacer(minLength: 0)
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
        .padding(EdgeInsets(top: 6, leading: Metrics.side, bottom: 6, trailing: Metrics.side))
    }

    /// The header band across the top (a line under it), the list below it.
    private func panel(_ palette: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(palette)
            Rectangle().fill(palette.bandLine).frame(height: 1)
            list(palette)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The lock screen's small rectangle: the heading with its count, and the first title.
    @ViewBuilder
    private var accessory: some View {
        let first = entry.episode.map { ($0.title, $0.sourceTitle) } ?? entry.rows.first.map { ($0.title, $0.sourceTitle) }
        VStack(alignment: .leading, spacing: 1) {
            Text(entry.total.map { "\(entry.heading) \($0)" } ?? entry.heading)
                .font(.caption.weight(.bold))
                .lineLimit(1)
            if let first = first {
                Text(first.0).font(.caption).lineLimit(2)
                    .accessibilityLabel(first.1.isEmpty ? first.0 : "\(first.0), from \(first.1)")
            } else {
                Text(entry.message ?? entry.panel.empty).font(.caption).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: Widgets

private enum PanelFamilies {
    static var all: [WidgetFamily] {
        var all: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]
        if #available(iOS 16.0, *) { all.append(.accessoryRectangular) }
        return all
    }
}

/// To read (its kind unchanged, so copies placed before stay), To listen and New.
struct FixedPanelWidget: Widget {
    let panel: PanelKind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: panel.kind, provider: FixedPanelProvider(panel: panel)) { entry in
            PanelView(entry: entry)
        }
        .configurationDisplayName(LocalizedStringKey(panel.heading))
        .description(LocalizedStringKey(panel.about))
        .supportedFamilies(PanelFamilies.all)
    }
}

@available(iOS 17.0, *)
struct CollectionWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: PanelKind.collection.kind, intent: CollectionIntent.self, provider: CollectionProvider()) { entry in
            PanelView(entry: entry)
        }
        .configurationDisplayName(LocalizedStringKey(PanelKind.collection.heading))
        .description(LocalizedStringKey(PanelKind.collection.about))
        .supportedFamilies(PanelFamilies.all)
    }
}

@available(iOS 17.0, *)
struct SourceWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: PanelKind.source.kind, intent: SourceIntent.self, provider: SourceProvider()) { entry in
            PanelView(entry: entry)
        }
        .configurationDisplayName(LocalizedStringKey(PanelKind.source.heading))
        .description(LocalizedStringKey(PanelKind.source.about))
        .supportedFamilies(PanelFamilies.all)
    }
}

@main
struct WorkspaceWidgetBundle: WidgetBundle {
    var body: some Widget {
        FixedPanelWidget(panel: .toRead)
        FixedPanelWidget(panel: .toListen)
        FixedPanelWidget(panel: .new)
        // Choosing a collection or source needs an App Intent configuration, which starts with iOS 17.
        if #available(iOS 17.0, *) {
            CollectionWidget()
            SourceWidget()
        }
    }
}
