import PagerKit
import SwiftUI

struct TestButton: View {
    let pages: PagesStore
    @State private var isSending = false

    var body: some View {
        Button {
            Task {
                isSending = true
                await pages.sendTest()
                isSending = false
            }
        } label: {
            Label(isSending ? "Sending…" : "Test my pager", systemImage: "bell.and.waves.left.and.right")
        }
        .disabled(isSending)
    }
}
