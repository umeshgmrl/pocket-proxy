# Pocket Proxy

**A small, local HTTP/HTTPS interceptor and API mocking tool for macOS.**

Inspect the requests your apps make and choose what comes back. Return a custom JSON response, simulate a server error, or add a delay—all without changing your backend.

Pocket Proxy runs on your existing **Node.js** installation and displays its interface in a native **macOS WebView**. No account, cloud service, bundled Chromium, or subscription is required.

[Install the app](#install-the-app) · [Setup](#setup) · [Your first mock](#your-first-mock) · [Commands](#commands) · [Troubleshooting](#troubleshooting) · [Development](#development)

## What you can do

| Feature | What it does |
| --- | --- |
| Live traffic | View HTTP/HTTPS requests, status codes, timing, headers, and text bodies. |
| Response mocking | Return a custom status code, headers, and response body. |
| URL matching | Match an exact URL, a URL substring, or a wildcard pattern. |
| Method matching | Target GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, or any method. |
| Simulated latency | Delay a mock response by up to 30 seconds. |
| Saved rules | Keep rules between sessions and change their priority. |
| Mac proxy controls | Route compatible apps through the proxy and restore previous settings when stopping. |
| Local storage | Keep rules and your personal certificate on your Mac; traffic history stays in memory. |

## How it works

```text
Browser or app
      │
      │ macOS proxy settings, or explicit client configuration
      ▼
Pocket Proxy · 127.0.0.1:8899
      │
      ├── Enabled rule matches → Return your mock response
      │
      └── No rule matches ────→ Forward to the original server
```

For HTTPS, Pocket Proxy uses a unique personal certificate authority (CA) to inspect encrypted requests routed through it. The guided setup requests macOS approval and verifies HTTPS through the running proxy.

**Certificate trust and traffic routing are separate steps.** Trusting the certificate does not automatically enable the Mac proxy. Both must be configured for browser-based HTTPS mocking.

## Install the app

The lean macOS build is distributed as **Pocket Proxy.app** in a drag-to-install **DMG**. It includes the proxy dependencies and native WebView, but **does not include Node.js**.

1. Install **Node.js 22 or newer** if it is not already installed.
2. Open `Pocket-Proxy-0.1.0-arm64.dmg` and drag **Pocket Proxy** into **Applications**.
3. Open Pocket Proxy from Applications. No terminal, npm install, or Xcode tools are needed to run this build.
4. Complete **Connection setup**: approve HTTPS certificate trust, then enable the Mac proxy.

The launcher looks for Node in its inherited PATH, Homebrew locations, nvm installations, and common version-manager locations. If Node is missing or too old, a native error dialog appears at startup. The app does not download or bundle a runtime.

Installed-app data is stored in `~/Library/Application Support/Pocket Proxy`, outside the app bundle. Rules and certificates survive replacing the app during an update. It starts with fresh data unless you explicitly migrate an existing development installation.

**Moving from the development version:** quit every Pocket Proxy instance first so proxy settings are restored. To reuse your existing certificate and rules, copy only `.data/ca.json`, `.data/pocket-proxy-ca.pem`, and `.data/rules.json` into the installed-app data folder, preserving their private file permissions, before first launch. Do not copy lock files or `mac-proxy.json`. Otherwise, complete trust setup for the installed app's new certificate. Personal certificates and rules are never included in the release artifact.

This build targets macOS 13+ and the build machine's architecture (currently Apple Silicon / arm64). It is ad-hoc signed, not Apple-notarized; macOS may require approval in Privacy & Security when opening a downloaded copy.

## Requirements for running from source

- **macOS** with a local Node.js installation, **version 22 or newer**.
- **npm**, included with Node.js.
- **Xcode Command Line Tools** to compile the native window on first launch. Browser mode skips the window compilation; guided HTTPS setup still compiles a small native helper. The DMG includes both helpers and needs no compiler.
- Access to authorize macOS certificate trust and network proxy changes when prompted.

Check your tools:

```sh
node --version
npm --version
xcode-select -p
```

If the Command Line Tools are missing, install them with:

```sh
xcode-select --install
```

## Setup

If you installed the DMG, launch from Applications and continue at step 2. The commands below are for running from source.

### 1. Install and launch

From the project folder:

```sh
npm install
npm start
```

The first native launch compiles a small WebView window. Later launches reuse it. The terminal also prints a private browser URL for the same interface.

To use your browser instead:

```sh
npm run dev
```

Run the app as your normal user, without `sudo`. System changes use macOS authorization prompts.

### 2. Set up HTTPS

The global **Start interception** button guides you through HTTPS setup automatically. You can also configure HTTPS separately in **Connection setup**:

1. Click **Set up HTTPS…**.
2. Approve the macOS certificate prompt when it appears.
3. Wait for **HTTPS verified**. Pocket Proxy checks a local HTTPS response using macOS certificate trust before reporting success.

Setup imports the app's exact public certificate into your **login** keychain and requests SSL trust. Your private key stays in the app's data folder. Already-trusted certificates skip approval. Each new installation generates its own certificate; existing certificates are preserved on updates.

If macOS blocks native approval, expand the **Keychain fallback** and click its button. The app imports or locates the exact certificate and displays its name and fingerprint. In Keychain Access, double-click that certificate, expand **Trust**, set **Secure Sockets Layer (SSL)** to **Always Trust**, then close the window and authorize the change. Return to Pocket Proxy and click **Verify again**.

The check stays on your Mac and does not appear in Live traffic. It verifies macOS trust; applications with separate certificate stores or certificate pinning may still need their own configuration.

### 3. Enable the Mac proxy

Back in **Connection setup**:

1. Select the network service you use, usually **Wi-Fi** or Ethernet.
2. Click the global **Start interception** button at the top and authorize macOS if prompted. It starts the local proxy, checks HTTPS (requesting certificate approval if needed), and enables routing.
3. Confirm that the top bar says **Mac proxy enabled**.

Starting the app opens its local listener; system routing remains off until you enable it. After certificate setup, you can also enable routing on launch with:

```sh
npm start -- --system-proxy
```

This selects all currently enabled network services and refuses automatic or authenticated proxy configurations it cannot safely preserve.

### 4. Capture a request

Open a website or make an API call, then check **Live traffic**. Select a request to inspect it.

If an already-open page does not appear, try a hard reload with **⌘⇧R**. Existing connections may require restarting the browser or application.

## Your first mock

### Try the included example

1. Open **Mock rules**. If the list is empty, click **Create an example rule**. Otherwise, use **New rule** with the values below.
2. Save and enable the rule.
3. With the Mac proxy enabled, visit [https://example.com/api/profile](https://example.com/api/profile).

| Setting | Value |
| --- | --- |
| Name | Example user profile |
| Method | GET |
| Match type | URL equals |
| URL pattern | `https://example.com/api/profile` |
| Status code | `200` |
| Delay | `0` ms |
| Response headers | `{"content-type": "application/json"}` |

Response body:

```json
{
  "id": 1,
  "name": "Local Developer",
  "plan": "personal"
}
```

The browser should display this JSON, and **Live traffic** should mark the response as mocked.

### Create a mock from captured traffic

Select a request in **Live traffic**, click **Create mock from request**, edit its response, and save. The rule applies to subsequent matching requests.

Review the body before saving: binary, omitted, or truncated previews may not contain the full original response.

### Match and prioritize rules

| Match type | Example | Behavior |
| --- | --- | --- |
| URL equals | `https://api.example.com/users/42` | Matches the complete URL, including its query string. |
| URL contains | `/api/users` | Matches that text anywhere in the URL. |
| Wildcard | `https://api.example.com/users/*` | `*` matches any sequence of characters. |

Matches are case-sensitive. **The first enabled matching rule wins.** Use the up arrow to increase a rule's priority. Unmatched requests pass through normally.

For failure scenarios, set the status to `500` or add a delay such as `2000` ms. CORS headers are not added automatically; supply the required `access-control-*` headers and an OPTIONS rule if your cross-origin mock needs them.

## Terminal and application clients

Some clients ignore macOS proxy settings or use their own certificate store. Configure those clients explicitly.

From the project folder, with Pocket Proxy running and the example rule enabled:

```sh
curl --noproxy '' \
  --proxy http://127.0.0.1:8899 \
  --cacert "$PWD/.data/pocket-proxy-ca.pem" \
  https://example.com/api/profile
```

This command uses the local proxy and its public CA directly, so it also works **without changing Mac proxy settings or Keychain trust**. The setup screen provides a command using your actual certificate path.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the proxy and native macOS window. |
| `npm run dev` | Start the proxy and open the web UI in your default browser. |
| `npm run server` | Run without opening a window; print the private UI URL. |
| `npm start -- --system-proxy` | Also enable the Mac proxy on launch. |
| `npm start -- --restore` | Restore saved proxy settings and exit; close any running instance first. |
| `npm start -- --help` | Show launch options. |
| `npm run build:webview` | Compile the development WebView window if needed. |
| `npm run build:release` | Bundle dependencies, compile the launcher, and create the installable app and DMG. |
| `npm run test:release` | Test a built release from a temporary folder without project dependencies. |
| `npm test` | Run automated tests without modifying real proxy or certificate-trust settings. |

Closing a browser tab does not stop the server. Use **Ctrl+C** in its terminal. Closing the native window stops the app.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `POCKET_PROXY_PORT` | `8899` | HTTP/HTTPS proxy port. |
| `POCKET_PROXY_UI_PORT` | `9077` | Web interface port. |
| `POCKET_PROXY_DATA_DIR` | `.data` for source launches; Application Support for the installed app | Certificate, rules, and restoration data. |
| `POCKET_PROXY_NODE` | Auto-detected | Full path to an existing Node executable for the installed app. |

For example:

```sh
POCKET_PROXY_PORT=8888 POCKET_PROXY_UI_PORT=9080 npm start
```

Both listeners bind to `127.0.0.1`. Ports must be different and between 1024 and 65535. Run only one instance per data directory. A new data directory generates a new CA, which needs its own trust setup.

## Stopping and recovery

**Stop interception**, quitting the native window, or pressing **Ctrl+C** restores saved Mac proxy settings before closing the listener. The global **Start interception** button starts the listener and enables routing together. **Connection setup → Advanced → Local proxy only** is available for explicitly configured clients; in that mode the global button controls only the local proxy.

A separate watchdog attempts restoration if the backend crashes or is killed. A journal also survives restarts, and restoration may require macOS authorization. Recovery is best effort: power loss, cancelled authorization, removed network services, or terminating both processes can require manual recovery.

If necessary, close the running instance and use:

```sh
npm start -- --restore
```

If automatic recovery fails, open **System Settings → Network → your service → Details → Proxies**. Switch off HTTP/HTTPS entries pointing to Pocket Proxy's address and restore any previous settings recorded in `.data/mac-proxy.json`.

The app avoids overwriting proxy addresses changed by another app or by you. Previously disabled proxies are disabled again; macOS may retain the inactive local address fields if there was no previous address.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The certificate is trusted, but the browser shows the original response | Confirm **Mac proxy enabled**, the correct network service is selected, and the rule is enabled. Trust alone does not route traffic. |
| No requests appear in Live traffic | Check Mac proxy routing, restart existing browser connections, and check whether the client requires explicit proxy configuration. |
| A request appears but is not mocked | Check its method, full URL, query string, and rule priority. Exact matching includes the query string. |
| Certificate authorization says “no user interaction was possible” | Expand **Keychain fallback** and finish the SSL trust steps manually. An earlier attempt may already have imported the certificate into **System** without granting trust. |
| HTTPS produces certificate errors | Check SSL trust, restart the client, and check whether it uses a separate CA store or certificate pinning. |
| Localhost traffic is missing | Existing macOS/client bypass lists remain in effect. Explicitly configure the client; the curl example disables bypasses with `--noproxy ''`. |
| The web UI reports an expired session | Open the private URL printed by the currently running server. Each launch creates a new session token. |
| A port is already in use | Close the other instance or choose different ports with the environment variables above. |
| The native window cannot compile | Install Xcode Command Line Tools, or use `npm run dev` for browser mode. |
| The internet stops working after a crash | Restart Pocket Proxy, use the restore command, or disable its proxy entries manually as described above. |

## Privacy and local data

The paths below describe a source launch. In the installed app, the same files live in `~/Library/Application Support/Pocket Proxy`.

| File | Contents |
| --- | --- |
| `.data/rules.json` | Saved mock rules. |
| `.data/ca.json` | Your personal CA certificate and **private key**, written with owner-only permissions. |
| `.data/pocket-proxy-ca.pem` | Public CA certificate for client configuration. |
| `.data/mac-proxy.json` | Temporary restoration journal while system routing is enabled. |

Request history stays in memory and retains the latest **300 requests**. Text previews are limited to **64 KB**; bodies over **1 MB** are omitted from capture while continuing to forward. Binary bodies are not previewed. Compressed previews are decoded with an output limit.

The UI uses a private launch token, an HttpOnly/SameSite cookie, and origin checks for writes. Captured HTML is displayed as text. Traffic passing through the proxy can contain credentials and other private data, so use it for your own development traffic and do not share your CA private key.

The `.data`, `node_modules`, `build`, and `dist` directories are git-ignored. To remove certificate trust, delete the certificate identified by **Certificate details** in the app from its **System** or **login** keychain in Keychain Access. Stop the app and remove that trust before deleting its CA data.

## Limitations

- System routing covers apps that honor proxy settings; this is not a transparent VPN or an all-protocol network interceptor.
- HTTP/1.1 and HTTP/2 are supported. HTTP/3 and arbitrary TCP/UDP interception are not implemented.
- WebSockets pass through; their frames cannot currently be inspected or mocked.
- Certificate-pinned apps and separate CA stores require application-specific development configuration.
- HTTPS endpoints addressed by IP without TLS SNI may not work with the default certificate. Hostname-based HTTPS is the tested path.
- Request callbacks wait for the request body before forwarding, so this is not a production streaming-upload gateway.
- Automatic proxy configuration and authenticated proxies are refused when the app cannot safely preserve their settings.
- Request rewriting, binary mock uploads, breakpoints, HAR export, and persistent traffic history are not implemented in this version.

## Development

The backend uses Node.js and [Mockttp](https://github.com/httptoolkit/mockttp). The interface is plain HTML, CSS, and JavaScript hosted in macOS's WKWebView.

```text
src/
  main.js          Launch, lifecycle, and recovery coordination
  app.js           Local UI server and API
  proxy.js         Traffic capture and response mocking
  rules.js         Rule validation and matching
  macos.js         Network proxy settings and restoration
  certificate.js   Interactive Keychain setup
  storage.js       Local rules and certificate storage
  lock.js          Cross-process restoration lock
  watchdog.js      Crash-recovery helper
public/            Web interface
native/            Swift WebView window and certificate setup helper
scripts/           Native build script
test/              Automated tests
```

Run `npm test` to check forwarding, HTTPS mocking, rule persistence, large-body handling, API access controls, loopback binding, simulated restoration, and the certificate setup flow. Tests do not approve real certificate trust or change actual Mac proxy settings.

The npm scripts include `--experimental-require-module` for the tested Node 22.11 installation's compatibility with Mockttp's ESM dependencies. This can print an experimental warning on that Node version.

Mockttp 4.6.3 does not expose a public bind-address option. `src/proxy.js` includes a version-specific adapter that constrains its listener before binding. The tests check the actual socket address; recheck this adapter when upgrading Mockttp.

### Building the lean release

```sh
npm ci
npm run build:release
npm run test:release
```

The release build uses esbuild to bundle and minify the backend and its dependencies. It copies the web UI, retains third-party license notices, compiles the native launcher and certificate helper, and creates a compressed DMG with an Applications shortcut. It leaves development dependencies intact. Runtime certificates, rules, Git data, compiler caches, and Node itself are excluded.

Output files:

- `dist/Pocket Proxy.app` — installable application.
- `dist/Pocket-Proxy-0.1.0-arm64.dmg` — installer for this Apple Silicon build.
- `dist/release-size.json` — exact installed and download sizes.
- `dist/bundle-analysis.json` — bundled module inventory for size analysis.

The build fails if the application payload reaches **15 MB** (15,000,000 bytes). The initial lean build is approximately **6.1 MB installed** and **2.2 MB as a DMG**, compared with roughly **42 MB** of unbundled production dependencies. Node remains an external prerequisite in both comparisons. Use the generated size report for the exact current numbers.

Release tests copy the app outside the repository before running its backend. They check HTTPS mocks, forwarding, compressed responses, saved rules/certificates, and pause/restart without accessing this project's `node_modules`. They also check native Node discovery with a Finder-like PATH and missing/unsupported runtime errors. No real system proxy settings or certificate trust are changed by those tests.

The existing `build/Pocket Proxy.app` remains a development WebView helper; the installable product is the distinct app under **dist**.
