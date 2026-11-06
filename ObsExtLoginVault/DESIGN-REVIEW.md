# Login Vault — Design Review & Enhancement Spec

> Scope: `ObsExtLoginVault/` at v1.1.0. Goals: (1) works equally well on desktop and mobile, (2) stays in sync with the vault without data loss, (3) easy to use, (4) secure.
> Status: **Phase 0 implemented in v1.2.0** (see §7 for what shipped and what was deferred). Phases 1–4 are still proposals. Items marked **[verify]** rest on Obsidian behaviour that should be confirmed on real devices.
>
> Phase 0 shipped: three-way merge on every write + external-change watcher (S1, S2), no-overwrite first run with "existing vault" wait flow (S4), Sync-health guidance (S3 mitigation only — not proven), chunked base64 (S8), rolling backups + corrupt-vs-wrong-password (S6), trash on reset (S7), removal of the stored password hash (X1), device-local 6–12 digit PIN with attempt limit (X2, partly), lock closes dialogs and clears clipboard (X4, X5, X6), deadline-based auto-lock (X7, ahead of schedule), CSV formula guard (X10), unlock-promise hang and startup prompt (M3), theme/icon/CSS scoping (M7, M8), visible row actions (M1), touch targets (M4), keyboard PIN (M5).
>
> Deferred: extractable session key (X3, needs Phase 1 key slots), mobile-safe export (M2), password-gen/zxcvbn lazy-load (M9), re-auth before plaintext export, SecretStorage-backed PIN, header status line (M11), single-overlay forms (M12).

---

## 1. Verdict

The foundations are sound (Web Crypto, AES-256-GCM, random IV per save, rejection-sampled generator, zxcvbn). The weaknesses are in three places the v1.1.0 fixes did not touch:

1. **Sync is assumed, not designed.** The vault is one whole-file blob, written from stale in-memory state, in a file type Obsidian Sync does not sync by default. Two realistic multi-device sequences destroy data (§3, S1–S4).
2. **The PIN and the verification hash weaken the master password.** A fast hash stored next to the ciphertext, and a 4–8 digit PIN wrapping the real key inside a synced `data.json`, are both brute-forceable offline (§3, X1–X2).
3. **Mobile was treated as "desktop with a narrow viewport".** Context-menu-only actions, blob downloads, `setTimeout`-based auto-lock and hover affordances do not work reliably on iOS/Android (§3, M1–M6).

The single most valuable architectural change is **envelope encryption with key slots** (§4.1): it fixes the PIN weakness, makes password change safe across devices, and enables a recovery key, all in one format change.

---

## 2. What exists today (short)

| Area | Implementation |
|---|---|
| Storage | One JSON envelope `login-vault.enc` in vault root: `salt`, `verificationHash`, `iv`, `ciphertext` (whole credential array) |
| Key | `PBKDF2-SHA256, 310k iter` → AES-GCM key, **extractable** (`crypto.ts:70`) |
| Unlock | Password (verify SHA-256 hash, then derive) or PIN (hash in `data.json` + PIN-wrapped raw key in `data.json`) |
| Lock | In-memory key cleared; `setTimeout` auto-lock reset on `keydown`/`click` |
| UI | Right-sidebar `ItemView` + modals; hard-coded dark theme; emoji buttons |
| Sync | None implemented. No `vault.on('modify')` listener, no merge, no tombstones |

---

## 3. Findings

Severity: **Critical** = silent data loss or credential exposure; **High** = serious weakness or broken feature; **Medium** = notable defect or UX gap; **Low** = polish. File refs are relative to `ObsExtLoginVault/src/`.

### 3.1 Sync & data integrity

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| S1 | **Critical** | **Lost-update on multi-device edit.** `save()` re-reads only the header, then writes the *in-memory* credential list. Device A adds entry X → synced to B. B (still unlocked, never reloaded) adds Y → B's file contains Y but not X → X is erased everywhere. No `modify` listener exists to reload. | `store.ts:146-154`, `main.ts` (no vault events) |
| S2 | **Critical** | **Password change on A, then edit on still-unlocked B corrupts the vault.** B's save reads the *new* salt/hash from disk but encrypts with its *old* session key → ciphertext no longer matches any password. Recoverable only from Sync version history. | `store.ts:146-154`, `auth.ts:113-138` |
| S3 | **Critical** | **`login-vault.enc` is likely not synced by default.** Obsidian Sync's selective sync covers images/audio/video/PDF; "Sync all other types" is off by default and is a per-device setting ([Obsidian Sync settings](https://help.obsidian.md/sync/settings)). A forum report describes a new device without the toggle causing the unsynced files to be **deleted from the remote vault** ([forum](https://forum.obsidian.md/t/excluded-file-types-deleted-when-syncing-on-new-device/116006)). The docs' "✅ Obsidian Sync compatible by design" is unverified **[verify]**. | `DOCUMENTATION.md` Features table |
| S4 | **Critical** | **First-run on a second device creates a competing vault.** `isInitialized()` is a plain file-exists check. If sync hasn't delivered the file yet, device B runs the setup wizard, writes a new empty vault with a new salt, and that write races/overwrites the real one. | `main.ts:93-99`, `store.ts:33-36` |
| S5 | **High** | **No safe conflict model for either file type.** Markdown files are merged by Sync with diff-match-patch (would corrupt a base64 blob); non-markdown files are last-writer-wins ([troubleshooting](https://obsidian.md/help/sync/troubleshoot)) **[verify exact non-md behaviour]**. Third-party sync (iCloud/Dropbox/Syncthing) creates `… (conflicted copy)` files that the plugin never looks for. | — |
| S6 | **High** | **Non-atomic write; corruption looks like a wrong password.** `vault.modify` of a partially-written file (mobile app kill) makes `JSON.parse` fail → `readVaultFile` returns `null` → unlock reports "Incorrect password". No backup. | `store.ts:240-260`, `UnlockModal.ts:111` |
| S7 | **High** | **Hard delete, and deletes propagate.** `resetVault()` uses `vault.delete` (permanent), and the "Forgot password?" link is reachable from the lock screen. One mis-tap on one device wipes every device. `deleteCredential` is also a hard delete with no tombstone, so merging can never tell "deleted" from "not yet seen". | `main.ts:134-137`, `store.ts:135-142` |
| S8 | **High** | **`toBase64` spreads the whole buffer into `String.fromCharCode(...)`** → `RangeError` once ciphertext exceeds the engine's argument limit (JSC on iOS is lower than V8). A vault of a few hundred entries will fail to save on mobile first; in-memory state then diverges from disk. | `crypto.ts:16` |
| S9 | Medium | **`data.json` is last-writer-wins per key** (Sync merges settings JSON by key, local on top of remote — [troubleshooting](https://ryn-cx.github.io/obsidian-theme-previews/obsidian-sync/troubleshoot-obsidian-sync.html)). Per-device settings (auto-lock, PIN material) leak between devices. | `types.ts:37-45` |
| S10 | Medium | Import trusts input: no schema validation, `entry.updatedAt > existing.updatedAt` with missing fields, no dedupe by content (only by `id`). | `store.ts:199-226` |

### 3.2 Security

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| X1 | **Critical** | **`verificationHash = SHA-256(password ‖ salt)` is stored in the same file as the ciphertext.** It is a single fast hash, so an attacker who copies `login-vault.enc` can test passwords at billions/sec and skip the 310k-iteration PBKDF2 entirely. The PBKDF2 cost is only paid by the legitimate user. GCM authentication already tells you whether a password is right — the hash adds nothing and removes the KDF's protection. | `crypto.ts:106-115`, `store.ts:46`, `auth.ts:65` |
| X2 | **Critical** | **PIN is effectively unprotected.** `pinHash` is the same fast SHA-256 (cracking 10⁴–10⁸ PINs is instant), and `pinWrappedKey` is the real vault key under a PIN-derived key, both in `data.json`, which may sync to Obsidian's servers and to every device. A 4–8 digit PIN has ≤ 10⁸ possibilities even against PBKDF2. Anyone with the file system (or sync account) gets the vault key. The doc's own reasoning for dropping biometrics ("storing the secret in `data.json` is worse than nothing") applies equally to the PIN as built. | `auth.ts:147-159`, `types.ts:41-43` |
| X3 | High | **Session key is extractable for the entire session**, only because PIN enrollment needs to export it. Any XSS-class bug or other plugin with page access can `exportKey("raw")`. | `crypto.ts:49-73` |
| X4 | High | **Auto-lock doesn't close open modals.** Detail/edit/generator modals keep plaintext in the DOM after lock; `refreshOpenViews` only re-renders the view. | `main.ts:21-24`, `CredentialDetailModal.ts` |
| X5 | High | **Context-menu "Copy Password" bypasses the clipboard-clear timer** and uses raw `navigator.clipboard`. | `VaultView.ts:209-214` |
| X6 | Medium | **Clipboard clear overwrites unconditionally** — it will blank whatever the user copied since. Should clear only if the clipboard still holds our value (where `readText` is permitted). | `components.ts:57` |
| X7 | Medium | **Auto-lock is a `setTimeout`**, which is suspended/throttled when a mobile app is backgrounded; the vault can stay unlocked for hours after the user walks away. The "inactivity" signal is only `keydown`/`click` — touch scroll and reading never count, so it also locks mid-use. | `main.ts:63-72`, `auth.ts:210-217` |
| X8 | Medium | **Password policy too weak for the threat model.** Minimum zxcvbn score 2 ("Fair") with 8 characters is crackable offline, especially with X1. | `SetupModal.ts:91`, `SettingsTab.ts:146` |
| X9 | Medium | KDF: 310k PBKDF2 is below current OWASP guidance for SHA-256 (600k), parameters aren't stored in the file (can't upgrade without a format break), and there's no memory-hard option. | `crypto.ts:10` |
| X10 | Medium | **CSV formula injection** (`=`, `+`, `-`, `@` prefixed fields) when exported CSV is opened in a spreadsheet. Plaintext exports are one click with no re-authentication and are written to Downloads/Photos-adjacent storage. | `store.ts:187-197`, `VaultView.ts:112-120` |
| X11 | Medium | No unlock throttling or failed-attempt feedback; no lock-out UX after repeated failures. | `UnlockModal.ts:102-117` |
| X12 | Low | Sensitive inputs lack `autocomplete="off"`, `autocapitalize="off"`, `spellcheck="false"`; mobile keyboards may learn/suggest secrets. | all `createEl("input")` |
| X13 | Low | `exportJSON` has no encrypted variant despite the docs (`exportJSON(encrypted?)`, "Export: Encrypted JSON ✅"); `minAppVersion 1.4.0` vs. APIs needed. Doc/code drift. | `store.ts:182`, `DOCUMENTATION.md` |

### 3.3 Mobile & cross-platform

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| M1 | **High** | **Edit / Copy / Delete quick actions are only reachable via the `contextmenu` event** — unreliable on iOS WebView and undiscoverable everywhere. | `VaultView.ts:203-219` |
| M2 | **High** | **Export via `<a download>` + blob** commonly does nothing in Obsidian mobile webviews. The only export path may silently fail on phones. | `components.ts:90-100` |
| M3 | **High** | **Unlock modal can hang the view.** `VaultView.onOpen` awaits a promise that only resolves on Unlock/Cancel buttons. Pressing Esc or tapping outside the modal closes it without resolving → `onOpen` never completes → blank pane. Also, Obsidian restores open leaves at startup, so a modal pops on every launch. | `VaultView.ts:30-54`, `UnlockModal.ts:46-48` |
| M4 | Medium | Tap targets below 44×44 pt: header icon buttons (5px padding), copy buttons, tag chips, FAB is OK but ignores `env(safe-area-inset-*)` and the on-screen keyboard. | `styles.css:72-82, 413-424, 184` |
| M5 | Medium | PIN keypad is click-only: desktop users cannot type digits; no haptic/visual error on mobile; no auto-submit. | `UnlockModal.ts:126-157` |
| M6 | Medium | Hover-only affordances (card lift, accent bar) convey the only "this is tappable" cue. | `styles.css:163-169` |
| M7 | Medium | **Hard-coded dark palette ignores Obsidian's theme.** On light themes, labels use `#e2e8f0` over Obsidian's light modal background → unreadable. Emoji used as icons (no `setIcon`, no `aria-label`, inconsistent across OS emoji fonts). | `styles.css:6-36` |
| M8 | Medium | **Unscoped global rule** `.modal-content { animation … }` restyles every Obsidian modal and other plugins' modals. | `styles.css:690` |
| M9 | Medium | **zxcvbn (~800 KB with dictionaries) is bundled eagerly** into `main.js` → slower plugin load on mobile, where load time is user-visible. | `password-gen.ts:6` |
| M10 | Low | Doc claims "URL favicon (if available)" — not implemented (and a favicon fetch would leak every domain to a third party; don't add it). | `DOCUMENTATION.md` UI section |
| M11 | Medium | **Header shows no state.** No sync status, no auto-lock countdown; Help/Export/Lock are three tiny emoji buttons that crowd a narrow sidebar. | `VaultView.ts:90-110` |
| M12 | Medium | **Modals stack on modals** (detail → edit → generator → confirm), which is awkward on a phone and hides context. Required-field errors are toasts, not inline. Tags are entered as free text with no suggestions. | `CredentialDetailModal.ts`, `CredentialModal.ts` |
| M13 | Low | **Settings use raw `<input>` blocks** instead of native `Setting` rows for password/PIN change; one long page with no grouping. | `SettingsTab.ts:129-213` |
| M14 | Low | Dead biometric-tab CSS; Inter / JetBrains Mono font stacks override the user's Obsidian fonts; empty state uses an emoji and "click + to add one". | `styles.css:528-541, 35, 573` |

### 3.4 Small correctness items

- `Object.assign({}, DEFAULT_SETTINGS, …)` is shallow: `passwordGenDefaults` is shared with `DEFAULT_SETTINGS` and mutated in place; new nested keys never appear for existing users (`main.ts:80`).
- `UnlockModal` takes an `onReset` argument it never uses; `showUnlockModal` never resolves on Esc (`main.ts:156-160`).
- `hasMasterPassword` in `data.json` is redundant with file existence and can diverge across devices.
- `CredentialModal` doesn't guard against two modals saving concurrently (no write queue → interleaved `save()` calls).

---

## 4. Target design

### 4.1 Vault format v2: envelope encryption with key slots

```
login-vault.lv   (JSON; see §4.2 for file type)
{
  "format": 2,
  "kdf":  { "name": "pbkdf2-sha256", "iterations": 600000, "salt": "<b64>" },   // or argon2id params
  "slots": [
    { "id": "pw",  "type": "password", "kdf": {…}, "wrappedDek": {iv, ct} },
    { "id": "rk",  "type": "recovery", "kdf": {…}, "wrappedDek": {iv, ct} }   // optional
  ],
  "rev": 42,                         // monotonically increasing, bumped every write
  "deviceId": "<random>",            // last writer (diagnostics only)
  "payload": { "iv": "<b64>", "ct": "<b64>" }   // AES-GCM(DEK, JSON, AAD = format‖rev?)
}
```

- A random 256-bit **DEK** encrypts the data; each unlock method holds its own **KEK-wrapped copy** of the DEK.
- **Remove `verificationHash`.** A wrong password fails the GCM tag on the wrapped DEK. (Fixes X1.)
- **Password change = re-wrap the DEK**, not re-encrypt data, and does *not* change the payload key. Other devices' sessions stay valid and other unlock slots survive. (Fixes S2 and the "password change clears your PIN" annoyance.)
- Offer **"Rotate encryption key"** (new DEK, re-encrypt payload) as an explicit action for the "my old password leaked" case.
- KDF parameters live in the file, so iterations/algorithm can be raised later with a transparent upgrade on next unlock. Default 600k PBKDF2; **optional Argon2id** via bundled WASM (e.g. hash-wasm) if mobile benchmarks allow ≥ 64 MiB. Calibrate iterations to ~0.5–1 s on the current device at setup; never lower than the OWASP floor.
- DEK imported **non-extractable** for normal use (fixes X3). The raw bytes only exist transiently during wrap/unwrap.
- Optional **recovery key** (random 160-bit, shown once as 8 groups, user prints/saves it) as another slot — the only safe answer to "forgot password" other than a destructive reset.
- **Migration:** on first unlock of a v1 file, derive the old key, generate a DEK, write v2, keep the v1 file as `login-vault.v1.bak` (encrypted, same trust level) and prompt the user to re-enroll quick-unlock.

### 4.2 Where the file lives and what it's called (sync-driven) **[verify]**

Obsidian Sync does not sync unknown extensions by default and its markdown merge would shred a ciphertext blob. Options:

| Option | Syncs by default | Merge risk | Notes |
|---|---|---|---|
| A. `login-vault.enc` (today) | **No** | LWW | Needs "Sync all other types" on **every** device; risk of remote deletion on new devices |
| B. `.md` file with fenced base64 | Yes | **DMP merge can corrupt** | Also pollutes search/graph/quick switcher |
| C. Folder of per-entry files `Login Vault/<id>.lv` | Needs A-toggle | LWW per entry | Conflict radius = one entry; reveals entry count/size |
| D. A + **in-plugin merge** + sync health check | Needs A-toggle | Handled in code | Smallest change; keeps one file |

**Recommendation:** ship **D** first (the sync-aware layer in §4.3 is required for every option), with a **Sync Health** panel that detects the problem and tells the user exactly which toggle to flip. Evaluate **C** in a later phase if real-world conflict rates justify it. Do **not** use B.

Also make the path configurable (default `login-vault.lv`, plus legacy `login-vault.enc` detection) and recommend a dedicated folder so users can exclude it from other tooling.

### 4.3 Sync-aware store

1. **Stateless save.** Every write is **read-merge-write**: read the on-disk file → decrypt with the DEK → merge with in-memory changes → bump `rev` → write. Never write the in-memory list over the disk state.
2. **Per-entry merge** keyed by `id`, newest `updatedAt` wins (field-level merge optional for `tags`, `notes`). Merge function is pure and unit-tested.
3. **Tombstones.** Deletes record `{ id, deletedAt }` in the payload (kept 90 days, then pruned). Deleted entries also go to an in-vault **Trash** so users can restore them.
4. **External-change watcher.** `vault.on('modify'|'create'|'rename')` for the vault file (debounced ~500 ms, ignoring our own writes via `rev`/`deviceId`) → decrypt with session DEK → merge into memory → refresh the view. If the DEK slot set changed (password rotated) or decryption fails → keep memory read-only and show "Vault changed on another device — unlock again".
5. **Conflict files.** Detect `login-vault*(conflicted copy)*`, `*.conflict*`, and `rev` forks; offer an automatic merge (same function as 2) and move the conflict copy to the plugin's backup folder.
6. **Atomic writes + rolling backups.** Write to `<file>.tmp` via `vault.adapter`, then rename; keep the last N (default 5) encrypted snapshots in the plugin folder (`.obsidian/plugins/login-vault/backups/`, device-local, not the synced vault). Distinguish "file unreadable/corrupt" from "wrong password" in the UI and offer restore-from-backup.
7. **Single-flight write queue** so concurrent saves can't interleave.
8. **Chunked base64** (`toBase64` in 32 KB slices) — fix S8.
9. **Safe reset.** Replace `vault.delete` with `fileManager.trashFile` (system/vault trash) and move the file to backups first; require typing `RESET` **and** show "this deletes the vault on every synced device".
10. **Second-device first run.** Replace the unconditional setup wizard with a choice: **"I already have a vault on another device"** → wait/poll for the file (with progress and the Sync-health hint) vs **"Create a new vault"** (shows a warning if Sync is active). Never create a vault automatically when the file is merely absent.

### 4.4 Settings split

| Stored where | Contents |
|---|---|
| `data.json` (synced, merged per key) | Preferences that should follow the user: generator defaults, UI density |
| **Device-local** (`app.saveLocalStorage` / `loadLocalStorage` or plugin-folder file not in synced config; **SecretStorage** when available) | Auto-lock timeout, clipboard clear, quick-unlock enrollment, backup folder, device id, sync-health state |

### 4.5 Quick unlock redesign (replaces the current PIN) 

Constraints: Obsidian exposes no biometric/OS-keystore API on mobile; WebAuthn in embedded webviews is unreliable **[verify]**. Be honest about what a PIN can protect.

- **Make quick-unlock device-local.** Never store the wrapped DEK in synced `data.json`. Enrollment creates a **device key slot** local to this device.
- **Use the platform secret store when present.** Obsidian ≥ 1.11.4 exposes `app.secretStorage` ([API reference](https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage)); the research notes that disk encryption is confirmed on desktop and that mobile may share secrets across vaults ([forum thread](https://forum.obsidian.md/t/secretstorage-appears-to-be-shared-across-vaults-on-mobile-but-vault-scoped-on-desktop/117793)) — namespace the secret id per vault and **[verify]** on both platforms. Raise `minAppVersion` or feature-detect and degrade gracefully.
- **Two-factor quick unlock:** KEK = HKDF(device secret from SecretStorage ‖ PBKDF2(PIN)). Copying `data.json`/the vault file alone then yields nothing; the PIN alone yields nothing.
- **If no secret store is available:** do not silently fall back. Show: *"Quick unlock on this device is only as strong as your PIN (anyone who can copy this device's files can brute-force it). Use a 6+ digit PIN or passphrase, or keep using the master password."* Require ≥ 6 digits and allow alphanumeric passcodes. Default **off**.
- **Attempt limiting:** 5 wrong PINs → delete the device slot and require the master password; exponential delay between attempts in the UI. State plainly that this is a software guard, not a defence against file copying unless the secret store is used.
- **Re-prompt for the master password periodically** (default every 14 days or 10 quick unlocks) so it's never forgotten.
- **Biometrics:** spike only. If `navigator.credentials` with the WebAuthn **PRF** extension works in Obsidian's iOS/Android webviews, add it as another slot type; otherwise leave it out. Do not claim biometric support unless the secret demonstrably comes from the authenticator.

### 4.6 Locking model

- **Deadline-based, not timer-based.** Store `lastActivityAt`; `getSessionKey()` and every mutating call check `now - lastActivityAt > timeout` and lock first. Timers are only a UI nicety. (Fixes X7.)
- **Activity signals:** `pointerdown`, `keydown`, `scroll`, `touchstart`, `visibilitychange`, plus any interaction inside the vault view/modals. Reading a long note must not count as idle.
- **Lock triggers:** manual, timeout, **on app background** (mobile: default *after 1 min*, configurable *immediately / 1 / 5 min / never*), **on window blur** (desktop, optional), on Obsidian quit, on system lock/sleep where detectable.
- **Single lock bus.** `auth.onLock` event; every view and modal subscribes, clears its DOM/plaintext state and closes itself. (Fixes X4.)
- **Overlay-based privacy:** blur/hide vault content when the app is backgrounded (task-switcher screenshot).

---

## 5. UX specification

### 5.1 Principles
1. **Two taps to a password** on mobile; **one keystroke after open** on desktop.
2. **The common path is a button, never a gesture or context menu.**
3. **Security state is always visible** (locked / unlocked / countdown / sync state).
4. **Native look.** Use Obsidian CSS variables; the plugin accent is an optional override.
5. **Never lose data silently.** Every error says what happened and what is safe.

### 5.2 Unlock & first run
- **Inline unlock in the view** (not a modal). Fixes the Esc-hang (M3) and the startup modal popup; the view always renders something. Keep a modal only for command-palette-triggered unlock.
- Password field: `autocomplete="off"`, show/hide, Enter submits, clear on failure, visible lock-out timer after repeated failures.
- PIN pad: physical keyboard digits/Backspace/Enter supported; auto-submit at enrolled length; `navigator.vibrate` on error where available; large keys (≥ 56 px).
- Setup wizard: step 0 "new vs existing vault" (§4.3.10); step 1 password with **passphrase generator** ("4 random words" suggestion) and min zxcvbn 3; step 2 **recovery key** (recommended, copy/print, "I saved it" confirmation); step 3 optional quick unlock with the honesty text from §4.5.
- "Forgot password?" → explain recovery key option first; reset only after.

### 5.3 Vault view

```
┌──────────────────────────────┐
│ Login Vault    ⟳ synced  ⋯ 🔒 │   header: sync/lock status, overflow menu
│ [ Search…                  ]  │
│ All · Work · Personal · Fav   │   tag chips (horizontal scroll, not wrap)
│ ┌──────────────────────────┐ │
│ │ GitHub              [👤][🔑] │ │   [copy username] [copy password] one tap
│ │ marlon@… · github.com   ⋯ │ │   ⋯ = Edit / Open site / Duplicate / Delete
│ └──────────────────────────┘ │
│                         (+)  │
└──────────────────────────────┘
```

- Each card has **visible** copy-username and copy-password buttons and a `⋯` menu (`Menu`), keeping right-click as a desktop shortcut. Fixes M1.
- Card tap → detail (view-only, mobile bottom-sheet style); big buttons; reveal is **press-and-hold or auto-hide after 10 s**.
- Sort: *Recent*, *A–Z*, *Favorites first*; remember last choice per device.
- Empty/locked/syncing/error states each have an illustration-free, text-first design.
- Safe-area insets and `visualViewport` handling for FAB and bottom actions.

### 5.4 Desktop acceleration
- Command **"Quick find & copy"**: fuzzy `SuggestModal`; **Enter** copies password, **Shift+Enter** copies username, **Alt+Enter** opens URL. Works from the command palette on mobile too.
- Commands: *Lock now*, *Open Login Vault*, *Add credential*, *Generate password*, *Copy last-used password* (hotkeys unbound by default).
- Keyboard navigation in the list (↑/↓/Enter), `Esc` closes any modal cleanly.

### 5.5 Theming & accessibility
- Replace the hard-coded palette with `--background-primary/secondary`, `--text-normal/muted`, `--interactive-accent`, `--background-modifier-border`, `--color-red`. Optional "Vault accent" setting. Works in light and dark and with community themes. (M7)
- Replace emoji buttons with `setIcon` (Lucide) + `aria-label`; visible `:focus-visible`; `aria-live` region for lock/copy status; contrast ≥ 4.5:1; respect `prefers-reduced-motion`.
- Scope **every** selector under `.lv-*`; delete the global `.modal-content` rule. (M8)
- Touch targets ≥ 44×44 px via `@media (pointer: coarse)`; replace `max-width: 480px` with `body.is-mobile` / `Platform.isMobile`. (M4, M6)
- Lazy-load zxcvbn (`import()` on first strength check; truncate input to 64 chars before scoring). (M9)

### 5.6 Import/export
- **Primary export = encrypted** (re-wrappable vault file / `.lvbackup`). **Plaintext export** requires re-entering the master password, shows a one-time warning with the destination, and (mobile) uses the **Web Share API / Obsidian's file-saving flow** with a "copy to clipboard" fallback instead of `<a download>`. (M2, X10)
- CSV: prefix `'` to cells starting with `= + - @ \t \r`; RFC 4180 compliant quoting.
- **Import** from Bitwarden JSON/CSV, 1Password CSV, Chrome/Edge/Firefox CSV, KeePass CSV, LastPass CSV (column auto-mapping with preview + duplicate resolution UI). Schema-validate every record (S10).
- Post-import prompt: "Securely delete the source file?" with platform-appropriate instructions.

### 5.7 Visual design specification

Builds on §5.3 and §5.5. Priority order; each item lists its acceptance check.

**1. Native theming (M7, M8)**
- Define plugin tokens as aliases of Obsidian variables and nothing else:

  | Plugin token | Maps to |
  |---|---|
  | `--lv-bg` | `--background-primary` |
  | `--lv-bg-surface` | `--background-secondary` |
  | `--lv-bg-input` | `--background-modifier-form-field` |
  | `--lv-border` | `--background-modifier-border` |
  | `--lv-text` / `--lv-text-muted` | `--text-normal` / `--text-muted` |
  | `--lv-accent` | `--interactive-accent` (optional "Vault accent" override setting) |
  | `--lv-danger` / `--lv-ok` / `--lv-warn` | `--color-red` / `--color-green` / `--color-orange` |
  | `--lv-radius` | `--radius-m` |
  | `--lv-font-mono` | `--font-monospace` (passwords only) |

- Remove the global `.modal-content` animation and the `Inter` / `JetBrains Mono` stacks.
- *Check:* screenshots in Obsidian default light, default dark, and one community theme show no unreadable text.

**2. Icons and labels (M7)**
- All emoji controls become `setIcon` (Lucide) buttons with `aria-label`: `lock`, `more-horizontal`, `copy`, `user`, `key-round`, `eye` / `eye-off`, `plus`, `trash-2`, `pencil`, `refresh-cw`.
- No emoji in titles, menus, notices or buttons.
- *Check:* every interactive element has an accessible name; no emoji codepoints remain in `src/`.

**3. List rows (M1, M6)**
- Bordered rows (not lifted cards): 32 px letter avatar tinted from a hash of the title, title, secondary line.
- Secondary line shows the username; if the entry has a health issue (old, weak, reused) it shows one warning line instead.
- Two visible 40 px actions: copy username, copy password (accent-tinted). `⋯` opens `Menu` with Edit, Open site, Favorite, Duplicate, Delete. Right-click remains a desktop shortcut.
- Sort control: Recent, A–Z, Favorites first.
- No lift/translate on hover; hover is a background change only, and only under `@media (hover: hover)`.
- *Check:* any action reachable in two taps on a phone without a long press.

**4. Header and filters (M11)**
- Title with a status line: `Synced · locks in 4:12`, or `Sync problem` / `Changed on another device` in warning color, linking to the Sync-health panel.
- Header buttons: Lock and `⋯` only; Help, Export, Settings, and Sync health live in the menu.
- Tag chips are one horizontally scrolling row with a leading "All" and "Favorites"; no wrapping block.
- *Check:* header fits a 320 px-wide sidebar without wrapping.

**5. Touch, keyboard, accessibility (M4, M5)**
- Targets ≥ 44 px under `@media (pointer: coarse)` / `body.is-mobile`; replace the `max-width: 480px` breakpoint.
- PIN pad accepts physical digits, Backspace, Enter; error state shakes (respecting `prefers-reduced-motion`) and calls `navigator.vibrate` where available.
- `:focus-visible` ring on every control; `aria-live="polite"` region for "Copied", "Locked", "Saved".
- FAB and bottom sheets pad with `env(safe-area-inset-bottom)` and follow `visualViewport` when the keyboard opens.
- *Check:* full keyboard-only pass on desktop; VoiceOver / TalkBack read every control sensibly.

**6. Forms and detail (M12)**
- Detail opens as a side panel (desktop) or bottom sheet (mobile) with inline edit; the generator opens as an in-form popover/sheet instead of a third modal.
- Password input: monospace, generate and show/hide buttons inside the field, strength bar directly beneath, reveal auto-hides after 10 s.
- Tag input with autocomplete from existing tags; chips are removable with one tap.
- Required-field errors appear inline under the field; no toast-only validation.
- Secret inputs set `autocomplete="off"`, `autocapitalize="off"`, `spellcheck="false"`.
- *Check:* adding an entry on a phone never needs more than one open overlay.

**7. Unlock, setup, reset**
- Unlock renders inline in the view (§5.2); one screen that opens on the last-used method with a "Use password instead" / "Use PIN" link, replacing the tab bar.
- "Forgot password?" is a clear secondary button that first explains the recovery-key route, then offers reset.
- Setup wizard shows a 3-dot progress indicator and one decision per step.
- *Check:* closing any unlock surface (Esc, tap outside) never leaves a blank pane.

**8. Settings and copy (M13, M14)**
- Rebuild settings with native `Setting` rows grouped under collapsible headings: Security, Session, Generator, Data, Danger zone. Password and PIN change open a small dialog instead of inline inputs.
- Empty state: headline "Start your vault", one-line body, "Add credential" button. Locked state names the unlock method available.
- Microcopy: sentence case, verb-first buttons, no "please", no "!" on system messages.
- Delete dead biometric CSS.

**Visual reference (phone list view):**

```
Today                             Proposed
┌──────────────────────┐          ┌──────────────────────┐
│ Login Vault   ?  ⬇ 🔒 │          │ Login Vault      ⋯  🔒│
│ [Search credentials ]│          │ Synced · locks 4:12  │
│ All dev banking family│          │ [ Search            ]│
│ streaming work  (wrap)│          │ All Favorites dev ⟶  │
│ ┌──────────────────┐ │          │ ──────────────────── │
│ │ GitHub           │ │          │ [G] GitHub     [👤][🔑]│
│ │ marlon@…         │ │          │     marlon@…         │
│ │ github.com       │ │          │ ──────────────────── │
│ └──────────────────┘ │          │ [N] Netflix    [👤][🔑]│
│                  (+) │          │                  (+) │
└──────────────────────┘          └──────────────────────┘
 tiny buttons, no actions,         theme-native, one-tap copy,
 fixed dark palette                status line, 40 px targets
```

---

## 6. Functional enhancements (backlog)

| # | Feature | Why | Phase |
|---|---|---|---|
| F1 | Trash/restore + tombstones | Safe deletes under sync | 1 |
| F2 | Password history per entry | Recover after a bad change | 2 |
| F3 | Favorites + "recently used" | Faster retrieval | 2 |
| F4 | Vault health report: weak / reused / old / empty-URL (zxcvbn is already bundled) | Quality of stored secrets | 2 |
| F5 | Opt-in breach check via HIBP k-anonymity range API (5-char hash prefix only, off by default, clearly explained) | Actionable security | 3 |
| F6 | TOTP (otpauth URI, SHA-1/256, 30 s) with copy + countdown | Replace a second app | 3 |
| F7 | Custom fields + entry types (login, secure note, card, Wi-Fi) | Real-world coverage | 3 |
| F8 | Passphrase (diceware) generator, pronounceable option | Usable on phones | 2 |
| F9 | Attachments (small encrypted blobs) | Recovery codes/keys | 4 |
| F10 | Multiple vaults in one Obsidian vault | Personal/shared separation | 4 |
| F11 | Audit log (device, time, action: unlock/copy/export) stored encrypted in payload | Detect misuse | 4 |
| F12 | Emergency/offline backup export on schedule to a user-chosen non-synced folder (desktop) | Disaster recovery | 3 |

Explicitly **out of scope**: browser autofill/extension, third-party favicon fetching, cloud accounts, any telemetry.

---

## 7. Roadmap

### Phase 0 — Stop the bleeding (patch release, no format change)
Acceptance: every item has a regression test or a manual device test script.

| Task | Fixes |
|---|---|
| Re-read, decrypt-check and merge before every save; refuse to save if header salt differs from the session's | S1, S2 |
| `vault.on('modify')` watcher: reload/merge or force re-unlock | S1, S2 |
| Chunked base64 | S8 |
| Resolve unlock promise on modal close; render inline locked state; no modal at startup | M3 |
| Context-menu copy goes through `copyWithTimeout`; lock closes all modals | X4, X5 |
| Replace `vault.delete` with trash; add `.bak` write | S6, S7 |
| Warn in setup when file missing: "If you use Sync, wait for your vault to arrive"; show a Sync-health notice about "Sync all other types" | S3, S4 |
| Remove `verificationHash` check from the unlock fast path (use GCM) — *the field can stay in the file until Phase 1* | X1 (partial) |
| PIN: move material to device-local storage, remove `pinHash`, require ≥ 6 digits, add attempt limit | X2 (partial) |
| Scope CSS, fix `.modal-content`; theme variables for light mode | M7, M8 |
| Doc fixes: remove biometric/favicon/encrypted-export claims or implement them | X13, M10 |

### Phase 1 — Format v2 + sync layer
Key slots (§4.1), KDF params in header, non-extractable DEK, migration with backup, per-entry merge + tombstones + trash (§4.3), conflict-file handling, rolling backups, second-device onboarding, recovery key, device-local settings split (§4.4).

### Phase 2 — Mobile-first UI
Inline unlock, cards with visible actions, quick find & copy, deadline-based lock + background lock, native theming/icons, safe-area handling, mobile export/import path, lazy zxcvbn, favorites, history, health report. Visual work follows §5.7 (items 1–2 can ship earlier, in Phase 0, since they are CSS and icon swaps with no data impact).

### Phase 3 — Quick unlock & extras
SecretStorage-backed quick unlock (§4.5), WebAuthn-PRF spike, TOTP, entry types, HIBP opt-in, importers.

### Phase 4 — Optional
Per-entry files (§4.2 option C) if conflict data justifies it, attachments, multi-vault, audit log.

---

## 8. Test plan

**Unit (Node + `webcrypto`, no Obsidian):** KDF/slot wrap-unwrap round trips; tamper detection (flip a byte in each field); merge function property tests (commutative, associative, idempotent; delete beats older edit; edit beats older delete); tombstone pruning; base64 round trip at 0, 1, 64 KB, 5 MB; CSV escaping and formula neutralization; v1→v2 migration; PIN attempt limiter state machine.

**Integration (mock `App.vault` that can inject external modifications):** the S1/S2/S4 sequences as scripted scenarios; corrupt file vs wrong password messages; atomic-write interruption.

**Device matrix (manual, scripted checklist):**

| Scenario | Desktop | iOS | Android |
|---|---|---|---|
| Fresh setup, add 3 entries, restart, unlock | ☐ | ☐ | ☐ |
| Device A edits entry 1, device B edits entry 2 while both unlocked → both present | ☐ | ☐ | ☐ |
| Change password on A while B unlocked; B edits → no corruption | ☐ | ☐ | ☐ |
| New device with "Sync all other types" off → Sync-health warns, nothing deleted | ☐ | ☐ | ☐ |
| Background the app 2 min with 1 min background-lock → locked on return | n/a | ☐ | ☐ |
| Esc/tap-outside on unlock → view still usable | ☐ | ☐ | ☐ |
| Copy password → clipboard cleared at timeout; unchanged clipboard preserved | ☐ | ☐ | ☐ |
| Export/import round trip works with the platform's file flow | ☐ | ☐ | ☐ |
| Light theme, dark theme, one community theme: text legible | ☐ | ☐ | ☐ |
| 500-entry vault: unlock < 2 s on a mid-range phone; save succeeds | ☐ | ☐ | ☐ |

**Security checks:** `grep` the shipped vault file and `data.json` for plaintext and for any fast-hash-of-secret fields; confirm no `exportKey` path after unlock; confirm no network calls (other than opt-in HIBP).

---

## 9. Open questions (need a decision or an experiment)

1. **Sync reality check [verify]:** on a real Obsidian Sync account, does a `.enc`/`.lv` file sync with the default toggles, and what happens to it on a new device? Result decides whether Phase 0 needs a loud blocker rather than a notice.
2. **Minimum Obsidian version:** raising `minAppVersion` to ≥ 1.11.4 buys SecretStorage; alternatively feature-detect and keep 1.4.0. Which audience matters more?
3. **Argon2id WASM:** acceptable +~100 KB bundle and 64 MiB peak memory on low-end phones?
4. **WebAuthn PRF in Obsidian mobile webviews:** spike result gates any biometric claim.
5. **Recovery key vs. "no recovery" stance:** current UX promises no recovery; a recovery key is better UX but is a second secret the user must guard. Proposed default: strongly recommended, skippable.
6. **File name/extension and visibility:** keep root `login-vault.enc` for backwards compatibility, or move to a folder? Migration cost vs. cleanliness.

---

## Sources

- [Obsidian Sync — Settings & selective sync](https://help.obsidian.md/sync/settings)
- [Obsidian Sync — Troubleshoot / conflict handling](https://obsidian.md/help/sync/troubleshoot)
- [Forum: excluded file types deleted when syncing on a new device](https://forum.obsidian.md/t/excluded-file-types-deleted-when-syncing-on-new-device/116006)
- [Obsidian API — SecretStorage](https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage)
- [Forum: SecretStorage scoping across vaults](https://forum.obsidian.md/t/secretstorage-appears-to-be-shared-across-vaults-on-mobile-but-vault-scoped-on-desktop/117793)
