import Foundation
import UIKit
import BackgroundTasks
import WidgetKit

/// Who may write the widgets' data, and when (plan/38). Every write of the lists, the choices and the page's
/// snapshot happens under `lock`; a disconnect or a refused token bumps `generation` under it, so a refresh that
/// started before can't write the old account's titles back afterwards, and a refusal that arrives late can't wipe a
/// newer connection. The generation survives restarts: widgets set under an older one ask to be set again.
enum WidgetData {
    private static let lock = NSRecursiveLock()
    private static let generationKey = "app.purss.widget.generation"

    private static var currentGeneration: Int {
        UserDefaults.standard.integer(forKey: generationKey)
    }

    /// What a refresh or a setup reads when it starts.
    static var generation: Int {
        lock.lock(); defer { lock.unlock() }
        return currentGeneration
    }

    static func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    /// Writes a file into the app group's container, but only while nothing was wiped since `since` was read.
    @discardableResult
    static func writeIfCurrent(_ since: Int, _ name: String, _ data: Data) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard currentGeneration == since, let url = WidgetFiles.url(name) else { return false }
        do {
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    /// Everything of the account the widgets kept (the page's snapshot, the lists, the choices); nothing that started
    /// before may write any more. The widgets are redrawn, as *not connected*, and the refresh is no longer asked for.
    static func wipe() {
        lock.lock(); defer { lock.unlock() }
        UserDefaults.standard.set(currentGeneration + 1, forKey: generationKey)
        for name in [WidgetFiles.snapshotName, WidgetFiles.listsName, WidgetFiles.choicesName] {
            if let url = WidgetFiles.url(name) { try? FileManager.default.removeItem(at: url) }
        }
        WidgetCenter.shared.reloadAllTimelines()
        WidgetRefresh.cancelRequest()
    }

    /// The PURSS refused the token (401 `device_signed_out`) to a request made at `since`: nothing of the account stays
    /// with the native side, and the page runs its own *lost* path when it next starts. Ignored when a disconnect came
    /// in between (the refusal was the old connection's). Returns whether it was this connection's.
    @discardableResult
    static func lost(since: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard currentGeneration == since else { return false }
        DeviceStore.revoke()
        return true
    }
}

/// The widgets' lists, fetched by the app (plan/38): when the page asks (its items changed, it started), and from a
/// BGAppRefreshTask that asks the system for every 15 minutes while any widget is placed (the system decides when).
/// One refresh at a time; asking during one runs one more pass after it. The extension fetches nothing: it has no
/// credentials.
enum WidgetRefresh {
    static let taskIdentifier = "app.purss.widget-refresh"

    /// The choices file (what setup offers) is fetched again when it is older than this and the app is open.
    private static let choicesStaleAfter: TimeInterval = 15 * 60

    // MARK: The background task

    /// Registers the handler. Must run before the app finishes launching.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(refresh)
        }
    }

    /// Asks the system for a run 15 minutes from now (it decides when), when someone is connected and a widget of ours
    /// is placed; otherwise withdraws the request.
    static func schedule() {
        // After a refusal, nothing until the page has taken the report: it would only be refused again.
        if DeviceStore.isLost() { cancelRequest(); return }
        switch ConnectionKeychain.read() {
        case .missing:
            cancelRequest()
            return
        case .found, .unavailable:
            break
        }
        WidgetCenter.shared.getCurrentConfigurations { result in
            // When the system can't say, ask anyway: a run with nothing placed does nothing.
            if case .success(let placed) = result, placed.isEmpty {
                cancelRequest()
                return
            }
            let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
            request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
            do {
                try BGTaskScheduler.shared.submit(request)
            } catch {
                NSLog("PurssWidgets: the refresh could not be scheduled: \(error.localizedDescription)")
            }
        }
    }

    static func cancelRequest() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
    }

    private static func handle(_ task: BGAppRefreshTask) {
        let completion = BackgroundJob.Completion(task)
        let work = Task.detached(priority: .utility) {
            await run(inApp: false)
            schedule()
            completion.finish(success: true)
        }
        task.expirationHandler = {
            work.cancel()
            schedule()
            completion.finish(success: false)
        }
    }

    /// The page asked (`PurssDevice.refreshWidgets()`): the lists are fetched again soon, with the app open.
    static func requestFromApp() {
        schedule()
        Task.detached(priority: .utility) {
            await run(inApp: true)
        }
    }

    // MARK: One at a time

    private static let gate = NSLock()
    private static var busy = false
    private static var again = false
    private static var againInApp = false

    /// Takes the turn, or notes that another pass is wanted once the running one is done.
    private static func enter(inApp: Bool) -> Bool {
        gate.lock(); defer { gate.unlock() }
        if busy {
            again = true
            againInApp = againInApp || inApp
            return false
        }
        busy = true
        return true
    }

    /// Whether another pass was asked for while this one ran (and then whether the app asked); nil gives the turn up.
    private static func next() -> Bool? {
        gate.lock(); defer { gate.unlock() }
        if again {
            let inApp = againInApp
            again = false
            againInApp = false
            return inApp
        }
        busy = false
        return nil
    }

    private static func leave() {
        gate.lock(); defer { gate.unlock() }
        busy = false
        again = false
        againInApp = false
    }

    private enum Outcome {
        case done
        /// Nothing more to do now: not connected, refused, nothing placed, or cancelled.
        case stop
    }

    /// `inApp`: the page asked, so the app is open; the choices setup offers are kept up to date then too.
    static func run(inApp: Bool) async {
        guard enter(inApp: inApp) else { return }
        var pass = inApp
        while true {
            let outcome = await once(inApp: pass)
            if outcome == .stop || Task.isCancelled {
                leave()
                return
            }
            guard let more = next() else { return }
            pass = more
        }
    }

    // MARK: A pass

    private struct Placed {
        /// The keys of the fixed panels placed.
        var fixed: [String] = []
        /// The keys the placed Collection and Source widgets are set to (under the current generation).
        var chosen: [String] = []
        /// Any Collection or Source widget is placed, set or not.
        var configurable = false

        var isEmpty: Bool { fixed.isEmpty && !configurable }
    }

    /// What is placed now, or nil when the system can't say.
    private static func placedWidgets(generation: Int) async -> Placed? {
        let infos: [WidgetInfo]? = await withCheckedContinuation { (continuation: CheckedContinuation<[WidgetInfo]?, Never>) in
            WidgetCenter.shared.getCurrentConfigurations { result in
                switch result {
                case .success(let found): continuation.resume(returning: found)
                case .failure: continuation.resume(returning: nil)
                }
            }
        }
        guard let found = infos else { return nil }
        var placed = Placed()
        for info in found {
            if let key = WidgetKinds.fixedKey(info.kind) {
                placed.fixed.append(key)
                continue
            }
            guard info.kind == WidgetKinds.collection || info.kind == WidgetKinds.source else { continue }
            placed.configurable = true
            // A choice made under an older generation (another connection) is none: the widget asks to be set again.
            if let id = chosenId(info), let parsed = PanelChoiceId.parse(id), parsed.generation == generation,
               parsed.key.hasPrefix(info.kind == WidgetKinds.collection ? "collection:" : "source:") {
                placed.chosen.append(parsed.key)
            }
        }
        return placed
    }

    /// The id of the collection or source a placed widget is set to (see PanelChoiceId), if it is set.
    private static func chosenId(_ info: WidgetInfo) -> String? {
        guard #available(iOS 17.0, *) else { return nil }
        if info.kind == WidgetKinds.collection {
            return info.widgetConfigurationIntent(of: CollectionIntent.self)?.collection?.id
        }
        return info.widgetConfigurationIntent(of: SourceIntent.self)?.source?.id
    }

    private static func choicesAge() -> TimeInterval? {
        guard let url = WidgetFiles.url(WidgetFiles.choicesName),
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let modified = attributes[.modificationDate] as? Date else { return nil }
        return Date().timeIntervalSince(modified)
    }

    /// One fetch of everything the placed widgets show. Every write is under the generation the pass started with.
    private static func once(inApp: Bool) async -> Outcome {
        let since = WidgetData.generation
        if DeviceStore.isLost() { return .stop }
        let connection: Connection
        switch ConnectionKeychain.read() {
        case .found(let found):
            connection = found
        case .missing:
            NSLog("PurssWidgets: not connected")
            return .stop
        case .unavailable:
            // The keychain can't be read now (the device hasn't been unlocked since it started): the next run tries again.
            return .stop
        }
        // With the app open the choices setup offers are kept up to date even before any widget is placed.
        let seen = await placedWidgets(generation: since)
        let placed = seen ?? Placed()
        if placed.isEmpty && !inApp { return .stop }

        let wanted = Array(Set(placed.fixed + placed.chosen)).sorted()
        let choices = WidgetLists.decodeChoices(WidgetFiles.read(WidgetFiles.choicesName))
        let choicesCurrent = choices?.generation == since && (choicesAge().map { $0 < choicesStaleAfter } ?? false)
        // Names, and whether a chosen collection or source is still there, come from the PURSS's bootstrap; with the app
        // open it is also read for the choices setup offers.
        let needBootstrap = !placed.chosen.isEmpty || (inApp && (placed.configurable || !choicesCurrent))
        let old = WidgetLists.decode(WidgetFiles.read(WidgetFiles.listsName))
        if wanted.isEmpty && old.isEmpty && !needBootstrap { return .stop }

        let api = WorkspaceAPI(connection)
        do {
            var wrote = false
            var catalog: WidgetLists.Catalog?
            if needBootstrap {
                let answer = try await api.get("/api/bootstrap")
                if answer.status == 200, let parsed = WidgetLists.parseCatalog(answer.data) {
                    catalog = parsed
                    if let data = WidgetLists.encodeChoices(generation: since, catalog: parsed) {
                        wrote = WidgetData.writeIfCurrent(since, WidgetFiles.choicesName, data)
                    }
                }
            }
            var out: [String: WidgetLists.Stored] = [:]
            for key in wanted {
                try Task.checkCancellation()
                let chosen = WidgetLists.configurable(key)
                let name = chosen ? (catalog?.name(key) ?? old[key]?.name) : nil
                if chosen {
                    // A removed source stays readable by id, so the bootstrap decides whether it is there.
                    guard let fresh = catalog else {
                        if let kept = old[key] { out[key] = kept }
                        continue
                    }
                    let state = WidgetLists.chosenState(key, fresh)
                    if state != "ok" {
                        // A private source's name never shows on a home screen either.
                        out[key] = WidgetLists.Stored(rows: [], total: nil, state: state, name: state == "private" ? nil : name)
                        continue
                    }
                }
                guard let path = WidgetLists.path(key) else { continue }
                let answer = try await api.get(path)
                if answer.status == 200, let page = WidgetLists.parsePage(answer.data) {
                    out[key] = WidgetLists.Stored(rows: page.rows, total: page.total, state: "ok", name: name)
                } else if answer.status == 404 && chosen {
                    out[key] = WidgetLists.Stored(rows: [], total: nil, state: "gone", name: name)
                } else if let kept = old[key] {
                    // Busy or failing: the last list stays.
                    out[key] = kept
                }
            }
            try Task.checkCancellation()
            if !(out.isEmpty && old.isEmpty), let data = WidgetLists.encode(out) {
                if WidgetData.writeIfCurrent(since, WidgetFiles.listsName, data) { wrote = true }
            }
            if wrote { WidgetCenter.shared.reloadAllTimelines() }
            return .done
        } catch JobError.refused {
            NSLog("PurssWidgets: the workspace refused the token; removing what the app kept")
            // An old connection's refusal: a refresh asked for by the new one still runs.
            return WidgetData.lost(since: since) ? .stop : .done
        } catch is CancellationError {
            return .stop
        } catch {
            // Offline or the PURSS is busy: the last lists stay, and the next run tries again.
            NSLog("PurssWidgets: not refreshed")
            return .done
        }
    }
}
