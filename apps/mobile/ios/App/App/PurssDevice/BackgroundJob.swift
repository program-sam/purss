import Foundation
import UIKit
import BackgroundTasks
import Network
import Security
import WidgetKit

/// The automatic downloads and widget refresh that run while the app is closed (plan/38): a BGProcessingTask
/// that reads the device token from the keychain, asks the PURSS what to fetch, and leaves the results in
/// the downloads folder for the page to adopt.
enum BackgroundJob {
    /// Registers the handler. Must run before the app finishes launching.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: DeviceStore.taskIdentifier, using: nil) { task in
            guard let processing = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(processing)
        }
    }

    /// Asks the system for a run an hour from now, when there is state to work from.
    static func schedule() {
        guard DeviceStore.readState() != nil else { return }
        let request = BGProcessingTaskRequest(identifier: DeviceStore.taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            NSLog("PurssDevice: the background run could not be scheduled: \(error.localizedDescription)")
        }
    }

    static func cancelRequest() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: DeviceStore.taskIdentifier)
    }

    private final class Completion {
        private let lock = NSLock()
        private var done = false
        private let task: BGTask
        init(_ task: BGTask) { self.task = task }
        func finish(success: Bool) {
            lock.lock()
            let first = !done
            done = true
            lock.unlock()
            if first { task.setTaskCompleted(success: success) }
        }
    }

    private static func handle(_ task: BGProcessingTask) {
        let completion = Completion(task)
        let work = Task.detached(priority: .utility) {
            let outcome = await JobRunner().run()
            if outcome == .reschedule { schedule() }
            completion.finish(success: true)
        }
        task.expirationHandler = {
            work.cancel()
            schedule()
            completion.finish(success: false)
        }
    }
}

private enum RunOutcome {
    /// Another run is wanted later.
    case reschedule
    /// Nothing more to do: disconnected, refused or never set up.
    case stop
}

private enum JobError: Error {
    case refused
    case status(Int)
    case network
}

private struct Connection {
    let origin: URL
    let originText: String
    let token: String
}

private enum ConnectionResult {
    case found(Connection)
    case missing
    /// The keychain can't be read now (the device hasn't been unlocked since it started).
    case unavailable
}

/// Reads the item `@aparajita/capacitor-secure-storage` keeps the connection in (KeychainSwift, no key prefix).
private enum ConnectionKeychain {
    static func read() -> ConnectionResult {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: "capacitor-storage_purss.connection",
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess, let data = result as? Data else { return .unavailable }
        guard let connection = parse(data) else { return .missing }
        return .found(connection)
    }

    /// `{"origin":"…","token":"…"}`, or that text stored once more as a JSON string.
    private static func parse(_ data: Data) -> Connection? {
        var json = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        if let text = json as? String, let inner = text.data(using: .utf8) {
            json = try? JSONSerialization.jsonObject(with: inner)
        }
        guard let dict = json as? [String: Any], let origin = dict["origin"] as? String, let token = dict["token"] as? String, !token.isEmpty else { return nil }
        var text = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host != nil else { return nil }
        return Connection(origin: url, originText: text, token: token)
    }
}

/// One run of the job. The token lives in this object only.
private final class JobRunner {
    private let api: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        // Its requests carry the device token: never followed to another address.
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }()
    private var connection: Connection!

    func run() async -> RunOutcome {
        guard await JobRunner.inBackground() else { return .reschedule }

        switch ConnectionKeychain.read() {
        case .found(let found):
            connection = found
        case .missing:
            DeviceStore.clearState()
            BackgroundJob.cancelRequest()
            return .stop
        case .unavailable:
            return .reschedule
        }
        guard let state = DeviceStore.readState() else { return .stop }
        guard DeviceStore.sameOrigin(state.origin, connection.originText) else { return .reschedule }

        do {
            if await refreshWidget() { return .stop }
            try Task.checkCancellation()
            guard state.settings.autoToRead else { return .reschedule }
            guard await connectionAllowsDownloads(wifiOnly: state.settings.wifiOnly) else { return .reschedule }
            try await downloadPlanned(state)
            return .reschedule
        } catch JobError.refused {
            DeviceStore.revoke()
            return .stop
        } catch {
            return .reschedule
        }
    }

    // MARK: Requests

    private func url(_ path: String) -> URL? {
        URL(string: connection.originText + path)
    }

    private func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        guard let url = url(path) else { throw JobError.network }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let result: (Data, URLResponse)
        do {
            result = try await api.data(for: request)
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw JobError.network
        }
        let data = result.0
        let status = (result.1 as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 && SignedOut.says(data, code: "device_signed_out") { throw JobError.refused }
        guard (200...299).contains(status) else { throw JobError.status(status) }
        return data
    }

    private static func inBackground() async -> Bool {
        await MainActor.run { UIApplication.shared.applicationState == .background }
    }

    private static func encode(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }

    // MARK: Widget

    /// Replaces the To read part of the widget's snapshot with a fresh list. True when the token was refused
    /// (everything is already wiped and the run ends).
    private func refreshWidget() async -> Bool {
        guard var snapshot = DeviceStore.readWidget() else { return false }
        let data: Data
        do {
            data = try await call("GET", "/api/items?scope=toread&filter=active&sort=newest&limit=5&exceptPrivate=1")
        } catch JobError.refused {
            DeviceStore.revoke()
            return true
        } catch {
            return false
        }
        guard let page = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let items = page["items"] as? [[String: Any]] else { return false }
        func clip(_ s: String) -> String { s.count > 200 ? String(s.prefix(199)) + "…" : s }
        snapshot["toRead"] = items.prefix(5).compactMap { item -> [String: String]? in
            guard let id = item["id"] as? String else { return nil }
            let title = (item["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return ["id": id, "title": clip(title.isEmpty ? "Untitled" : title), "sourceTitle": clip(item["sourceTitle"] as? String ?? "")]
        }
        if let total = page["total"] as? NSNumber {
            snapshot["toReadTotal"] = total
        } else {
            snapshot["toReadTotal"] = NSNull()
        }
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        snapshot["updatedAt"] = stamp.string(from: Date())
        if let out = try? JSONSerialization.data(withJSONObject: snapshot) { try? DeviceStore.writeWidget(out) }
        return false
    }

    // MARK: Downloads

    private func connectionAllowsDownloads(wifiOnly: Bool) async -> Bool {
        let path = await JobRunner.currentPath()
        guard path.status == .satisfied else { return false }
        return !wifiOnly || path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
    }

    private static func currentPath() async -> NWPath {
        await withCheckedContinuation { (continuation: CheckedContinuation<NWPath, Never>) in
            let monitor = NWPathMonitor()
            let lock = NSLock()
            var resumed = false
            monitor.pathUpdateHandler = { path in
                lock.lock()
                let first = !resumed
                resumed = true
                lock.unlock()
                if first {
                    monitor.cancel()
                    continuation.resume(returning: path)
                }
            }
            monitor.start(queue: DispatchQueue(label: "app.purss.downloads.path"))
        }
    }

    private struct Plan: Decodable { let items: [PlanItem] }
    private struct PlanItem: Decodable {
        let id: String
        let media: PlanMedia
    }
    private struct PlanMedia: Decodable {
        let kind: String
        let url: String?
        let type: String?
        let declaredBytes: Double?
        let file: String
    }

    private func downloadPlanned(_ state: BackgroundState) async throws {
        let body: [String: Any] = [
            "autoToRead": state.settings.autoToRead,
            "limitBytes": state.limit,
            "usedBytes": state.used,
            "have": state.have,
        ]
        let data = try await call("POST", "/api/downloads/plan", body: try JSONSerialization.data(withJSONObject: body))
        guard let plan = try? JSONDecoder().decode(Plan.self, from: data) else { return }

        let running = await BackgroundTransfers.shared.activeItemIds()
        for planned in plan.items {
            try Task.checkCancellation()
            guard await JobRunner.inBackground() else { return }
            guard !running.contains(planned.id) else { continue }
            try await fetch(planned, state: state)
        }
    }

    /// One item: its text, then its file, then a record. Anything that stops the item before it has a title
    /// (no item.json, no connection) leaves nothing behind.
    private func fetch(_ planned: PlanItem, state: BackgroundState) async throws {
        guard DeviceStore.isSafeComponent(planned.id), DeviceStore.isSafeComponent(planned.media.file), DeviceStore.isSafeComponent(state.accountId) else { return }
        var meta = TransferMeta(
            accountId: state.accountId, itemId: planned.id, file: planned.media.file, max: 0, origin: connection.originText,
            mediaKind: planned.media.kind, mediaType: planned.media.type)
        guard Staging.reset(meta) else { return }
        let staging = Staging.folder(meta)
        do {
            let id = JobRunner.encode(planned.id)
            let itemData: Data
            do {
                itemData = try await call("GET", "/api/items/\(id)")
            } catch JobError.status(_) {
                Staging.remove(meta)
                return
            }
            try itemData.write(to: staging.appendingPathComponent("item.json"), options: .atomic)
            let item = (try? JSONSerialization.jsonObject(with: itemData)) as? [String: Any]
            if let annotated = item?["annotatedAt"], !(annotated is NSNull) {
                let annotations = try await call("GET", "/api/items/\(id)/annotations")
                try annotations.write(to: staging.appendingPathComponent("annotations.json"), options: .atomic)
            }

            // The file's address: always the publisher's https file (the PURSS keeps none).
            guard let text = planned.media.url, text.lowercased().hasPrefix("https://"), let address = URL(string: text) else {
                Staging.finishFailed(meta, status: -1)
                return
            }

            let fresh = DeviceStore.readState() ?? state
            let room = min(Int64(4) * 1024 * 1024 * 1024, fresh.limit - fresh.used)
            meta.max = room
            if room <= 0 || (planned.media.declaredBytes.map { $0 > Double(room) } ?? false) {
                Staging.finishFailed(meta, status: -2)
                return
            }
            var request = URLRequest(url: address)
            if fresh.settings.wifiOnly {
                request.allowsCellularAccess = false
                request.allowsExpensiveNetworkAccess = false
            }
            await BackgroundTransfers.shared.transfer(request, meta: meta)
        } catch {
            Staging.remove(meta)
            throw error
        }
    }
}
