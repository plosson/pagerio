import Foundation
import Observation

@MainActor @Observable
public final class PagesStore {
    public private(set) var pages: [PageSummary] = []
    public private(set) var lastError: String?
    public private(set) var isLoading = false
    private let api: APIClient
    private var generation = 0
    private var refreshPending = false

    public init(api: APIClient) {
        self.api = api
    }

    /// A refresh requested while one is running is coalesced into exactly one follow-up load.
    public func refresh() async {
        if isLoading {
            refreshPending = true
            return
        }
        isLoading = true
        defer { isLoading = false }
        repeat {
            refreshPending = false
            let started = generation
            do {
                let loaded = try await api.pages().pages
                if started == generation {
                    pages = loaded
                    lastError = nil
                }
            } catch {
                if started == generation { lastError = Self.describe(error) }
            }
        } while refreshPending
    }

    /// The server stores the page before answering 202, so an immediate refresh shows it.
    public func sendTest() async {
        let started = generation
        do {
            try await api.sendTest()
            await refresh()
        } catch {
            if started == generation { lastError = Self.describe(error) }
        }
    }

    /// Forgets everything; loads already in flight belong to the old account and are discarded.
    public func reset() {
        generation += 1
        refreshPending = false
        pages = []
        lastError = nil
    }

    static func describe(_ error: any Error) -> String {
        if let apiError = error as? APIError { return apiError.message }
        if error is URLError { return "Couldn't reach Pocket Pager. Check your connection." }
        return "Pocket Pager sent an unexpected response. Try again later."
    }
}
