import ActivityKit
import Foundation

public struct PrepaTrackActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var phase: String
        public var detail: String
        public var packages: Int
        public var plannedPackages: Int
        public var recording: Bool
        public var phaseStartedAt: Date
    }

    public var workdayId: String
    public var workdayStartedAt: Date
}
