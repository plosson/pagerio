import Foundation

/// Display rules shared by both apps; the web dashboard applies the same ones (server/src/web/pageList.ts).
public enum PageList {
    public static let burstWindow: TimeInterval = 10 * 60
    /// The newest page shows the orange "new page" dot while it is this recent.
    public static let newPageWindow: TimeInterval = 15 * 60

    /// "just now", "4 min ago", "2 h ago", "3 d ago". A time in the future (clock skew) is "just now".
    public static func relativeTime(_ date: Date, now: Date) -> String {
        let age = now.timeIntervalSince(date)
        if age < 60 { return "just now" }
        if age < 3600 { return "\(Int(age / 60)) min ago" }
        if age < 86400 { return "\(Int(age / 3600)) h ago" }
        return "\(Int(age / 86400)) d ago"
    }

    /// Pages are newest first. A run of pages with the same title and message, all within ten minutes
    /// of the run's newest page, becomes one row that keeps the count and the summed delivery.
    public static func groupBursts(_ pages: [PageSummary]) -> [PageGroup] {
        var groups: [PageGroup] = []
        for page in pages {
            if let last = groups.last,
               last.page.title == page.title, last.page.message == page.message,
               last.page.createdAt.timeIntervalSince(page.createdAt) <= burstWindow {
                groups[groups.count - 1].count += 1
                groups[groups.count - 1].delivery = Delivery(
                    sent: last.delivery.sent + page.delivery.sent,
                    sending: last.delivery.sending + page.delivery.sending,
                    failed: last.delivery.failed + page.delivery.failed
                )
            } else {
                groups.append(PageGroup(page: page, count: 1, delivery: page.delivery))
            }
        }
        return groups
    }

    public static func isNew(_ page: PageSummary, now: Date) -> Bool {
        now.timeIntervalSince(page.createdAt) < newPageWindow
    }

    /// Like the web's dir="auto": the first strong character decides, so each text follows its own language.
    public static func isRightToLeft(_ text: String) -> Bool {
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x0590...0x08FF, 0xFB1D...0xFDFF, 0xFE70...0xFEFF, 0x10800...0x10FFF, 0x1E800...0x1EFFF:
                return true
            default:
                if scalar.properties.isAlphabetic { return false }
            }
        }
        return false
    }
}

public struct PageGroup: Identifiable, Equatable, Sendable {
    public let page: PageSummary
    public internal(set) var count: Int
    public internal(set) var delivery: Delivery

    public var id: String { page.id }
}

public enum DeliveryStatus: Equatable, Sendable {
    case failed(Int)
    case sending
    case sent(Int)
    case none

    public init(_ delivery: Delivery) {
        if delivery.failed > 0 { self = .failed(delivery.failed) }
        else if delivery.sending > 0 { self = .sending }
        else if delivery.sent > 0 { self = .sent(delivery.sent) }
        else { self = .none }
    }

    /// An icon and a word for every state, so colour is never the only signal.
    public var text: String {
        switch self {
        case .failed(let n): "\(n) failed"
        case .sending: "Sending…"
        case .sent(let n): n == 1 ? "Sent to 1 device" : "Sent to \(n) devices"
        case .none: "No devices"
        }
    }

    public var symbol: String {
        switch self {
        case .failed: "exclamationmark.circle"
        case .sending: "arrow.triangle.2.circlepath"
        case .sent: "checkmark"
        case .none: "circle"
        }
    }
}
