import Cocoa
import Security
import CryptoKit

func finish(_ result: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}
func fail(_ message: String, _ code: Int = 0) -> Never {
    finish(["ok": false, "message": message, "errorCode": code])
}
func certificate(_ file: String, fingerprint: String) -> SecCertificate {
    guard let pem = try? String(contentsOfFile: file, encoding: .utf8) else { fail("Could not read the app's public certificate.") }
    let base64 = pem.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "").replacingOccurrences(of: "-----END CERTIFICATE-----", with: "").components(separatedBy: .whitespacesAndNewlines).joined()
    guard let der = Data(base64Encoded: base64), let cert = SecCertificateCreateWithData(nil, der as CFData) else { fail("The certificate file is invalid.") }
    let actual = SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined()
    guard actual == fingerprint.replacingOccurrences(of: ":", with: "").uppercased() else { fail("The certificate changed during setup. Reopen setup and try again.") }
    return cert
}
let args = CommandLine.arguments
if args.count == 4 && args[1] == "--verify" {
    guard let port = Int(args[2]), (1...65535).contains(port), args[3].range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { fail("Invalid HTTPS check parameters.") }
    let config = URLSessionConfiguration.ephemeral
    config.connectionProxyDictionary = ["HTTPSEnable": 1, "HTTPSProxy": "127.0.0.1", "HTTPSPort": port, "ExceptionsList": []] as [String: Any]
    config.timeoutIntervalForRequest = 8
    config.timeoutIntervalForResource = 10
    config.urlCache = nil
    let session = URLSession(configuration: config)
    let url = URL(string: "https://pocket-proxy-check.invalid/\(args[3])")!
    // No custom trust delegate, CA override or insecure exception: macOS must
    // trust the real certificate served by the running local proxy.
    session.dataTask(with: url) { data, response, error in
        if let error = error as NSError? { fail(error.localizedDescription, error.code) }
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              let data = data, String(decoding: data, as: UTF8.self) == args[3] else { fail("The local HTTPS check returned an unexpected response.") }
        finish(["ok": true])
    }.resume()
    RunLoop.main.run()
} else if args.count == 4 && args[1] == "--trust" {
    let cert = certificate(args[2], fingerprint: args[3])
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    DispatchQueue.main.async {
        // Use the logged-in user's keychain and native Security authorization UI.
        // Do not elevate a background shell or change the authorization database.
        var login: SecKeychain?
        let opened = SecKeychainOpen(NSHomeDirectory() + "/Library/Keychains/login.keychain-db", &login)
        guard opened == errSecSuccess, let login = login else { fail("Unlock your login keychain and try again.", Int(opened)) }
        let query: [String: Any] = [kSecClass as String: kSecClassCertificate, kSecValueRef as String: cert, kSecUseKeychain as String: login,
                                   kSecAttrLabel as String: "Pocket Proxy HTTPS - " + args[3].replacingOccurrences(of: ":", with: "").prefix(8)]
        let imported = SecItemAdd(query as CFDictionary, nil)
        guard imported == errSecSuccess || imported == errSecDuplicateItem else { fail("macOS could not import the certificate: \(SecCopyErrorMessageString(imported, nil) as String? ?? "Unknown error")", Int(imported)) }
        var existing: CFArray?
        let copied = SecTrustSettingsCopyTrustSettings(cert, .user, &existing)
        if copied == errSecSuccess {
            let settings = existing as? [[String: Any]] ?? []
            if settings.isEmpty { finish(["ok": true]) }
            // Preserve pre-existing user policies. The app verifies before invoking
            // us, so a remaining conflict needs an explicit Keychain edit.
            fail("This certificate already has custom trust settings. Use the Keychain fallback to review its SSL trust.")
        }
        guard copied == errSecItemNotFound || copied == errSecNoTrustSettings else {
            fail("Unable to read existing certificate trust settings.", Int(copied))
        }
        let ssl: [String: Any] = [kSecTrustSettingsPolicy as String: SecPolicyCreateSSL(true, nil), kSecTrustSettingsResult as String: SecTrustSettingsResult.trustRoot.rawValue]
        let status = SecTrustSettingsSetTrustSettings(cert, .user, [ssl] as CFArray)
        guard status == errSecSuccess else {
            fail(status == errSecUserCanceled ? "Setup was cancelled. You can try again when ready." : "macOS could not complete native approval. Use the Keychain fallback to finish setup.", Int(status))
        }
        finish(["ok": true])
    }
    app.run()
} else { fail("Unknown certificate setup action.") }
