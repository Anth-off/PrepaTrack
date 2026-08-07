import Capacitor

final class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
        bridge?.registerPluginInstance(RecordingPlugin())
        bridge?.registerPluginInstance(DurableStoragePlugin())
    }
}
