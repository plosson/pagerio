import Observation

@MainActor @Observable
public final class PagesStore {
    public private(set) var pages: [PageSummary] = []
    public private(set) var lastError: String?
    public private(set) var isLoading = false
    private let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    public func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            pages = try await api.pages().pages
            lastError = nil
        } catch {
            lastError = Self.describe(error)
        }
    }

    /// The server stores the page before answering 202, so an immediate refresh shows it.
    public func sendTest() async {
        do {
            try await api.sendTest()
            await refresh()
        } catch {
            lastError = Self.describe(error)
        }
    }

    public func reset() {
        pages = []
        lastError = nil
    }

    static func describe(_ error: any Error) -> String {
        (error as? APIError)?.message ?? "Couldn't reach Pocket Pager. Check your connection."
    }
}
