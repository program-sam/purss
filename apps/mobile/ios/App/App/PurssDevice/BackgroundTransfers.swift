import Foundation

/// What a background transfer needs when it finishes, possibly in a relaunched app: kept in the task's
/// `taskDescription`. The item's item.json (and annotations.json) are already in the staging folder.
struct TransferMeta: Codable {
    var accountId: String
    var itemId: String
    var file: String
    var max: Int64
    var origin: String
    var mediaKind: String
    var mediaType: String?
}

/// Where an item's files wait until they are complete: `downloads-incoming/<account>/<item>/`.
enum Staging {
    static func folder(_ meta: TransferMeta) -> URL {
        DeviceStore.incomingDirectory.appendingPathComponent(meta.accountId, isDirectory: true).appendingPathComponent(meta.itemId, isDirectory: true)
    }

    static func target(_ meta: TransferMeta) -> URL {
        DeviceStore.downloadsDirectory.appendingPathComponent(meta.accountId, isDirectory: true).appendingPathComponent(meta.itemId, isDirectory: true)
    }

    /// Empties and creates the staging folder.
    static func reset(_ meta: TransferMeta) -> Bool {
        let url = folder(meta)
        try? FileManager.default.removeItem(at: url)
        guard DeviceStore.ensureDirectory(DeviceStore.incomingDirectory) else { return false }
        return (try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)) != nil
    }

    static func remove(_ meta: TransferMeta) {
        try? FileManager.default.removeItem(at: folder(meta))
    }

    private static func size(of url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
    }

    private static func timestamp() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date())
    }

    /// The transfer finished and its file is at `mediaTemp`: moves it into staging and completes the item.
    static func finishDone(_ meta: TransferMeta, mediaTemp: URL) {
        guard accountStillConnected(meta) else { remove(meta); return }
        let fm = FileManager.default
        let media = folder(meta).appendingPathComponent(meta.file)
        do {
            try? fm.removeItem(at: media)
            try fm.moveItem(at: mediaTemp, to: media)
        } catch {
            finishFailed(meta, status: 0)
            return
        }
        let mediaBytes = size(of: media)
        let textBytes = size(of: folder(meta).appendingPathComponent("item.json")) + size(of: folder(meta).appendingPathComponent("annotations.json"))
        var record = identity(meta)
        record["state"] = "done"
        record["status"] = NSNull()
        record["media"] = [
            "file": "\(meta.accountId)/\(meta.itemId)/\(meta.file)",
            "bytes": mediaBytes,
            "type": meta.mediaType.map { $0 as Any } ?? NSNull(),
            "kind": meta.mediaKind,
        ] as [String: Any]
        record["textBytes"] = textBytes
        complete(meta, record: record, addedBytes: mediaBytes + textBytes)
    }

    /// The item can't be downloaded: keeps only a failed record. `status` is the server's answer, 0 for a lost
    /// connection, -1 for an address that isn't https, -2 for a file larger than the room left.
    static func finishFailed(_ meta: TransferMeta, status: Int) {
        guard accountStillConnected(meta) else { remove(meta); return }
        var record = identity(meta)
        let fm = FileManager.default
        for name in (try? fm.contentsOfDirectory(atPath: folder(meta).path)) ?? [] {
            try? fm.removeItem(at: folder(meta).appendingPathComponent(name))
        }
        record["state"] = "failed"
        record["status"] = status
        record["media"] = NSNull()
        record["textBytes"] = 0
        complete(meta, record: record, addedBytes: 0)
    }

    private static func accountStillConnected(_ meta: TransferMeta) -> Bool {
        guard let state = DeviceStore.readState() else { return false }
        return state.accountId == meta.accountId && DeviceStore.sameOrigin(state.origin, meta.origin)
    }

    /// title, sourceTitle and kind come from the item.json written before the transfer started.
    private static func identity(_ meta: TransferMeta) -> [String: Any] {
        var title = "", sourceTitle = "", kind = "article"
        if let data = try? Data(contentsOf: folder(meta).appendingPathComponent("item.json")),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            title = json["title"] as? String ?? ""
            sourceTitle = json["sourceTitle"] as? String ?? ""
            kind = json["kind"] as? String ?? "article"
        }
        return ["itemId": meta.itemId, "title": title, "sourceTitle": sourceTitle, "kind": kind, "savedAt": timestamp()]
    }

    /// Writes record.json last, moves the folder to the downloads folder unless one is already there, and
    /// tells the stored state what the device now has.
    private static func complete(_ meta: TransferMeta, record: [String: Any], addedBytes: Int64) {
        let fm = FileManager.default
        let staging = folder(meta)
        guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]),
              (try? data.write(to: staging.appendingPathComponent("record.json"), options: .atomic)) != nil else {
            remove(meta)
            return
        }
        let target = target(meta)
        guard DeviceStore.ensureDirectory(DeviceStore.downloadsDirectory), !fm.fileExists(atPath: target.path) else {
            remove(meta)
            return
        }
        do {
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.moveItem(at: staging, to: target)
        } catch {
            remove(meta)
            return
        }
        DeviceStore.updateState { state in
            if state.accountId == meta.accountId {
                if !state.have.contains(meta.itemId) { state.have.append(meta.itemId) }
                state.usedBytes += Double(addedBytes)
            }
        }
    }
}

/// Files go through one background URLSession, which the system keeps running (and relaunches the app for)
/// when the job's time is up. The delegate finishes an item whether or not a run is waiting for it.
final class BackgroundTransfers: NSObject, URLSessionDownloadDelegate {
    static let shared = BackgroundTransfers()
    static let identifier = "app.purss.downloads.transfers"

    private let lock = NSLock()
    private var backing: URLSession?
    private var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
    private var handled = Set<Int>()
    private var tooLarge = Set<Int>()
    private var eventsCompletion: (() -> Void)?

    /// The session, created on first use. Cellular and expensive networks are refused when Wi-Fi only was on at that time.
    private var session: URLSession {
        lock.lock(); defer { lock.unlock() }
        if let s = backing { return s }
        let config = URLSessionConfiguration.background(withIdentifier: BackgroundTransfers.identifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        if DeviceStore.readState()?.settings.wifiOnly ?? true {
            config.allowsCellularAccess = false
            config.allowsExpensiveNetworkAccess = false
        }
        let s = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        backing = s
        return s
    }

    /// The system relaunched the app for finished transfers: recreating the session delivers their events.
    func attach(completionHandler: @escaping () -> Void) {
        lock.lock()
        eventsCompletion = completionHandler
        lock.unlock()
        _ = session
    }

    /// The ids of items that have a transfer under way.
    func activeItemIds() async -> Set<String> {
        var ids = Set<String>()
        for task in await session.allTasks {
            if let meta = BackgroundTransfers.meta(of: task) { ids.insert(meta.itemId) }
        }
        return ids
    }

    /// Fetches `request` into the item's staging folder and finishes the item. Returns when the transfer is
    /// over; if the run is cancelled first, the transfer carries on in the system and finishes the item itself.
    func transfer(_ request: URLRequest, meta: TransferMeta) async {
        guard let description = try? JSONEncoder().encode(meta), let text = String(data: description, encoding: .utf8) else {
            Staging.finishFailed(meta, status: 0)
            return
        }
        let task = session.downloadTask(with: request)
        task.taskDescription = text
        let id = task.taskIdentifier
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                lock.lock()
                if Task.isCancelled {
                    lock.unlock()
                    task.cancel()
                    continuation.resume()
                    return
                }
                waiters[id] = continuation
                lock.unlock()
                task.resume()
            }
        } onCancel: {
            self.resumeWaiter(id)
        }
    }

    private func resumeWaiter(_ id: Int) {
        lock.lock()
        let waiter = waiters.removeValue(forKey: id)
        lock.unlock()
        waiter?.resume()
    }

    /// Stops every transfer. The finished-item path checks the stored state, so a cancelled one leaves nothing behind.
    func cancelAll() {
        Task { await cancelAllAndWait() }
    }

    func cancelAllAndWait() async {
        for task in await session.allTasks { task.cancel() }
    }

    private static func meta(of task: URLSessionTask) -> TransferMeta? {
        guard let text = task.taskDescription, let data = text.data(using: .utf8) else { return nil }
        guard let meta = try? JSONDecoder().decode(TransferMeta.self, from: data),
              DeviceStore.isSafeComponent(meta.accountId), DeviceStore.isSafeComponent(meta.itemId), DeviceStore.isSafeComponent(meta.file) else { return nil }
        return meta
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let meta = BackgroundTransfers.meta(of: downloadTask) else { return }
        if totalBytesWritten > meta.max || (totalBytesExpectedToWrite > 0 && totalBytesExpectedToWrite > meta.max) {
            lock.lock()
            tooLarge.insert(downloadTask.taskIdentifier)
            lock.unlock()
            downloadTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        lock.lock()
        handled.insert(downloadTask.taskIdentifier)
        lock.unlock()
        guard let meta = BackgroundTransfers.meta(of: downloadTask) else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            Staging.finishFailed(meta, status: status)
            return
        }
        let size = ((try? FileManager.default.attributesOfItem(atPath: location.path))?[.size] as? NSNumber)?.int64Value ?? 0
        if size > meta.max {
            Staging.finishFailed(meta, status: -2)
            return
        }
        Staging.finishDone(meta, mediaTemp: location)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let id = task.taskIdentifier
        lock.lock()
        let wasHandled = handled.remove(id) != nil
        let wasTooLarge = tooLarge.remove(id) != nil
        lock.unlock()
        defer { resumeWaiter(id) }
        guard !wasHandled, let error = error, let meta = BackgroundTransfers.meta(of: task) else { return }
        if wasTooLarge {
            Staging.finishFailed(meta, status: -2)
        } else if (error as? URLError)?.code == .cancelled {
            Staging.remove(meta)
        } else {
            Staging.finishFailed(meta, status: 0)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let completion = eventsCompletion
        eventsCompletion = nil
        lock.unlock()
        DispatchQueue.main.async { completion?() }
    }
}
