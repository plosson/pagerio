import Foundation

/// Hardware model identifier such as "iPhone17,1" or "Mac15,3".
public enum DeviceModel {
    public static var current: String {
        #if os(macOS)
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        guard size > 0 else { return "Mac" }
        var buffer = [UInt8](repeating: 0, count: size)
        sysctlbyname("hw.model", &buffer, &size, nil, 0)
        let model = String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
        return model.isEmpty ? "Mac" : model
        #else
        var info = utsname()
        uname(&info)
        let bytes = withUnsafeBytes(of: info.machine) { Array($0.prefix { $0 != 0 }) }
        let model = String(decoding: bytes, as: UTF8.self)
        return model.isEmpty ? "iPhone" : model
        #endif
    }
}
