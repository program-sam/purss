import UserNotifications

/// Replaces the push's neutral text with the real text, fetched from the person's PURSS with the
/// narrow fetch credential the app stored. Nothing is logged: not the credential, not the texts.
class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    private var session: URLSession?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            self.contentHandler = nil
            return
        }
        bestAttempt = content
        content.threadIdentifier = "purss"
        var userInfo = content.userInfo
        userInfo["purssOpen"] = "purss://open"
        content.userInfo = userInfo

        guard let target = PushTarget.load(),
              let url = URL(string: target.origin)?.appendingPathComponent("api/push/pending") else {
            deliver()
            return
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        self.session = session

        var fetch = URLRequest(url: url)
        fetch.httpMethod = "POST"
        fetch.setValue("Bearer \(target.fetchToken)", forHTTPHeaderField: "Authorization")
        fetch.setValue("application/json", forHTTPHeaderField: "Content-Type")
        fetch.httpBody = Data("{}".utf8)

        session.dataTask(with: fetch) { [weak self] data, response, _ in
            guard let self = self else { return }
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && SignedOut.says(data, code: "push_signed_out") {
                    // The registration is gone; the app registers again when it next starts. Any other 401 is transient.
                    PushTarget.delete()
                } else if http.statusCode == 200, let data = data {
                    self.apply(data)
                }
            }
            self.deliver()
        }.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        deliver()
    }

    private struct Pending: Decodable {
        let notifications: [Entry]
        struct Entry: Decodable {
            let id: String
            let title: String
            let body: String?
            let itemId: String?
            let sourceId: String?
        }
    }

    private func apply(_ data: Data) {
        guard let pending = try? JSONDecoder().decode(Pending.self, from: data),
              let newest = pending.notifications.last else { return }
        lock.lock()
        defer { lock.unlock() }
        guard let content = bestAttempt, contentHandler != nil else { return }

        let more = pending.notifications.count - 1
        let moreText = "\(more) more in your PURSS"
        var body = ""
        if let text = newest.body, !text.isEmpty {
            body = more > 0 ? "\(text)\n\(moreText)" : text
        } else if more > 0 {
            body = moreText
        }
        content.title = String(newest.title.prefix(200))
        content.body = String(body.prefix(1000))

        var components = URLComponents()
        components.scheme = "purss"
        components.host = "open"
        var query: [URLQueryItem] = []
        if let itemId = newest.itemId { query.append(URLQueryItem(name: "item", value: itemId)) }
        if let sourceId = newest.sourceId { query.append(URLQueryItem(name: "source", value: sourceId)) }
        if !query.isEmpty { components.queryItems = query }
        if let open = components.string {
            var userInfo = content.userInfo
            userInfo["purssOpen"] = open
            content.userInfo = userInfo
        }
    }

    /// Calls the content handler exactly once, whichever path gets here first.
    private func deliver() {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        let content = bestAttempt
        lock.unlock()
        session?.invalidateAndCancel()
        if let handler = handler, let content = content {
            handler(content)
        }
    }
}
