# Pocket Proxy

A small, local HTTP/HTTPS interceptor and API mocking app for macOS. Inspect requests, mock responses, and simulate delays in a native WebView—no account, cloud service, or subscription.

<img width="1361" height="909" alt="image" src="https://github.com/user-attachments/assets/e6c8c4b0-3184-42f9-856e-c83ec3fa95fb" />

## Download

**[Download Pocket Proxy for Apple Silicon — DMG, ~2.2 MB](https://github.com/umeshgmrl/pocket-proxy/releases/download/v0.1.0-lean.2/Pocket-Proxy-0.1.0-arm64.dmg)** · [Release notes](https://github.com/umeshgmrl/pocket-proxy/releases/tag/v0.1.0-lean.2)

Requires **macOS 13+** and **Node.js 22+** installed separately. Node is not bundled; the installed app is about **6.1 MB**. This preview is ad-hoc signed and is not Apple-notarized.

1. Open the DMG and drag **Pocket Proxy** into **Applications**.
2. Launch the app and select your network in **Connection setup**.
3. Click **Start interception** and approve the macOS setup prompts.
4. Add a rule in **Mock rules**, then make a matching request.

**Stop interception** restores your previous Mac proxy settings. Only apps that use the proxy are intercepted; some clients need explicit configuration.

## Run from source

Requires **Node.js 22+**, **npm**, and **Xcode Command Line Tools** on macOS. If the tools are missing, run `xcode-select --install` and finish installation first.

Clone the repository and launch the app:

```sh
git clone https://github.com/umeshgmrl/pocket-proxy.git
cd pocket-proxy
npm ci
npm start
```

The first launch compiles the native helpers. Use the same **Connection setup** flow as the installed app. Source runs store their rules and certificate in `.data`, separately from the installed app.

## Build an installable app

From the cloned project, after `npm ci`:

```sh
npm run build:release
npm run test:release
```

Find **Pocket Proxy.app** and the **DMG** in `dist/`. The build targets your Mac's architecture; the published build has been tested on Apple Silicon. The resulting app still requires Node.js 22+ on the recipient's Mac. Personal certificates and rules are excluded from the build.

See the **[detailed guide](readme-detailed.md)** for HTTPS setup, your first mock, curl configuration, troubleshooting, development, and limitations.
