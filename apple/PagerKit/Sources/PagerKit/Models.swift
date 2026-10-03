import Foundation

/// How many device pushes APNs accepted, are still queued, or gave up. Never "delivered".
public struct Delivery: Decodable, Equatable, Sendable {
    public let sent: Int
    public let sending: Int
    public let failed: Int

    public static let none = Delivery(sent: 0, sending: 0, failed: 0)

    public init(sent: Int, sending: Int, failed: Int) {
        self.sent = sent
        self.sending = sending
        self.failed = failed
    }
}

public struct PageSummary: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String?
    public let message: String
    public let url: URL?
    public let viewURL: URL
    public let source: String
    public let createdAt: Date
    public let delivery: Delivery

    public var headline: String { title ?? message }

    enum CodingKeys: String, CodingKey {
        case id, title, message, url, source, delivery
        case viewURL = "view_url"
        case createdAt = "created_at"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        message = try container.decode(String.self, forKey: .message)
        // A sender-supplied link must never make the whole list undecodable.
        url = try container.decodeIfPresent(String.self, forKey: .url).flatMap(URL.init(string:))
        viewURL = try container.decode(URL.self, forKey: .viewURL)
        source = try container.decode(String.self, forKey: .source)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        // Older servers don't send delivery; a malformed summary must not hide the page either.
        delivery = (try? container.decodeIfPresent(Delivery.self, forKey: .delivery)) ?? .none
    }
}

public struct PagesResponse: Decodable, Sendable {
    public let pages: [PageSummary]
    public let nextBefore: String?
    /// Pages kept in the last 30 days, and devices that ring. Nil from an older server.
    public let total: Int?
    public let devices: Int?

    enum CodingKeys: String, CodingKey {
        case pages, total, devices
        case nextBefore = "next_before"
    }
}

public struct AuthResponse: Decodable, Equatable, Sendable {
    public let sessionToken: String
    public let email: String

    enum CodingKeys: String, CodingKey {
        case sessionToken = "session_token"
        case email
    }
}

public struct DeviceRegistration: Encodable, Equatable, Sendable {
    public let apnsToken: String
    public let platform: String
    public let model: String
    public let apnsEnv: String

    enum CodingKeys: String, CodingKey {
        case apnsToken = "apns_token"
        case platform, model
        case apnsEnv = "apns_env"
    }
}

public struct APIError: Error, LocalizedError, Equatable, Sendable {
    public let status: Int
    public let code: String
    public let message: String

    public var errorDescription: String? { message }
}

struct ErrorEnvelope: Decodable {
    struct Detail: Decodable {
        let code: String
        let message: String
    }

    let error: Detail
}

func makeDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        if let date = try? Date(text, strategy: .iso8601) { return date }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date")
    }
    return decoder
}
