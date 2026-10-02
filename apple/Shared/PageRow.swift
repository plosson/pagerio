import PagerKit
import SwiftUI

struct PageRow: View {
    let page: PageSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(page.headline)
                .font(.headline)
                .lineLimit(2)
            if page.title != nil {
                Text(page.message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Text(page.createdAt, format: .relative(presentation: .named))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
