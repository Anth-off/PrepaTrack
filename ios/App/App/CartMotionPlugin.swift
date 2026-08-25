import Capacitor
import CoreMotion
import Foundation

/**
 * Source Core Motion de l'application installée. WKWebView peut cesser de
 * livrer `devicemotion` sans erreur ; le gestionnaire natif fournit ici une
 * mesure explicite et contrôlable tant que PrepaTrack reste au premier plan.
 */
@objc(CartMotionPlugin)
public final class CartMotionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CartMotionPlugin"
    public let jsName = "CartMotion"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let manager = CMMotionManager()
    private let motionQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "com.n0thytvoff.prepatrack.cart-motion"
        queue.qualityOfService = .userInitiated
        queue.maxConcurrentOperationCount = 1
        return queue
    }()

    @objc func start(_ call: CAPPluginCall) {
        guard manager.isDeviceMotionAvailable else {
            call.reject("Les capteurs de mouvement ne sont pas disponibles.")
            return
        }

        manager.stopDeviceMotionUpdates()
        manager.deviceMotionUpdateInterval = 1.0 / 50.0
        manager.startDeviceMotionUpdates(to: motionQueue) { [weak self] motion, error in
            guard let self else { return }
            if let error {
                DispatchQueue.main.async {
                    self.notifyListeners("motionError", data: ["message": error.localizedDescription])
                }
                return
            }
            guard let acceleration = motion?.userAcceleration else { return }
            let gravity = 9.80665
            DispatchQueue.main.async {
                self.notifyListeners("sample", data: [
                    "at": Date().timeIntervalSince1970 * 1_000,
                    "x": acceleration.x * gravity,
                    "y": acceleration.y * gravity,
                    "z": acceleration.z * gravity,
                ])
            }
        }
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        manager.stopDeviceMotionUpdates()
        call.resolve()
    }

    deinit {
        manager.stopDeviceMotionUpdates()
        motionQueue.cancelAllOperations()
    }
}
