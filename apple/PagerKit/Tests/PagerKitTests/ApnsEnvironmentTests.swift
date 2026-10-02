import Foundation
import Testing
@testable import PagerKit

@Suite struct ApnsEnvironmentTests {
    @Test func productionOnlyForTheExactValue() {
        #expect(ApnsEnvironment.fromApsEnvironment("production") == .production)
    }

    @Test func developmentNilAndGarbageFallBackToSandbox() {
        for value in [nil, "development", "", "Production", " production", "prod", "$(APS_ENVIRONMENT)"] as [String?] {
            #expect(ApnsEnvironment.fromApsEnvironment(value) == .sandbox, "value: \(String(describing: value))")
        }
    }

    @Test func apiErrorLocalizedDescriptionIsTheServerMessage() {
        #expect((APIError(status: 400, code: "x", message: "Nope") as Error).localizedDescription == "Nope")
    }
}
