import ActivityKit
import Capacitor
import Foundation

@objc(LiveActivityPlugin)
public final class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    @objc func start(_ call: CAPPluginCall) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.resolve(["active": false])
            return
        }
        guard let workdayId = call.getString("workdayId") else {
            call.reject("workdayId manquant")
            return
        }
        let attributes = PrepaTrackActivityAttributes(
            workdayId: workdayId,
            workdayStartedAt: date(call, "workdayStartedAt")
        )
        let state = contentState(call)
        Task {
            await endAll()
            do {
                let activity = try Activity.request(
                    attributes: attributes,
                    content: ActivityContent(state: state, staleDate: nil),
                    pushType: nil
                )
                call.resolve(["active": true, "id": activity.id])
            } catch {
                call.reject("Impossible de démarrer l’activité en direct", nil, error)
            }
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        let state = contentState(call)
        Task {
            for activity in Activity<PrepaTrackActivityAttributes>.activities {
                await activity.update(ActivityContent(state: state, staleDate: nil))
            }
            call.resolve(["active": !Activity<PrepaTrackActivityAttributes>.activities.isEmpty])
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        Task {
            await endAll()
            call.resolve()
        }
    }

    private func contentState(_ call: CAPPluginCall) -> PrepaTrackActivityAttributes.ContentState {
        PrepaTrackActivityAttributes.ContentState(
            phase: call.getString("phase") ?? "Journée",
            detail: call.getString("detail") ?? "Vacation en cours",
            packages: call.getInt("packages") ?? 0,
            plannedPackages: call.getInt("plannedPackages") ?? 0,
            recording: call.getBool("recording") ?? false,
            phaseStartedAt: date(call, "phaseStartedAt")
        )
    }

    private func date(_ call: CAPPluginCall, _ key: String) -> Date {
        Date(timeIntervalSince1970: (call.getDouble(key) ?? Date().timeIntervalSince1970 * 1_000) / 1_000)
    }

    private func endAll() async {
        for activity in Activity<PrepaTrackActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}
