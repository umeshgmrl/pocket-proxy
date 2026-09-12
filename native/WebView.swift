import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var startURL: URL?
    #if RELEASE
    let host = NodeHost()
    var quitting = false
    var didLoad = false
    #endif
    init(url: URL? = nil) { startURL = url; super.init() }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Pocket Proxy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Pocket Proxy"
        window.delegate = self
        window.minSize = NSSize(width: 900, height: 640)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let url = startURL { webView.load(URLRequest(url: url)) }
        #if RELEASE
        if startURL == nil {
            webView.loadHTMLString("<html><body style='font-family:system-ui;background:#f8faf9;color:#276b55;display:grid;place-content:center;height:90vh;text-align:center'><h1>Pocket Proxy</h1><p>Finding Node.js and starting your local proxy…</p></body></html>", baseURL: nil)
            host.onReady = { url in
                self.didLoad = true
                self.startURL = url
                self.webView.load(URLRequest(url: url))
            }
            host.onFailure = { message in
                self.showError("Pocket Proxy could not start", message)
                NSApp.terminate(nil)
            }
            host.onExit = { _ in
                if self.quitting { NSApp.reply(toApplicationShouldTerminate: true) }
                else if self.didLoad {
                    self.showError("Pocket Proxy stopped", "The backend has exited. Its recovery helper will attempt to restore saved Mac proxy settings. Reopen the app to restart.")
                    NSApp.terminate(nil)
                }
            }
            host.onShutdownFailure = { message in
                if self.quitting { self.quitting = false; NSApp.reply(toApplicationShouldTerminate: false) }
                self.showError("Mac proxy restoration needs attention", message + "\n\nThe server is still running. Use Restore Mac proxy in Connection setup, then quit again.")
            }
            host.start()
        }
        #endif
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        // Captured URLs and response HTML never become executable navigation.
        if url.absoluteString == "about:blank" && startURL == nil { decisionHandler(.allow); return }
        decisionHandler(url.scheme == startURL?.scheme && url.host == startURL?.host && url.port == startURL?.port ? .allow : .cancel)
    }
    #if RELEASE
    func showError(_ title: String, _ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard host.running else { return .terminateNow }
        if !quitting { quitting = true; host.stop() }
        return .terminateLater
    }
    #endif
}
#if RELEASE
if CommandLine.arguments.contains("--check-node") {
    do {
        let node = try NodeDiscovery.find()
        let data = try JSONSerialization.data(withJSONObject: ["executable": node.executable, "version": node.version])
        print(String(decoding: data, as: UTF8.self)); exit(0)
    } catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
}
#endif
let app = NSApplication.shared
app.setActivationPolicy(.regular)
#if RELEASE
let delegate = AppDelegate()
#else
guard CommandLine.arguments.count > 1, let url = URL(string: CommandLine.arguments[1]), url.host == "127.0.0.1" else { exit(1) }
let delegate = AppDelegate(url: url)
#endif
app.delegate = delegate
app.run()
