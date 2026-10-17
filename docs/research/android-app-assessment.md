# Android app assessment

Assessed 2026-10-17. Research only; implementation and device verification remain outstanding.

Architecture update: [ADR 0015](../adr/0015-embed-a-shared-rust-core-and-synchronize.md) supersedes this assessment's recommendation to retain IndexedDB and embed only AI functionality. The target app embeds the full shared Rust application core with SQLite and optional household synchronization. Authentication, credential protection, and physical-device lifecycle validation remain outstanding; the assessment below is historical research, not the current implementation plan. Backend AI execution has since been implemented, so statements below describing it as future work are historical too.

## Recommendation

Build a Tauri 2 Android app around the existing React/Vite frontend, with the companion's Rust functionality linked into the app. This is a feasible reuse strategy for the core application; standalone ChatGPT subscription access remains conditional on the device authentication gate below. Do that gate before committing to the full port.

The desktop sidecar plan does not carry over: Tauri's shell plugin supports URL opening on Android, not spawning child processes. Tauri supports a mobile Rust shared library plus Kotlin plugins for platform APIs. Extract reusable OAuth, model discovery, inference, and token-refresh code from `crates/ai-companion`; preserve the standalone executable as a desktop adapter. [Shell platform support](https://v2.tauri.app/plugin/shell/), [mobile Rust library](https://v2.tauri.app/start/migrate/from-tauri-1/#preparing-for-mobile), [mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/)

Proposed architecture (design recommendation, not an implemented or tested system):

```text
Android installation
  React UI + existing Rust/WASM domain validation
  IndexedDB recipe collection, meal plan, shopping list, food log
  Native bridge
    Rust AI runtime -> OpenAI HTTPS / inference stream
    temporary loopback listener <- system browser OAuth callback
    Kotlin platform adapters -> Keystore, browser, file save/share
  Optional synchronization -> existing self-hosted backend
```

Avoid a permanent local HTTP API for frontend/native communication. Keep the loopback listener limited to authentication, using Tauri commands for connection status, models, and execution. A browser build can retain its existing companion HTTP transport. This removes companion URL setup from the installed app while keeping credentials native.

## ChatGPT authentication and subscription use

**Feasibility is conditional on an Android authentication spike.** Official OpenAI documentation describes this flow for open-source and locally hosted apps; it does not establish Android-specific support. Paid or remotely hosted apps require a separate interest/access route. A native Android installation appears consistent with local execution, but this is an interpretation, not an explicit mobile-support promise. [OpenAI overview](https://developers.openai.com/siwc/token-sharing-open-source)

The documented authorization flow opens the system browser and requires a listener at `http://127.0.0.1:<port>/auth/callback`. Only the port may vary. A custom URI scheme, Android App Link, `localhost`, or remote HTTPS callback cannot be substituted under this documented flow. Start the listener before launching the browser. Preserve PKCE, state, nonce, and the exact callback URI per attempt; validate identity and the granted `chatgpt.tokens.use.direct` scope before generation. The public client needs no embedded secret. [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

An Android app would therefore need native authentication ownership: run the short-lived loopback listener on the phone, exchange and validate tokens natively, and expose connection status and generation operations to the frontend. The callback reaches the device running the browser; an existing desktop companion cannot receive a phone browser's loopback callback. [OpenAI self-hosted guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)

Keep tokens outside WebView/browser storage. OpenAI requires protected runtime storage and serialized refreshes that atomically retain replacement tokens; sign-out should revoke the renewable session and clear local tokens. The Android design should use app-private encrypted storage with an Android Keystore key, subject to platform validation. Reuse a stable installation host ID and saved account registration across launches. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

**Acceptance gate:** verify first registration, returning sign-in, consent denial, browser switching, returning to Forkcast, rotation/backgrounding, process death, timeout/retry, refresh, and revocation on physical Android devices with supported browsers. Demonstrate that the listener remains available while the browser is foregrounded; if the process dies, restart authorization cleanly rather than accepting a stale callback. Ordinary Android deep links could help return to the app after successful callback handling, but must not replace OpenAI's required OAuth redirect. Do not promise automatic app return until tested.

Direct native HTTP/SSE inference is documented, so a separate Codex executable is not inherently necessary for recipe generation. Preserve `store: false` and `stream: true` and respect the current preview's parameter/tool limits. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## Required application work

| Area              | Repository evidence                                                                                | Android work / assessment                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and validation | React/Vite, hash navigation, Rust/WASM initialization in `src/main.tsx`                            | Reuse initially. Verify WebView WASM loading, small screens, keyboard insets, Android Back, rotation, accessibility, and tablet layouts.                                                                                                                                                                                                                      |
| AI runtime        | `crates/ai-companion/src/main.rs` owns Axum, environment-based paths, and process lifetime         | Separate the reusable runtime from the executable; initialize inside the Android app with explicit app-private paths and lifecycle ownership. Validate cross-compilation of dependencies.                                                                                                                                                                     |
| Credentials       | `vault.rs` uses Windows DPAPI; non-Windows `protect`/`unprotect` currently return bytes unchanged  | Add a platform vault. Encrypt token records with an Android Keystore-backed key and store ciphertext in app-private storage. Exclude credentials and installation identity from inappropriate backup/device transfer. This is required Android work, not existing encryption.                                                                                 |
| Local data        | `src/local-store.ts` uses IndexedDB; settings use localStorage                                     | Retain initially behind the same stable app origin and verify reload, process death, signed upgrades, and photo persistence. A native SQLite rewrite is not a prerequisite. Browser storage is a separate profile: it will not automatically appear in the app. Backend sync covers synchronized records; unsynced data needs an explicit migration decision. |
| Photos and PDF    | `RecipePhoto.tsx` uses file input; `shopping-pdf.ts` calls browser download                        | Test Android photo picker/file input and image decoding. Add native save/share delivery for generated PDF bytes as needed.                                                                                                                                                                                                                                    |
| Lifecycle         | Generation uses a component AbortController; cooking timers use intervals and persisted timestamps | Restore saved sessions and refresh status on resume. Detect interrupted generation and support retry without duplicate saves. Do not imply reliable background generation. Existing cooking timers are foreground-only under ADR 0007; lock-screen alarms/notifications are separate scope.                                                                   |
| Networking        | Browser transports and servers check allowed origins                                               | Configure the installed origin or native transport deliberately. Require internet permission; prefer HTTPS backend endpoints. Test cleartext opt-ins and local-network permission behavior if supporting a LAN backend.                                                                                                                                       |
| Distribution      | No Android project/build currently exists                                                          | Add Android toolchain, application ID/icons, signed APK for direct installation, AAB for Play distribution, versioning and CI. Protect the signing key and verify in-place upgrades. Disable web service-worker updating in the packaged build so installed assets follow app releases.                                                                       |

Android Keystore protects cryptographic key material; it is not itself a store for arbitrary OAuth token strings. The recommended ciphertext-file design uses the key for encryption/decryption. Android exposes explicit backup and device-transfer rules. [Keystore](https://developer.android.com/privacy-and-security/keystore), [backup rules](https://developer.android.com/identity/data/autobackup)

Android controls process lifetime and can terminate background processes; neither a Rust task nor WebView timer alone establishes reliable background execution. Browser authentication is especially sensitive because switching to the browser backgrounds Forkcast. Lifecycle management may require an Android service for the short sign-in window; service eligibility and behavior must be verified rather than assuming an always-running daemon. [Process lifecycle](https://developer.android.com/guide/components/activities/process-lifecycle), [foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)

Cleartext networking policy and LAN permissions are separate checks, and behavior depends on OS and target SDK. Test the supported Android versions rather than globally allowing unencrypted traffic. [Network security configuration](https://developer.android.com/privacy-and-security/security-config), [local-network permission](https://developer.android.com/privacy-and-security/local-network-permission)

Tauri documents the SDK/NDK/JDK prerequisites and signed Android bundles. At assessment time, `adb` was not on this session's PATH and `ANDROID_HOME`/`NDK_HOME` were unset; this is not proof those tools are absent, but no Android build/device test was performed. [Build prerequisites](https://v2.tauri.app/start/prerequisites/#android), [Android distribution](https://v2.tauri.app/distribute/google-play/)

## Implementation order and decision gates

1. **Prove standalone authentication:** build a minimal Android shell with native loopback OAuth, protected token storage, and one completed inference. Use a physical phone plus emulator, browser switching, and deliberate process interruption. Establish mobile eligibility with OpenAI if official documentation or observed behavior leaves it unresolved. Success means registration, returning sign-in, refresh, and graceful interruption work without a desktop helper.
2. **Package the core app:** bundle frontend/WASM, preserve storage, and exercise manual recipe editing, meal planning, shopping, cooking, food logging, photos, PDF export, and optional backend sync. Test small phones as well as tablets. Existing desktop-browser viewport tests are insufficient for native bridge/WebView/lifecycle behavior.
3. **Integrate native AI:** share the runtime with the desktop companion, connect the native bridge, remove URL setup on Android, and cover failures, cancellation, account isolation, and persistence after restart.
4. **Release:** produce a signed APK, test installation/upgrades with populated local data, add CI and release documentation, then assess Play publishing requirements. Play approval and live subscription access are not established by packaging successfully.

Relative effort: the packaging scaffold is small compared with authentication/lifecycle and credential integration. Core UI reuse is high confidence; Android WebView behavior still needs verification. Standalone AI is the highest uncertainty. There is not enough evidence for a reliable calendar estimate before the authentication gate.

If local subscription authentication is not supportable, a backend-executed AI mode is an alternative architecture, not an existing fallback: Forkcast currently uses its companion for generation even with synchronization enabled. Remote credentials need documented setup and execution ownership. Requiring a backend for all Android use would conflict with ADR 0002's standalone core-workflow requirement; requiring it for Android AI would need explicit reconsideration of the standalone subscription-access design in ADR 0010. A browser/PWA wrapper alone does not supply the native token/runtime layer required by this assessment.

No ADR, issue, or application code was changed by this assessment.
