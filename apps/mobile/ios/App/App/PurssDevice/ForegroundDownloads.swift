import Foundation
import Capacitor

/// The page's downloads while the app is open: one URLSession download task per `download` call, written
/// to `<path>.part` and renamed when complete. Each call settles once, in didCompleteWithError.
final class ForegroundDownloads: NSObject, URLSessionDownloadDelegate {
    private enum Failure {
        case http(Int)
        case network
        case tooLarge
        case cancelled
        case io(String)
    }

    private final class Entry {
        let id: String
        let call: CAPPluginCall
        let destination: URL
        let maxBytes: Int64?
        var failure: Failure?
        var bytes: Int64 = 0
        var lastEmit: TimeInterval = 0
        init(id: String, call: CAPPluginCall, destination: URL, maxBytes: Int64?) {
            self.id = id
            self.call = call
            self.destination = destination
            self.maxBytes = maxBytes
        }
    }

    private let lock = NSLock()
    private var entries: [Int: Entry] = [:]
    private var tasks: [String: URLSessionDownloadTask] = [:]
    private let onProgress: (String, Int64, Int64) -> Void
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

    init(onProgress: @escaping (String, Int64, Int64) -> Void) {
        self.onProgress = onProgress
    }

    /// A relative path under the downloads folder, or nil when it has an empty segment, `.`, `..` or starts with `/`.
    static func destination(for path: String) -> URL? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, parts.allSatisfy({ DeviceStore.isSafeComponent($0) }) else { return nil }
        return parts.reduce(DeviceStore.downloadsDirectory) { $0.appendingPathComponent($1) }
    }

    func start(id: String, url: URL, destination: URL, maxBytes: Int64?, call: CAPPluginCall) {
        lock.lock()
        if tasks[id] != nil {
            lock.unlock()
            call.reject("A download with this id is already running.", "io")
            return
        }
        let task = session.downloadTask(with: url)
        let entry = Entry(id: id, call: call, destination: destination, maxBytes: maxBytes)
        entries[task.taskIdentifier] = entry
        tasks[id] = task
        lock.unlock()
        task.resume()
    }

    func cancel(id: String) {
        lock.lock()
        let task = tasks[id]
        if let task = task { entries[task.taskIdentifier]?.failure = entries[task.taskIdentifier]?.failure ?? .cancelled }
        lock.unlock()
        task?.cancel()
    }

    private func entry(_ task: URLSessionTask) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        return entries[task.taskIdentifier]
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let entry = entry(downloadTask), entry.failure == nil else { return }
        if let http = downloadTask.response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            entry.failure = .http(http.statusCode)
            downloadTask.cancel()
            return
        }
        if let max = entry.maxBytes, totalBytesWritten > max || (totalBytesExpectedToWrite > 0 && totalBytesExpectedToWrite > max) {
            entry.failure = .tooLarge
            downloadTask.cancel()
            return
        }
        let now = Date().timeIntervalSince1970
        if now - entry.lastEmit >= 0.25 {
            entry.lastEmit = now
            onProgress(entry.id, totalBytesWritten, totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : -1)
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let entry = entry(downloadTask), entry.failure == nil else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            entry.failure = .http(status)
            return
        }
        let fm = FileManager.default
        let size = ((try? fm.attributesOfItem(atPath: location.path))?[.size] as? NSNumber)?.int64Value ?? 0
        if let max = entry.maxBytes, size > max {
            entry.failure = .tooLarge
            return
        }
        let part = entry.destination.appendingPathExtension("part")
        do {
            try fm.createDirectory(at: entry.destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? fm.removeItem(at: part)
            try fm.moveItem(at: location, to: part)
            try? fm.removeItem(at: entry.destination)
            try fm.moveItem(at: part, to: entry.destination)
            entry.bytes = size
        } catch {
            try? fm.removeItem(at: part)
            entry.failure = .io(error.localizedDescription)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let entry = entries.removeValue(forKey: task.taskIdentifier)
        if let entry = entry { tasks.removeValue(forKey: entry.id) }
        lock.unlock()
        guard let entry = entry else { return }

        var failure = entry.failure
        if failure == nil, let error = error {
            failure = (error as? URLError)?.code == .cancelled ? .cancelled : .network
        }
        guard let failed = failure else {
            entry.call.resolve(["bytes": entry.bytes])
            return
        }
        try? FileManager.default.removeItem(at: entry.destination.appendingPathExtension("part"))
        switch failed {
        case .http(let status): entry.call.reject("The server answered \(status).", "http", nil, ["status": status])
        case .network: entry.call.reject("The connection failed.", "network")
        case .tooLarge: entry.call.reject("The file is larger than allowed.", "too_large")
        case .cancelled: entry.call.reject("The download was cancelled.", "cancelled")
        case .io(let message): entry.call.reject(message, "io")
        }
    }
}
