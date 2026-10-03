// macOS counterpart of AudioCapture.exe. Speaks the same protocol so main.js doesn't care which one runs:
//   list            -> stderr {"sessions":[{"pid","name","state"}]}
//   capture <pid>   -> stderr {"started":true,...}, stdout [uint32 LE length][float32 interleaved PCM]
//   capture-system  -> same, everything except FrogShare itself
//   gpu-priority    -> no-op (no macOS equivalent)
// "stop" or EOF on stdin ends a capture. Process taps need macOS 14.2+.
import AppKit
import CoreAudio
import Darwin
import Foundation

func writeJson(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
        let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  writeJson(["error": message])
  exit(1)
}

// ======== Core Audio property helpers ========
func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func readValue<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
  var addr = address(selector)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0) }
  return status == noErr ? value : nil
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = address(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
  guard status == noErr, let str = value?.takeRetainedValue() else { return nil }
  return str as String
}

func readObjectList(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
  var addr = address(selector)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

// ======== Process identity ========
func parentPid(of pid: pid_t) -> pid_t? {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.size
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
  return info.kp_eproc.e_ppid
}

func processName(_ pid: pid_t) -> String? {
  var buf = [CChar](repeating: 0, count: 256)
  return proc_name(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : nil
}

// Browsers play audio from helper processes (Chrome Helper, WebKit GPU); macOS tracks which app
// they belong to so the list can say "Safari" instead of "com.apple.WebKit.GPU"
typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
let responsibleFn: ResponsibleFn? = {
  guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
  return unsafeBitCast(sym, to: ResponsibleFn.self)
}()

func responsiblePid(_ pid: pid_t) -> pid_t {
  guard let fn = responsibleFn else { return pid }
  let r = fn(pid)
  return r > 0 ? r : pid
}

// FrogShare's own processes (Electron main + its helpers, all children of our parent)
let ownerPid = getppid()
func isOwnProcess(_ pid: pid_t) -> Bool {
  if pid == getpid() || pid == ownerPid { return true }
  if parentPid(of: pid) == ownerPid { return true }
  return responsiblePid(pid) == ownerPid
}

func displayName(_ pid: pid_t, bundleId: String?) -> String {
  let owner = responsiblePid(pid)
  if let app = NSRunningApplication(processIdentifier: owner), let name = app.localizedName {
    return name
  }
  return processName(owner) ?? bundleId ?? "PID \(pid)"
}

// ======== list ========
struct AudioProcess {
  let object: AudioObjectID
  let pid: pid_t
  // The app it belongs to: the pid itself, or the browser/Electron app for a helper process
  let owner: pid_t
  let running: Bool
}

func audioProcesses() -> [AudioProcess] {
  readObjectList(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).compactMap { object in
    guard let pid = readValue(object, kAudioProcessPropertyPID, pid_t(-1)), pid > 0 else { return nil }
    let running = (readValue(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0
    return AudioProcess(object: object, pid: pid, owner: responsiblePid(pid), running: running)
  }
}

// One entry per app (Discord alone has four audio processes); its pid captures the app and all its helpers
@available(macOS 14.2, *)
func listSessions() {
  var byOwner: [pid_t: (bundleId: String?, running: Bool)] = [:]
  for proc in audioProcesses() where !isOwnProcess(proc.pid) {
    let prev = byOwner[proc.owner]
    let bundleId = prev?.bundleId ?? (proc.pid == proc.owner ? readString(proc.object, kAudioProcessPropertyBundleID) : nil)
    byOwner[proc.owner] = (bundleId, (prev?.running ?? false) || proc.running)
  }
  var sessions: [[String: Any]] = []
  for (owner, info) in byOwner {
    // Every daemon that ever touched Core Audio has a process object; keep the ones a person would pick
    let isApp = NSRunningApplication(processIdentifier: owner)?.activationPolicy == .regular
    guard info.running || isApp else { continue }
    sessions.append(["pid": Int(owner), "name": displayName(owner, bundleId: info.bundleId), "state": info.running ? "active" : "inactive"])
  }
  sessions.sort { a, b in
    let aa = a["state"] as! String == "active", ba = b["state"] as! String == "active"
    if aa != ba { return aa }
    return (a["name"] as! String).localizedCaseInsensitiveCompare(b["name"] as! String) == .orderedAscending
  }
  writeJson(["sessions": sessions])
}

// ======== capture ========
@available(macOS 14.2, *)
final class TapCapture {
  var tapID = AudioObjectID(kAudioObjectUnknown)
  var aggregateID = AudioObjectID(kAudioObjectUnknown)
  var procID: AudioDeviceIOProcID?
  let queue = DispatchQueue(label: "frogshare.audio", qos: .userInteractive)
  var scratch = [Float]()

  func start(pid: pid_t?) {
    let description: CATapDescription
    if let pid {
      let objects = audioProcesses().filter { $0.pid == pid || $0.owner == pid }.map(\.object)
      guard !objects.isEmpty else { fail("Esse app não está mais tocando som (PID \(pid))") }
      description = CATapDescription(stereoMixdownOfProcesses: objects)
    } else {
      let own = audioProcesses().filter { isOwnProcess($0.pid) }.map(\.object)
      description = CATapDescription(stereoGlobalTapButExcludeProcesses: own)
    }
    description.name = "FrogShare"
    description.isPrivate = true
    description.muteBehavior = .unmuted

    var status = AudioHardwareCreateProcessTap(description, &tapID)
    guard status == noErr else { fail("Não deu para criar a captura de som (\(status))") }

    guard let format = readValue(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription()) else {
      cleanup(); fail("Não deu para ler o formato do som")
    }
    guard format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mBitsPerChannel == 32 else {
      cleanup(); fail("Formato de som inesperado")
    }

    // The tap is only readable through an aggregate device; the default output keeps it clocked
    var outputDevice = AudioObjectID(kAudioObjectUnknown)
    outputDevice = readValue(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, outputDevice) ?? outputDevice
    let outputUID = readString(outputDevice, kAudioDevicePropertyDeviceUID)
    var config: [String: Any] = [
      kAudioAggregateDeviceNameKey: "FrogShare Tap",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]]
    ]
    if let outputUID {
      config[kAudioAggregateDeviceMainSubDeviceKey] = outputUID
      config[kAudioAggregateDeviceSubDeviceListKey] = [[kAudioSubDeviceUIDKey: outputUID]]
    }
    status = AudioHardwareCreateAggregateDevice(config as CFDictionary, &aggregateID)
    guard status == noErr else { cleanup(); fail("Não deu para preparar o dispositivo de captura (\(status))") }

    let channels = Int(format.mChannelsPerFrame)
    let interleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, input, _, _, _ in
      self?.deliver(UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)), channels: channels, interleaved: interleaved)
    }
    guard status == noErr else { cleanup(); fail("Não deu para iniciar a captura (\(status))") }
    status = AudioDeviceStart(aggregateID, procID)
    guard status == noErr else { cleanup(); fail("Não deu para iniciar a captura (\(status))") }

    var info: [String: Any] = ["started": true, "sampleRate": Int(format.mSampleRate), "channels": channels,
                               "bitsPerSample": 32, "mode": pid == nil ? "system" : "process"]
    if let pid { info["pid"] = Int(pid) }
    writeJson(info)
  }

  func deliver(_ buffers: UnsafeMutableAudioBufferListPointer, channels: Int, interleaved: Bool) {
    if interleaved {
      for buf in buffers {
        guard let data = buf.mData, buf.mDataByteSize > 0 else { continue }
        writeFrame(UnsafeRawBufferPointer(start: data, count: Int(buf.mDataByteSize)))
      }
      return
    }
    // One buffer per channel; the renderer expects them interleaved
    guard buffers.count >= channels, channels > 0 else { return }
    let frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
    guard frames > 0 else { return }
    if scratch.count < frames * channels { scratch = [Float](repeating: 0, count: frames * channels) }
    for ch in 0..<channels {
      guard let src = buffers[ch].mData?.assumingMemoryBound(to: Float.self) else { return }
      for i in 0..<frames { scratch[i * channels + ch] = src[i] }
    }
    scratch.withUnsafeBytes { writeFrame(UnsafeRawBufferPointer(rebasing: $0[0..<(frames * channels * MemoryLayout<Float>.size)])) }
  }

  func writeFrame(_ bytes: UnsafeRawBufferPointer) {
    var len = UInt32(bytes.count).littleEndian
    let ok = withUnsafeBytes(of: &len) { fwrite($0.baseAddress, 1, 4, stdout) == 4 }
      && fwrite(bytes.baseAddress, 1, bytes.count, stdout) == bytes.count
    fflush(stdout)
    // Electron went away; Core Audio drops a dead process's private tap and aggregate device
    if !ok { exit(0) }
  }

  func cleanup() {
    if let procID, aggregateID != kAudioObjectUnknown {
      AudioDeviceStop(aggregateID, procID)
      AudioDeviceDestroyIOProcID(aggregateID, procID)
    }
    procID = nil
    if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
    aggregateID = AudioObjectID(kAudioObjectUnknown)
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
    tapID = AudioObjectID(kAudioObjectUnknown)
  }
}

// ======== main ========
signal(SIGPIPE, SIG_IGN)
let args = CommandLine.arguments.dropFirst()
guard let command = args.first else {
  fail("Usage: AudioCapture list | capture <pid> | capture-system")
}

switch command {
case "gpu-priority":
  writeJson(["class": 4])
case "list":
  guard #available(macOS 14.2, *) else { fail("Escolher o som de um app exige macOS 14.2 ou mais novo") }
  listSessions()
case "capture", "capture-system":
  guard #available(macOS 14.2, *) else { fail("Capturar som exige macOS 14.2 ou mais novo") }
  var pid: pid_t?
  if command == "capture" {
    guard let raw = args.dropFirst().first, let p = pid_t(raw), p > 0 else { fail("PID inválido") }
    pid = p
  }
  let capture = TapCapture()
  capture.start(pid: pid)
  Thread {
    while let line = readLine() {
      if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
    }
    // Not on the IO queue: AudioDeviceStop waits for the in-flight IO cycle to finish
    capture.cleanup()
    exit(0)
  }.start()
  dispatchMain()
default:
  fail("Comando desconhecido: \(command)")
}
