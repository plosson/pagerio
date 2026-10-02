import Foundation
import Security

public protocol SecretStore: Sendable {
    func read(_ key: String) -> String?
    func write(_ key: String, _ value: String?)
}

/// Generic-password items in the data-protection keychain, readable after first unlock
/// so a background launch (notification arrives while locked) can still authenticate.
public final class KeychainStore: SecretStore {
    private let service: String

    public init(service: String) {
        self.service = service
    }

    public func read(_ key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ key: String, _ value: String?) {
        SecItemDelete(baseQuery(key) as CFDictionary)
        guard let value else { return }
        var query = baseQuery(key)
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}

public final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String]

    public init(_ values: [String: String] = [:]) {
        self.values = values
    }

    public func read(_ key: String) -> String? {
        lock.withLock { values[key] }
    }

    public func write(_ key: String, _ value: String?) {
        lock.withLock { values[key] = value }
    }
}
