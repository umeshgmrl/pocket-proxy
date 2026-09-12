import Foundation

struct NodeInstallation {
    let executable: String
    let version: String
}
struct NodeDiscoveryError: LocalizedError {
    let details: String
    var errorDescription: String? { details }
}

// Finder does not inherit shell setup. Discover existing runtimes directly;
// never source shell profiles, download a runtime, or modify the user's PATH.
enum NodeDiscovery {
    static func candidates(environment: [String: String], home: String) -> [String] {
        if let override = environment["POCKET_PROXY_NODE"], !override.isEmpty { return [override] }
        var paths = (environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/node" }
        paths += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "\(home)/.volta/bin/node", "\(home)/.asdf/shims/node", "\(home)/.local/share/mise/shims/node", "\(home)/Library/Application Support/fnm/aliases/default/bin/node", "\(home)/.local/share/fnm/aliases/default/bin/node"]
        let nvm = environment["NVM_DIR"] ?? "\(home)/.nvm"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: "\(nvm)/versions/node") {
            paths += versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }.map { "\(nvm)/versions/node/\($0)/bin/node" }
        }
        var seen = Set<String>()
        return paths.filter { $0.hasPrefix("/") && seen.insert($0).inserted }
    }
    static func find(environment: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) throws -> NodeInstallation {
        var rejected = [String]()
        for candidate in candidates(environment: environment, home: home) {
            guard FileManager.default.isExecutableFile(atPath: candidate) else { continue }
            let process = Process(), output = Pipe(), done = DispatchSemaphore(value: 0)
            process.executableURL = URL(fileURLWithPath: candidate)
            process.arguments = ["-p", "JSON.stringify({version:process.versions.node,executable:process.execPath})"]
            var env = environment
            env.removeValue(forKey: "NODE_OPTIONS")
            process.environment = env
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { _ in done.signal() }
            do { try process.run() } catch { rejected.append(candidate); continue }
            if done.wait(timeout: .now() + 3) == .timedOut {
                process.terminate()
                rejected.append("\(candidate) (timed out)")
                continue
            }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            guard process.terminationStatus == 0, let value = try? JSONSerialization.jsonObject(with: data) as? [String: String], let version = value["version"], let major = Int(version.split(separator: ".").first ?? ""), let executable = value["executable"], executable.hasPrefix("/") else { rejected.append(candidate); continue }
            guard major >= 22 else { rejected.append("\(candidate) (Node \(version))"); continue }
            return NodeInstallation(executable: executable, version: version)
        }
        let extra = rejected.isEmpty ? "" : "\n\nUnsupported or unavailable installation:\n" + rejected.joined(separator: "\n")
        throw NodeDiscoveryError(details: "Pocket Proxy requires Node.js 22 or newer installed on this Mac. Install Node.js, then reopen the app. Homebrew, nvm, and common version-manager locations are detected automatically.\n\nFor a custom installation, set POCKET_PROXY_NODE to the full executable path before launch." + extra)
    }
}

final class NodeHost {
    var process: Process?
    var onReady: ((URL) -> Void)?
    var onFailure: ((String) -> Void)?
    var onExit: ((Int32) -> Void)?
    var onShutdownFailure: ((String) -> Void)?
    private var output = Pipe()
    private var errors = Pipe()
    private var partial = Data()
    private var diagnostic = ""
    private let queue = DispatchQueue(label: "local.pocketproxy.output")
    private var started = false
    var running: Bool { process?.isRunning == true }

    func start() {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let node = try NodeDiscovery.find()
                DispatchQueue.main.async { self.launch(node) }
            } catch { DispatchQueue.main.async { self.onFailure?(error.localizedDescription) } }
        }
    }
    private func launch(_ node: NodeInstallation) {
        guard let resources = Bundle.main.resourceURL else { onFailure?("The application bundle is incomplete. Reinstall Pocket Proxy."); return }
        let backend = resources.appendingPathComponent("src/main.js")
        guard FileManager.default.fileExists(atPath: backend.path) else { onFailure?("The application backend is missing. Reinstall Pocket Proxy."); return }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: node.executable)
        child.arguments = ["--experimental-require-module", backend.path, "--desktop-child"]
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "NODE_OPTIONS")
        child.environment = env
        child.currentDirectoryURL = resources
        child.standardOutput = output
        child.standardError = errors
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            self.queue.async { self.consume(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            self.queue.async { self.diagnostic = String((self.diagnostic + String(decoding: data, as: UTF8.self)).suffix(8192)) }
        }
        child.terminationHandler = { child in
            self.queue.async {
                let details = self.diagnostic
                DispatchQueue.main.async {
                    self.onExit?(child.terminationStatus)
                    if !self.started { self.onFailure?("The local server could not start.\n\n\(details.isEmpty ? "Check whether Pocket Proxy is already running or its ports are in use." : details)") }
                }
            }
        }
        process = child
        do { try child.run() } catch { onFailure?("Could not start Node.js: \(error.localizedDescription)") }
    }
    private func consume(_ data: Data) {
        partial.append(data)
        while let newline = partial.firstIndex(of: 10) {
            let line = String(decoding: partial[..<newline], as: UTF8.self)
            partial.removeSubrange(...newline)
            for prefix in ["POCKET_PROXY_READY ", "POCKET_PROXY_SHUTDOWN_FAILED "] where line.hasPrefix(prefix) {
                let payload = Data(line.dropFirst(prefix.count).utf8)
                guard let value = try? JSONSerialization.jsonObject(with: payload) as? [String: String] else { continue }
                if prefix == "POCKET_PROXY_READY ", let text = value["url"], let url = URL(string: text), url.scheme == "http", url.host == "127.0.0.1" {
                    DispatchQueue.main.async { self.started = true; self.onReady?(url) }
                } else if let message = value["message"] { DispatchQueue.main.async { self.onShutdownFailure?(message) } }
            }
        }
        if partial.count > 65536 { partial.removeAll() }
    }
    func stop() { if running { process?.terminate() } }
}
