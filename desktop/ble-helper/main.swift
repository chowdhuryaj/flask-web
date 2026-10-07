// Totem-Flask BLE helper: ZMK Studio RPC over CoreBluetooth, for a keyboard
// that is already connected to this Mac as a Bluetooth keyboard.
//
// Why: Chromium's Web Bluetooth chooser only offers advertising devices and
// devices Chromium itself connected. ZMK stops advertising while its profile
// is connected, so the Totem never shows up there. CoreBluetooth's
// retrieveConnectedPeripherals(withServices:) does return system-connected
// peripherals, and connect() shares the existing link.
//
// Spawned by desktop/main.js (child_process.spawn), so TCC attributes
// Bluetooth to Totem-Flask.app. Never run it from a terminal or an agent's
// shell: TCC then checks that process's Info.plist and aborts this one.
//
// Usage: ble-helper <name>   (<name>: HID product or board name, e.g. "Totem")
//
// stdio protocol, one item per line:
//   stdout (JSON): {"ev":"ready","name":N} | {"ev":"data","b64":B}
//                  | {"ev":"error","code":C,"msg":M} | {"ev":"closed"}
//                  C: unauthorized | off | notFound | timeout | failed.
//                  An error is always followed by closed, then exit.
//   stdin: one base64 line = bytes to write to the Studio RPC characteristic.
//          "close" or EOF = drop our GATT client and exit (macOS keeps the HID link).

import CoreBluetooth
import Foundation

let studioService = CBUUID(string: "00000000-0196-6107-C967-C5CFB1C2482A")
let rpcChar = CBUUID(string: "00000001-0196-6107-C967-C5CFB1C2482A")
let hidService = CBUUID(string: "1812")
let wantName = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let findTimeout = 15.0   // seconds from Bluetooth on to ready

func emit(_ obj: [String: String]) {
    guard var d = try? JSONSerialization.data(withJSONObject: obj) else { return }
    d.append(0x0A)
    FileHandle.standardOutput.write(d)
}

func finish(_ code: Int32) -> Never {
    emit(["ev": "closed"])
    exit(code)
}

func fail(_ code: String, _ msg: String) -> Never {
    emit(["ev": "error", "code": code, "msg": msg])
    finish(1)
}

final class Link: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var central: CBCentralManager!
    var peripheral: CBPeripheral?
    var rpc: CBCharacteristic?
    var pending = Data()     // bytes from stdin not yet written
    var writing = false      // one write-with-response in flight
    var ready = false

    func start() { central = CBCentralManager(delegate: self, queue: .main) }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn: find()
        case .unauthorized: fail("unauthorized", "Bluetooth permission denied")
        case .poweredOff: fail("off", "Bluetooth is off")
        case .unsupported: fail("failed", "Bluetooth LE is not supported on this Mac")
        default: break       // unknown / resetting: wait (the TCC prompt may be up)
        }
    }

    func find() {
        guard peripheral == nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + findTimeout) { [self] in
            if !ready { fail("timeout", "no answer from \(peripheral?.name ?? "the keyboard")") }
        }
        // The split peripheral ("Totem R") talks to the left half, never Studio.
        let notRight = { (p: CBPeripheral) in !(p.name ?? "").hasSuffix(" R") }
        // Either name may be the longer one ("Totem" / "TOTEM", "Imprint" / "Cyboard Imprint").
        let named = { (p: CBPeripheral) in
            guard let n = p.name, !n.isEmpty, !wantName.isEmpty else { return false }
            return n.localizedCaseInsensitiveContains(wantName) || wantName.localizedCaseInsensitiveContains(n)
        }
        let studio = central.retrieveConnectedPeripherals(withServices: [studioService]).filter(notRight)
        // Fallback: macOS may not have cached the Studio service; any connected
        // HID keyboard with the right name, Studio checked after discovery.
        let hid = central.retrieveConnectedPeripherals(withServices: [hidService]).filter { notRight($0) && named($0) }
        guard let p = studio.first(where: named) ?? studio.first ?? hid.first else {
            fail("notFound", "no connected keyboard offers ZMK Studio")
        }
        peripheral = p
        p.delegate = self
        central.connect(p)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices([studioService])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        fail("failed", "connect failed: \(error?.localizedDescription ?? "unknown error")")
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        finish(0)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let s = p.services?.first(where: { $0.uuid == studioService }) else {
            fail("failed", "\(p.name ?? "The keyboard") is connected but does not offer ZMK Studio over Bluetooth")
        }
        p.discoverCharacteristics([rpcChar], for: s)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        guard let c = s.characteristics?.first(where: { $0.uuid == rpcChar }) else {
            fail("failed", "ZMK Studio RPC characteristic missing")
        }
        rpc = c
        p.setNotifyValue(true, for: c)    // the characteristic indicates
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
        if let error { fail("failed", "could not enable indications: \(error.localizedDescription)") }
        guard !ready else { return }
        ready = true
        emit(["ev": "ready", "name": p.name ?? ""])
        pump()
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        guard error == nil, let v = c.value, !v.isEmpty else { return }
        emit(["ev": "data", "b64": v.base64EncodedString()])
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor c: CBCharacteristic, error: Error?) {
        if let error { fail("failed", "write failed: \(error.localizedDescription)") }
        writing = false
        pump()
    }

    func send(_ d: Data) {
        pending.append(d)
        pump()
    }

    /// The characteristic is WRITE | READ | INDICATE: write-with-response only.
    /// Chunk size is ATT_MTU - 3 (the .withoutResponse length): the
    /// .withResponse length is 512 (a prepared "long write"), which Zephyr
    /// refuses unless CONFIG_BT_ATT_PREPARE_COUNT > 0. The firmware joins
    /// writes in its RX ring, so any split is valid.
    func pump() {
        guard ready, !writing, !pending.isEmpty, let p = peripheral, let c = rpc else { return }
        let n = max(20, p.maximumWriteValueLength(for: .withoutResponse))
        let chunk = Data(pending.prefix(n))
        pending.removeFirst(chunk.count)
        writing = true
        p.writeValue(chunk, for: c, type: .withResponse)
    }

    func close() {
        if let p = peripheral { central.cancelPeripheralConnection(p) }   // our client only
        finish(0)
    }
}

let link = Link()
Thread.detachNewThread {
    while let line = readLine(), line != "close" {
        guard let d = Data(base64Encoded: line), !d.isEmpty else { continue }
        DispatchQueue.main.async { link.send(d) }
    }
    DispatchQueue.main.async { link.close() }
}
link.start()
dispatchMain()
