import Foundation
import UIKit
import BackgroundTasks
import Network
import Security
import WidgetKit

/// The automatic downloads that run while the app is closed (plan/38): a BGProcessingTask that reads the device
/// token from the keychain, asks the PURSS what to fetch, and leaves the results in the downloads folder for the
/// page to adopt. The home-screen panels have their own refresh (WidgetRefresh).
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

    /// Completes a background task once, whichever of the run and the expiration comes first.
    final class Completion {
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

enum JobError: Error {
    case refused
    case status(Int)
    case network
}

struct Connection {
    let origin: URL
    let originText: String
    let token: String
}

enum ConnectionResult {
    case found(Connection)
    case missing
    /// The keychain can't be read now (the device hasn't been unlocked since it started).
    case unavailable
}

/// Reads the item `@aparajita/capacitor-secure-storage` keeps the connection in (KeychainSwift, no key prefix).
enum ConnectionKeychain {
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

/// Requests to the connected PURSS with the device token, from the background jobs. The token lives in this object
/// only, and its requests are never followed to another address.
final class WorkspaceAPI {
    struct Answer {
        let status: Int
        let data: Data
    }

    private let connection: Connection
    private let session: URLSession

    init(_ connection: Connection) {
        self.connection = connection
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }

    deinit {
        session.finishTasksAndInvalidate()
    }

    func get(_ path: String) async throws -> Answer {
        try await send("GET", path)
    }

    /// The PURSS's answer, whatever its status; a 401 `device_signed_out` is `JobError.refused`, a connection that
    /// fails `JobError.network`.
    func send(_ method: String, _ path: String, body: Data? = nil) async throws -> Answer {
        guard let url = URL(string: connection.originText + path) else { throw JobError.network }
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
            result = try await session.data(for: request)
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw JobError.network
        }
        let data = result.0
        let status = (result.1 as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 && SignedOut.says(data, code: "device_signed_out") { throw JobError.refused }
        return Answer(status: status, data: data)
    }
}

/// One run of the job. The token lives in this object only.
private final class JobRunner {
    private var connection: Connection!
    private var client: WorkspaceAPI!

    func run() async -> RunOutcome {
        // What the panels' data was when this run started: a refusal that comes in after a disconnect is the old connection's.
        let since = WidgetData.generation
        guard await JobRunner.inBackground() else { return .reschedule }

        switch ConnectionKeychain.read() {
        case .found(let found):
            connection = found
            client = WorkspaceAPI(found)
        case .missing:
            DeviceStore.clearState()
            BackgroundJob.cancelRequest()
            // Nothing is connected (or the page removed the token): nothing of the account stays in the panels either.
            WidgetData.wipe()
            return .stop
        case .unavailable:
            return .reschedule
        }
        guard let state = DeviceStore.readState() else { return .stop }
        guard DeviceStore.sameOrigin(state.origin, connection.originText) else { return .reschedule }

        do {
            try Task.checkCancellation()
            guard state.settings.autoToRead else { return .reschedule }
            guard await connectionAllowsDownloads(wifiOnly: state.settings.wifiOnly) else { return .reschedule }
            try await downloadPlanned(state)
            return .reschedule
        } catch JobError.refused {
            WidgetData.lost(since: since)
            return .stop
        } catch {
            return .reschedule
        }
    }

    // MARK: Requests

    private func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        let answer = try await client.send(method, path, body: body)
        guard (200...299).contains(answer.status) else { throw JobError.status(answer.status) }
        return answer.data
    }

    private static func inBackground() async -> Bool {
        await MainActor.run { UIApplication.shared.applicationState == .background }
    }

    private static func encode(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
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
