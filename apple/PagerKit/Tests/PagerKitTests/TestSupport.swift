import Foundation
import Testing

/// Every suite that uses StubURLProtocol nests under this serialized suite, because the stub is global.
@Suite(.serialized) enum Network {}

final class StubURLProtocol: URLProtocol {
    struct Reply: Sendable {
        var status: Int // negative: fail with a network error
        var body: Data
    }

    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> Reply)?
    nonisolated(unsafe) static var requests: [URLRequest] = []

    static func reset(_ handler: @escaping @Sendable (URLRequest) -> Reply) {
        self.handler = handler
        requests = []
    }

    static func json(_ status: Int, _ text: String) -> Reply { Reply(status: status, body: Data(text.utf8)) }
    static let offline = Reply(status: -1, body: Data())

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var captured = request
        if captured.httpBody == nil, let stream = captured.httpBodyStream { captured.httpBody = Self.read(stream) }
        Self.requests.append(captured)
        let reply = Self.handler?(captured) ?? Reply(status: 500, body: Data())
        if reply.status < 0 {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: captured.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func hit() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

func jsonBody(_ request: URLRequest) throws -> [String: String] {
    let data = try #require(request.httpBody)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
}

let testBaseURL = URL(string: "https://pager.test")!
