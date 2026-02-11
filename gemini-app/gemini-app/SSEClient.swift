import Foundation

final class SSEClient: NSObject {
    private let url: URL
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 300
        configuration.timeoutIntervalForResource = 0
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()
    private var task: URLSessionDataTask?
    private var buffer = ""
    private var hasOpened = false

    var onOpen: (() -> Void)?
    var onMessage: ((String) -> Void)?
    var onError: ((Error?) -> Void)?

    init(url: URL) {
        self.url = url
        super.init()
    }

    func connect() {
        disconnect()
        hasOpened = false
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        request.timeoutInterval = 300

        let task = session.dataTask(with: request)
        self.task = task
        task.resume()

        // Open callback is triggered when the first data arrives
    }

    func disconnect() {
        task?.cancel()
        task = nil
    }
}

extension SSEClient: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        markOpenIfNeeded()
        buffer.append(text.replacingOccurrences(of: "\r\n", with: "\n"))
        parseBuffer()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        DispatchQueue.main.async { [weak self] in
            self?.onError?(error)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let httpResponse = response as? HTTPURLResponse,
           (200..<300).contains(httpResponse.statusCode) {
            markOpenIfNeeded()
        }
        completionHandler(.allow)
    }

    private func parseBuffer() {
        while let range = buffer.range(of: "\n\n") {
            let rawEvent = String(buffer[..<range.lowerBound])
            buffer = String(buffer[range.upperBound...])

            let lines = rawEvent.split(separator: "\n")
            let dataLines = lines.compactMap { line -> String? in
                if line.hasPrefix("data:") {
                    return line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                }
                return nil
            }
            if !dataLines.isEmpty {
                let data = dataLines.joined(separator: "\n")
                DispatchQueue.main.async { [weak self] in
                    self?.onMessage?(data)
                }
            }
        }
    }

    private func markOpenIfNeeded() {
        guard !hasOpened else { return }
        hasOpened = true
        DispatchQueue.main.async { [weak self] in
            self?.onOpen?()
        }
    }
}
