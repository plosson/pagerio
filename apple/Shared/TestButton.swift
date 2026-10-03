import PagerKit
import SwiftUI

struct TestButton: View {
    let pages: PagesStore
    /// False when another action (such as Open Settings) is the screen's one orange button.
    var prominent = true
    @State private var isSending = false

    var body: some View {
        Button {
            Task {
                isSending = true
                await pages.sendTest()
                isSending = false
            }
        } label: {
            Label(isSending ? "Sending…" : "Test my pager", systemImage: "bell.fill")
        }
        .buttonStyle(TestButtonStyle(prominent: prominent))
        .disabled(isSending)
    }
}

private struct TestButtonStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        if prominent {
            PrimaryButtonStyle().makeBody(configuration: configuration)
        } else {
            SecondaryButtonStyle().makeBody(configuration: configuration)
        }
    }
}
