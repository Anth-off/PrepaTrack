import ActivityKit
import SwiftUI
import WidgetKit

private let accent = Color(red: 1, green: 0.61, blue: 0)
private let ink = Color(red: 0.035, green: 0.05, blue: 0.07)

struct PrepaTrackLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PrepaTrackActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    statusIcon(context.state.recording)
                    Text(context.state.phase).font(.headline)
                    Spacer()
                    Text(context.state.phaseStartedAt, style: .timer)
                        .font(.title2.bold()).monospacedDigit().foregroundStyle(accent)
                }
                HStack {
                    Text(context.state.detail).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    packageCount(context.state)
                }
            }
            .padding()
            .activityBackgroundTint(ink)
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { statusIcon(context.state.recording) }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.phaseStartedAt, style: .timer)
                        .monospacedDigit().foregroundStyle(accent)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.phase).font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text(context.state.detail).lineLimit(1)
                        Spacer()
                        packageCount(context.state)
                    }.font(.caption)
                }
            } compactLeading: {
                statusIcon(context.state.recording)
            } compactTrailing: {
                Text(context.state.phaseStartedAt, style: .timer)
                    .monospacedDigit().foregroundStyle(accent).frame(maxWidth: 54)
            } minimal: {
                statusIcon(context.state.recording)
            }.keylineTint(accent)
        }
    }

    @ViewBuilder private func packageCount(_ state: PrepaTrackActivityAttributes.ContentState) -> some View {
        if state.plannedPackages > 0 {
            Text("\(state.packages) / \(state.plannedPackages) colis")
                .monospacedDigit().fontWeight(.semibold)
        } else {
            Text("\(state.packages) colis").monospacedDigit().fontWeight(.semibold)
        }
    }

    private func statusIcon(_ recording: Bool) -> some View {
        Group {
            if recording {
                HStack(spacing: 2) {
                    ForEach(Array([7, 13, 9, 16, 7].enumerated()), id: \.offset) { _, height in
                        Capsule().fill(accent).frame(width: 2, height: CGFloat(height))
                    }
                }.accessibilityLabel("Enregistrement en cours")
            } else {
                Image(systemName: "shippingbox.fill")
                    .foregroundStyle(accent).accessibilityLabel("PrepaTrack")
            }
        }
    }
}
