import PagerKit
import SwiftUI

struct PushTokenView: View {
    let model: PushTokenModel

    var body: some View {
        VStack(spacing: 12) {
            Text("Pocket Pager").font(.title2.bold())
            Text("APNs environment: \(ApnsEnvironment.current.rawValue)")
                .foregroundStyle(.secondary)
            if let hex = model.hex {
                Text(hex)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                Button("Copy token") { Clipboard.copy(hex) }
                    .buttonStyle(.borderedProminent)
            } else if let error = model.error {
                Text(error).foregroundStyle(.red)
            } else {
                ProgressView("Registering for notifications…")
            }
        }
        .padding()
    }
}
