import Foundation
import Observation

@MainActor @Observable
public final class PagesStore {
    public private(set) var pages: [PageSummary] = []
    public private(set) var lastError: String?
    public private(set) var isLoading = false
    public private(set) var isLoadingMore = false
    /// Pages kept in the last 30 days and devices that ring, when the server says.
    public private(set) var total: Int?
    public private(set) var devices: Int?
    /// The last load failed to reach the server; `pages` are what was loaded at `loadedAt`.
    public private(set) var isOffline = false
    public private(set) var loadedAt: Date?
    public static let pageSize = 50
    private var nextBefore: String?
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
                let loaded = try await api.pages(limit: Self.pageSize)
                if started == generation {
                    (pages, nextBefore) = Self.merge(fresh: loaded.pages, freshNext: loaded.nextBefore, old: pages, oldNext: nextBefore)
                    total = loaded.total
                    devices = loaded.devices
                    loadedAt = Date()
                    isOffline = false
                    lastError = nil
                }
            } catch {
                if started == generation { fail(error) }
            }
        } while refreshPending
    }

    public var hasMore: Bool { nextBefore != nil }

    /// Appends the next pages. Dropped if a refresh or reset changed the list meanwhile.
    public func loadMore() async {
        guard let cursor = nextBefore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let started = generation
        do {
            let loaded = try await api.pages(before: cursor, limit: Self.pageSize)
            guard started == generation, cursor == nextBefore else { return }
            let known = Set(pages.map(\.id))
            pages += loaded.pages.filter { !known.contains($0.id) }
            nextBefore = loaded.nextBefore
            lastError = nil
        } catch {
            if started == generation { fail(error) }
        }
    }

    /// A refresh loads the newest pages; pages already loaded with "Load more" stay below them.
    static func merge(fresh: [PageSummary], freshNext: String?, old: [PageSummary], oldNext: String?) -> ([PageSummary], String?) {
        guard freshNext != nil, let last = fresh.last,
              let index = old.firstIndex(where: { $0.id == last.id }), index < old.count - 1
        else { return (fresh, freshNext) }
        let known = Set(fresh.map(\.id))
        return (fresh + old[(index + 1)...].filter { !known.contains($0.id) }, oldNext)
    }

    private func fail(_ error: any Error) {
        lastError = Self.describe(error)
        isOffline = error is URLError
    }

    /// The server stores the page before answering 202, so an immediate refresh shows it.
    public func sendTest() async {
        let started = generation
        do {
            try await api.sendTest()
            await refresh()
        } catch {
            if started == generation { fail(error) }
        }
    }

    /// Forgets everything; loads already in flight belong to the old account and are discarded.
    public func reset() {
        generation += 1
        refreshPending = false
        pages = []
        nextBefore = nil
        total = nil
        devices = nil
        isOffline = false
        loadedAt = nil
        lastError = nil
    }

    static func describe(_ error: any Error) -> String {
        if let apiError = error as? APIError { return apiError.message }
        if error is URLError { return "Couldn't reach Pocket Pager. Check your connection." }
        return "Pocket Pager sent an unexpected response. Try again later."
    }
}
