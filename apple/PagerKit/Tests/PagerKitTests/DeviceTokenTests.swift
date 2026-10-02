import Foundation
import Testing
@testable import PagerKit

@Suite struct DeviceTokenTests {
    @Test func hexEncodesEveryByteWithLeadingZeros() {
        #expect(DeviceToken.hex(Data([0x00, 0x0a, 0xab, 0xff])) == "000aabff")
    }

    @Test func emptyDataGivesEmptyString() {
        #expect(DeviceToken.hex(Data()) == "")
    }

    @Test func modelIsNeverEmpty() {
        #expect(!DeviceModel.current.isEmpty)
        #expect(!DeviceModel.current.contains("\0"))
    }

    @Test func platformMatchesTheHost() {
        #expect(DevicePlatform.current == .macos) // swift test runs on macOS
    }
}
