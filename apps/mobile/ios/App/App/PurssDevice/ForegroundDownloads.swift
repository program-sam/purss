import Foundation
import Capacitor

/// The page's downloads: one background URLSession, so a transfer goes on while the app is suspended or
/// closed (and iOS relaunches the app to finish it). What a task needs to finish without the page is in its
/// `taskDescription`; the finished file is moved to its path (through `<path>.part`). Asked again for the same
/// path, a finished file answers at once and a transfer under way is joined. A transfer the connection or the
/// system cut off keeps its resume data as `<path>.resume`, and the next one for that path continues from it.
/// Each task carries the generation it was made in; stopping everything (disconnect, a refused token) moves to a
/// new generation at once, so a task of the old one that still finishes publishes nothing.
final class ForegroundDownloads: NSObject, URLSessionDownloadDelegate {
    static let shared = ForegroundDownloads()
    static let identifier = "app.purss.downloads.page"

    private enum Failure {
        case http(Int)
        case network
        case tooLarge
        case cancelled
        case io(String)
    }

    private struct Meta: Codable {
        var path: String
        var max: Int64
        var generation: String
    }

    private static let generationKey = "purss.page-downloads.generation"

    /// Held while the generation changes and while a file or resume data is published after checking it, so a
    /// disconnect that deletes the downloads right after changing it never sees an old task's file land afterwards.
    private static let publishing = NSLock()

    private static func rotateGeneration() {
        publishing.lock(); defer { publishing.unlock() }
        UserDefaults.standard.set(UUID().uuidString, forKey: generationKey)
    }

    /// The generation tasks are made in now; kept, as tasks outlive the app.
    private static var generation: String {
        if let g = UserDefaults.standard.string(forKey: generationKey) { return g }
        let g = UUID().uuidString
        UserDefaults.standard.set(g, forKey: generationKey)
        return g
    }

    private struct Waiter {
        let id: String
        let call: CAPPluginCall
    }

    private let lock = NSLock()
    /// Page calls waiting for a path.
    private var waiters: [String: [Waiter]] = [:]
    /// Paths a task is being made for (between the task list being read and the task resuming).
    private var starting = Set<String>()
    private var failures: [Int: Failure] = [:]
    private var finished: [Int: Int64] = [:]
    private var stoppedByHand = Set<Int>()
    /// Paths cancelled while their task was being made: it is never resumed.
    private var cancelledStarting = Set<String>()
    private var lastEmit: [Int: TimeInterval] = [:]
    private var eventsCompletion: (() -> Void)?
    /// The plugin's progress events: (call id, bytes, total or -1).
    var onProgress: ((String, Int64, Int64) -> Void)?

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: ForegroundDownloads.identifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    /// Creates the session at launch, so transfers that ended while the app was away report at once.
    func wake() {
        lock.lock(); defer { lock.unlock() }
        _ = session
    }

    /// The system relaunched the app for transfers that ended: recreating the session delivers their events.
    func attach(completionHandler: @escaping () -> Void) {
        lock.lock()
        eventsCompletion = completionHandler
        _ = session
        lock.unlock()
    }

    /// A relative path under the downloads folder, or nil when it has an empty segment, `.`, `..` or starts with `/`.
    static func destination(for path: String) -> URL? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, parts.allSatisfy({ DeviceStore.isSafeComponent($0) }) else { return nil }
        return parts.reduce(DeviceStore.downloadsDirectory) { $0.appendingPathComponent($1) }
    }

    private static func resumeFile(_ destination: URL) -> URL { destination.appendingPathExtension("resume") }

    private static func size(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
    }

    private static func meta(of task: URLSessionTask) -> Meta? {
        guard let text = task.taskDescription, let data = text.data(using: .utf8),
              let meta = try? JSONDecoder().decode(Meta.self, from: data), destination(for: meta.path) != nil else { return nil }
        return meta
    }

    func start(id: String, url: URL, path: String, maxBytes: Int64, call: CAPPluginCall) {
        guard let destination = ForegroundDownloads.destination(for: path) else {
            call.reject("The path must be relative, without empty segments or '..'.", "io")
            return
        }
        lock.lock()
        if waiters[path] != nil || starting.contains(path) {
            waiters[path, default: []].append(Waiter(id: id, call: call))
            lock.unlock()
            return
        }
        starting.insert(path)
        waiters[path] = [Waiter(id: id, call: call)]
        let session = self.session
        lock.unlock()
        session.getAllTasks { tasks in
            let underWay = tasks.first { task in
                ForegroundDownloads.meta(of: task)?.path == path && (task.state == .running || task.state == .suspended)
            }
            if underWay != nil {
                self.lock.lock()
                self.starting.remove(path)
                self.cancelledStarting.remove(path)
                self.lock.unlock()
                return
            }
            let fm = FileManager.default
            if fm.fileExists(atPath: destination.path) {
                let size = ForegroundDownloads.size(destination)
                if size > maxBytes { try? fm.removeItem(at: destination) }
                self.settle(path: path, failure: size > maxBytes ? .tooLarge : nil, bytes: size)
                return
            }
            guard let description = try? JSONEncoder().encode(Meta(path: path, max: maxBytes, generation: ForegroundDownloads.generation)), let text = String(data: description, encoding: .utf8) else {
                self.settle(path: path, failure: .io("The download couldn't be described."), bytes: 0)
                return
            }
            let resume = ForegroundDownloads.resumeFile(destination)
            let task: URLSessionDownloadTask
            if let data = try? Data(contentsOf: resume) {
                try? fm.removeItem(at: resume)
                task = session.downloadTask(withResumeData: data)
            } else {
                task = session.downloadTask(with: url)
            }
            task.taskDescription = text
            self.lock.lock()
            self.starting.remove(path)
            let cancelled = self.cancelledStarting.remove(path) != nil
            self.lock.unlock()
            if cancelled {
                task.cancel()
                self.settle(path: path, failure: .cancelled, bytes: 0)
                return
            }
            task.resume()
        }
    }

    /// Stops the transfers into `name` (a path, a folder under it, or "" for all) or asked for by a call with that id;
    /// their partial files and resume data go, and their calls hear "cancelled". `done` runs once every such task is
    /// marked, so none of them moves a file into place afterwards.
    func cancel(name: String, done: @escaping () -> Void) {
        func matches(_ path: String) -> Bool { name.isEmpty || path == name || path.hasPrefix(name + "/") }
        lock.lock()
        let byId = Set(waiters.filter { $0.value.contains { $0.id == name } }.keys)
        for path in starting where matches(path) || byId.contains(path) { cancelledStarting.insert(path) }
        let session = self.session
        lock.unlock()
        session.getAllTasks { tasks in
            for task in tasks {
                guard let meta = ForegroundDownloads.meta(of: task), matches(meta.path) || byId.contains(meta.path) else { continue }
                self.lock.lock()
                self.stoppedByHand.insert(task.taskIdentifier)
                self.lock.unlock()
                task.cancel()
            }
            if !name.isEmpty, let destination = ForegroundDownloads.destination(for: name) {
                try? FileManager.default.removeItem(at: ForegroundDownloads.resumeFile(destination))
            }
            done()
        }
    }

    /// Disconnect or a refused token: a new generation at once (no task of the old one publishes a file or resume
    /// data from now on), then every task stops.
    func cancelAll() {
        ForegroundDownloads.rotateGeneration()
        Task { await cancelAllAndWait() }
    }

    func cancelAllAndWait() async {
        ForegroundDownloads.rotateGeneration()
        lock.lock()
        cancelledStarting.formUnion(starting)
        let session = self.session
        lock.unlock()
        for task in await session.allTasks {
            lock.lock()
            stoppedByHand.insert(task.taskIdentifier)
            lock.unlock()
            task.cancel()
        }
    }

    private func settle(path: String, failure: Failure?, bytes: Int64) {
        lock.lock()
        starting.remove(path)
        cancelledStarting.remove(path)
        let calls = waiters.removeValue(forKey: path) ?? []
        lock.unlock()
        for w in calls {
            guard let failed = failure else {
                w.call.resolve(["bytes": bytes])
                continue
            }
            switch failed {
            case .http(let status): w.call.reject("The server answered \(status).", "http", nil, ["status": status])
            case .network: w.call.reject("The connection failed.", "network")
            case .tooLarge: w.call.reject("The file is larger than allowed.", "too_large")
            case .cancelled: w.call.reject("The download was cancelled.", "cancelled")
            case .io(let message): w.call.reject(message, "io")
            }
        }
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let meta = ForegroundDownloads.meta(of: downloadTask) else { return }
        let id = downloadTask.taskIdentifier
        lock.lock()
        let failed = failures[id] != nil
        lock.unlock()
        if failed { return }
        if let http = downloadTask.response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            lock.lock(); failures[id] = .http(http.statusCode); lock.unlock()
            downloadTask.cancel()
            return
        }
        if totalBytesWritten > meta.max || (totalBytesExpectedToWrite > 0 && totalBytesExpectedToWrite > meta.max) {
            lock.lock(); failures[id] = .tooLarge; lock.unlock()
            downloadTask.cancel()
            return
        }
        let now = Date().timeIntervalSince1970
        lock.lock()
        let due = now - (lastEmit[id] ?? 0) >= 0.25
        if due { lastEmit[id] = now }
        let ids = (waiters[meta.path] ?? []).map(\.id)
        let emit = onProgress
        lock.unlock()
        if due { for callId in ids { emit?(callId, totalBytesWritten, totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : -1) } }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let meta = ForegroundDownloads.meta(of: downloadTask), let destination = ForegroundDownloads.destination(for: meta.path) else { return }
        let id = downloadTask.taskIdentifier
        func fail(_ f: Failure) { lock.lock(); failures[id] = f; lock.unlock() }
        lock.lock()
        let byHand = stoppedByHand.contains(id)
        lock.unlock()
        if byHand { return fail(.cancelled) }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else { return fail(.http(status)) }
        let size = ForegroundDownloads.size(location)
        if size > meta.max { return fail(.tooLarge) }
        // The file must leave the system's temporary place before this returns.
        let fm = FileManager.default
        let part = destination.appendingPathExtension("part")
        ForegroundDownloads.publishing.lock()
        defer { ForegroundDownloads.publishing.unlock() }
        // Of an account since disconnected or refused: nothing is published.
        if meta.generation != ForegroundDownloads.generation { return fail(.cancelled) }
        do {
            guard DeviceStore.ensureDirectory(DeviceStore.downloadsDirectory) else { throw CocoaError(.fileWriteUnknown) }
            try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? fm.removeItem(at: part)
            try fm.moveItem(at: location, to: part)
            try? fm.removeItem(at: destination)
            try fm.moveItem(at: part, to: destination)
            lock.lock(); finished[id] = size; lock.unlock()
        } catch {
            try? fm.removeItem(at: part)
            fail(.io(error.localizedDescription))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let id = task.taskIdentifier
        lock.lock()
        var failure = failures.removeValue(forKey: id)
        let bytes = finished.removeValue(forKey: id)
        let byHand = stoppedByHand.remove(id) != nil
        lastEmit.removeValue(forKey: id)
        lock.unlock()
        guard let meta = ForegroundDownloads.meta(of: task), let destination = ForegroundDownloads.destination(for: meta.path) else { return }
        let resume = ForegroundDownloads.resumeFile(destination)
        let stale = meta.generation != ForegroundDownloads.generation
        if failure == nil, let error = error {
            if byHand || stale {
                failure = .cancelled
            } else {
                // Cut off by the connection, or by the system (the app was swiped away): kept to be continued.
                failure = .network
                if let data = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
                    ForegroundDownloads.publishing.lock()
                    if meta.generation == ForegroundDownloads.generation {
                        _ = DeviceStore.ensureDirectory(DeviceStore.downloadsDirectory)
                        try? FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                        try? data.write(to: resume, options: .atomic)
                    }
                    ForegroundDownloads.publishing.unlock()
                }
            }
        }
        if failure == nil && bytes == nil { failure = .network }
        if byHand || stale { try? FileManager.default.removeItem(at: resume) }
        settle(path: meta.path, failure: failure, bytes: bytes ?? 0)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let completion = eventsCompletion
        eventsCompletion = nil
        lock.unlock()
        DispatchQueue.main.async { completion?() }
    }
}
