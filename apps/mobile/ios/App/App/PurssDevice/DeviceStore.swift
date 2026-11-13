import Foundation
import BackgroundTasks
import WidgetKit

/// What the background download state, the page's part of the widgets' data and the downloads folders look like on
/// disk (plan/38). Everything here is safe to call from any thread. The widgets' lists and choices, and who may write
/// them, are in WidgetRefresh.swift.

/// The settings the page mirrors (DownloadSettings in packages/domain; fields the job doesn't use are ignored).
struct BackgroundSettings: Codable {
    var autoToRead: Bool
    var wifiOnly: Bool
    var limitBytes: Double
}

/// The page's BackgroundState (apps/web/src/downloads/background.ts) plus the PURSS's address.
struct BackgroundState: Codable {
    var accountId: String
    var settings: BackgroundSettings
    var have: [String]
    var usedBytes: Double
    var origin: String

    var limit: Int64 { Int64(max(0, min(settings.limitBytes, 1e15))) }
    var used: Int64 { Int64(max(0, min(usedBytes, 1e15))) }
}

enum DeviceStore {
    static let taskIdentifier = "app.purss.downloads"

    private static let stateKey = "app.purss.device.background"
    private static let lostKey = "app.purss.device.lost"
    private static let lock = NSLock()

    // MARK: Folders

    /// `Library/NoCloud`, where `@capacitor/filesystem` reaches `Directory.LibraryNoCloud`.
    static var noCloudDirectory: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("NoCloud", isDirectory: true)
    }
    static var downloadsDirectory: URL { noCloudDirectory.appendingPathComponent("downloads", isDirectory: true) }
    static var incomingDirectory: URL { noCloudDirectory.appendingPathComponent("downloads-incoming", isDirectory: true) }

    /// Creates the folder if needed and keeps it out of backups, as the downloads are on this device only.
    @discardableResult
    static func ensureDirectory(_ directory: URL) -> Bool {
        var url = directory
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
            return true
        } catch {
            return false
        }
    }

    /// A single path component that stays inside its folder.
    static func isSafeComponent(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 200 && s != "." && s != ".." && !s.contains("/") && !s.contains("\\") && !s.contains("\0")
    }

    /// Whether two PURSS addresses are the same server (a trailing slash and case of the host don't matter).
    static func sameOrigin(_ a: String, _ b: String) -> Bool {
        func normal(_ s: String) -> String {
            var t = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            while t.hasSuffix("/") { t.removeLast() }
            return t
        }
        return normal(a) == normal(b)
    }

    // MARK: Background state

    static func readState() -> BackgroundState? {
        lock.lock(); defer { lock.unlock() }
        return decodeState()
    }

    private static func decodeState() -> BackgroundState? {
        guard let json = UserDefaults.standard.string(forKey: stateKey), let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(BackgroundState.self, from: data)
    }

    /// Stores the page's state as sent; false when it can't be read.
    static func storeState(json: String) -> Bool {
        guard let data = json.data(using: .utf8), (try? JSONDecoder().decode(BackgroundState.self, from: data)) != nil else { return false }
        lock.lock(); defer { lock.unlock() }
        UserDefaults.standard.set(json, forKey: stateKey)
        return true
    }

    /// Changes the stored state in one step; nothing happens when there is none.
    static func updateState(_ change: (inout BackgroundState) -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard var state = decodeState() else { return }
        change(&state)
        if let out = try? JSONEncoder().encode(state), let json = String(data: out, encoding: .utf8) {
            UserDefaults.standard.set(json, forKey: stateKey)
        }
    }

    static func clearState() {
        lock.lock(); defer { lock.unlock() }
        UserDefaults.standard.removeObject(forKey: stateKey)
    }

    // MARK: Report

    /// The token was found refused and the page hasn't taken the report yet.
    static func isLost() -> Bool { UserDefaults.standard.bool(forKey: lostKey) }

    static func setLost() { UserDefaults.standard.set(true, forKey: lostKey) }
    static func clearLost() { UserDefaults.standard.removeObject(forKey: lostKey) }

    /// Whether the job found the token refused; asking clears it.
    static func takeLost() -> Bool {
        lock.lock(); defer { lock.unlock() }
        let lost = UserDefaults.standard.bool(forKey: lostKey)
        UserDefaults.standard.removeObject(forKey: lostKey)
        return lost
    }

    // MARK: Widget snapshot

    static var widgetFile: URL? {
        WidgetFiles.url(WidgetFiles.snapshotName)
    }

    /// Writes the page's snapshot (look and episode), or removes it (the widgets then show "not connected"), and
    /// redraws the widgets. Callers go through `WidgetData.withLock`.
    static func writeWidget(_ data: Data?) throws {
        guard let url = widgetFile else {
            throw NSError(domain: "PurssDevice", code: 1, userInfo: [NSLocalizedDescriptionKey: "The app group is not available."])
        }
        if let data = data {
            try data.write(to: url, options: .atomic)
        } else if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: Wiping

    /// The PURSS refused the token: nothing of the account stays, the widgets' data included. The page finds the flag
    /// on its next start. Called through `WidgetData.lost(since:)`, which checks the refusal isn't an old connection's.
    static func revoke() {
        BackgroundTransfers.shared.cancelAll()
        clearState()
        try? FileManager.default.removeItem(at: downloadsDirectory)
        try? FileManager.default.removeItem(at: incomingDirectory)
        WidgetData.wipe()
        // The notification extension's credential belongs to the same refused connection (plan/37).
        PushTarget.delete()
        setLost()
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
    }
}
