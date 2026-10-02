import Foundation

public final class APIClient: Sendable {
    public let baseURL: URL
    private let session: URLSession
    private let tokenProvider: @Sendable () -> String?
    private let onUnauthorized: @Sendable () -> Void

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        tokenProvider: @escaping @Sendable () -> String?,
        onUnauthorized: @escaping @Sendable () -> Void = {}
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
        self.onUnauthorized = onUnauthorized
    }

    public func exchangeGoogleToken(_ idToken: String) async throws -> AuthResponse {
        let data = try await send("POST", "api/auth/google", body: try JSONEncoder().encode(["id_token": idToken]), authenticated: false)
        return try makeDecoder().decode(AuthResponse.self, from: data)
    }

    public func logout() async throws {
        _ = try await send("POST", "api/auth/logout")
    }

    public func registerDevice(_ registration: DeviceRegistration) async throws {
        _ = try await send("PUT", "api/devices/current", body: try JSONEncoder().encode(registration))
    }

    public func pages(before: String? = nil, limit: Int = 50) async throws -> PagesResponse {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        let data = try await send("GET", "api/pages", query: query)
        return try makeDecoder().decode(PagesResponse.self, from: data)
    }

    public func sendTest() async throws {
        _ = try await send("POST", "api/test")
    }

    private func send(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil,
        authenticated: Bool = true
    ) async throws -> Data {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.timeoutInterval = 20
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authenticated {
            guard let token = tokenProvider() else {
                throw APIError(status: 401, code: "unauthorized", message: "You're signed out.")
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401 && authenticated { onUnauthorized() }
            let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw APIError(
                status: status,
                code: envelope?.error.code ?? "http_\(status)",
                message: envelope?.error.message ?? "The server returned an error (\(status))."
            )
        }
        return data
    }
}
