# Login Vault — Plugin Documentation

> **Version:** 1.2.0 | **Last Updated:** 2026-11-05

Login Vault is an Obsidian plugin that provides encrypted, organized storage and retrieval of login credentials directly inside your vault. All data is stored in a single encrypted file. It can sync through Obsidian Sync, but only if "Sync all other types" is turned on (see [Syncing](#syncing)).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Security Model](#security-model)
3. [Authentication Methods](#authentication-methods)
4. [File Structure](#file-structure)
5. [Source Modules](#source-modules)
6. [UI Components](#ui-components)
7. [Features](#features)
8. [Settings Reference](#settings-reference)
9. [Data Formats](#data-formats)
10. [Build & Development](#build--development)
11. [Changelog](#changelog)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Obsidian Plugin Host                │
│  ┌───────────────┐   ┌──────────────────────────┐   │
│  │  main.ts      │   │  SettingsTab.ts           │   │
│  │  (Plugin root)│   │  (Plugin settings UI)     │   │
│  └──────┬────────┘   └──────────────────────────┘   │
│         │                                            │
│  ┌──────▼────────────────────────────────────────┐  │
│  │                  auth.ts                       │  │
│  │  Session manager · PIN · Auto-lock             │  │
│  └──────┬────────────────────────────────────────┘  │
│         │                                            │
│  ┌──────▼────────┐   ┌──────────────────────────┐   │
│  │  crypto.ts    │   │  password-gen.ts          │   │
│  │  AES-256-GCM  │   │  Generator + zxcvbn       │   │
│  │  PBKDF2-SHA256│   │  strength checker          │   │
│  └──────┬────────┘   └──────────────────────────┘   │
│         │                                            │
│  ┌──────▼────────┐                                   │
│  │  store.ts     │──── login-vault.enc (vault root)  │
│  │  Credential   │                                   │
│  │  persistence  │                                   │
│  └───────────────┘                                   │
│                                                      │
│  UI Layer: VaultView · CredentialModal ·             │
│            CredentialDetailModal · UnlockModal ·     │
│            PasswordGenModal · SetupModal             │
└─────────────────────────────────────────────────────┘
```

---

## Security Model

### Encryption
- **Algorithm:** AES-256-GCM (authenticated encryption — provides both confidentiality and integrity)
- **Key Derivation:** PBKDF2-SHA256 with **310,000 iterations** and a random 16-byte salt
- **IV:** A fresh random 12-byte IV is generated for every save operation
- **API:** All cryptographic operations use the browser-native **Web Crypto API** (`window.crypto.subtle`), available in both Electron (desktop) and Capacitor (mobile)

### Master Password
- The master password is **never stored anywhere**
- There is **no stored password hash**. A wrong password simply fails the AES-GCM authentication tag when decrypting. (Files from v1.0/1.1 contained a fast `SHA-256(password+salt)` check that let someone with a copy of the file guess passwords without paying the PBKDF2 cost; it is removed from the file the first time v1.2 unlocks it. Copies of the old file — for example in Obsidian Sync version history — still contain it, so consider changing the master password.)
- The derived `CryptoKey` object is held in **memory only** for the duration of the unlocked session
- Use a long passphrase: it is the real protection. Setup and password change require at least 10 characters and a zxcvbn score of 3

### PIN (quick unlock, per device)
- The PIN is **device-local**: it lives in Obsidian's vault-scoped local storage (`app.saveLocalStorage`) and is **never written to `data.json`**, which syncs to other devices
- It is 6–12 digits. The vault key is wrapped with a key derived from the PIN (PBKDF2); there is no separate PIN hash, so a wrong PIN simply fails the AES-GCM tag
- After **5 wrong PINs** the PIN is erased and the master password is required
- Be clear about the limit: anyone who can copy this device's files can brute-force a numeric PIN offline, and the attempt counter only guards the plugin UI. Treat the PIN as a convenience, not a second factor
- Changing the master password (here or on another device) invalidates the PIN on every device; set a new one
- v1.1 stored PIN material in `data.json`. v1.2 deletes it on first load; set a new PIN

### Biometric
Biometric unlock (Face ID / fingerprint via WebAuthn) was removed. A biometric assertion on this platform doesn't yield reusable key material the way a password or PIN does — there's no OS-backed secure enclave API exposed to Obsidian plugins to bind an assertion to a stored secret. Implementing it would mean either it silently fails after every restart (the original bug), or storing the vault-key-wrapping secret unprotected in `data.json`, which would let anyone with filesystem access decrypt the vault without any biometric check at all — worse than not having the feature.

### Encrypted File (`login-vault.enc`)
Stored as a JSON envelope in the vault root:
```json
{
  "version": 1,
  "salt": "<base64 — 16 bytes>",
  "iv": "<base64 — 12 bytes>",
  "ciphertext": "<base64 — AES-256-GCM encrypted payload>"
}
```
The plaintext payload (before encryption) is a JSON array of `CredentialEntry` objects. Files written by v1.0/1.1 also have a `verificationHash` field; it is ignored and removed on the next save.

### Syncing

<a id="syncing"></a>

- **Obsidian Sync does not sync unknown file types by default.** Turn on **Settings → Sync → Selective sync → "Sync all other types"** on *every* device. It is a per-device setting; a device without it may not receive the vault (and has been reported to cause such files to be removed remotely).
- **Every write is read → decrypt → three-way merge → write**, serialized through a queue. The merge (`src/merge.ts`) compares this device's memory, the file on disk, and the state at the last load/save, so entries added on two devices are both kept, a deletion is not resurrected, and an edit beats a deletion made elsewhere.
- **Changes from other devices are picked up automatically** while the vault is unlocked (a debounced watcher on the vault file). Your own writes are recognised and ignored.
- **Password changed on another device:** this device locks and asks for the new password instead of writing a file nobody can decrypt.
- **Vault file removed (for example by a sync):** it is re-created from memory on the next change, with a notice.
- **First run on a second device** asks whether you already have a vault; "wait for it" polls for the file. The setup wizard will not overwrite an existing vault file.
- **Backups:** up to 8 encrypted snapshots are kept in `.obsidian/plugins/login-vault/backups/` (device-local, not synced), taken before writes at most every 2 minutes. If the vault file is damaged, the unlock screen reports it as damaged (not "wrong password") and offers *Restore latest backup*.
- **Reset** moves the vault file to the vault trash (after a backup) instead of permanently deleting it.
- Remaining limitation: the vault is still one file. If two devices write at almost the same moment and the sync service keeps only one copy, one change can be lost; the next sync reload merges whatever survives. Per-entry files are a possible future step.

---

## Authentication Methods

| Method | Desktop | Mobile | Notes |
|---|---|---|---|
| Master Password | ✅ | ✅ | Required for first unlock, or any time no PIN is set |
| PIN Code | ✅ | ✅ | 6–12 digit numeric code, stored on this device only; unwraps the vault key, works from a cold start; erased after 5 wrong tries |

### Session & Auto-Lock
- Activity (key, pointer, touch, wheel) extends the session, but only while it is still valid
- Configurable timeout: 1 minute to 60 minutes (default: 5 minutes), or disabled
- The timeout is a **deadline checked against the clock**, not just a timer: mobile OSes suspend timers in the background, so the deadline is also checked whenever the app regains focus and whenever the session key is requested
- On lock (manual, timer, or because the vault was invalidated) the in-memory key is dropped, **every open credential/generator dialog closes**, and a copied secret is cleared from the clipboard

---

## File Structure

```
ObsExtLoginVault/               ← Obsidian vault root
├── login-vault.enc             ← Encrypted credentials file (syncs with Obsidian Sync)
├── DOCUMENTATION.md            ← This file
├── manifest.json               ← Plugin metadata
├── package.json                ← Node project / build config
├── tsconfig.json               ← TypeScript config
├── esbuild.config.mjs          ← Build script
├── styles.css                  ← Plugin UI styles
├── main.js                     ← Compiled plugin output (generated)
└── src/
    ├── main.ts                 ← Plugin entry point
    ├── types.ts                ← TypeScript interfaces
    ├── crypto.ts               ← Encryption / decryption / PBKDF2 / key wrapping
    ├── merge.ts                ← Pure three-way merge of credential lists
    ├── store.ts                ← Credential CRUD, sync-safe file I/O, backups
    ├── device-store.ts         ← Device-local (unsynced) key/value storage
    ├── auth.ts                 ← Session, PIN, auto-lock deadline, lock events
    ├── password-gen.ts         ← Password generator + strength checker
    └── ui/
        ├── VaultView.ts        ← Main sidebar view (credential list)
        ├── UnlockModal.ts      ← Unlock screen (password / PIN)
        ├── SetupModal.ts       ← First-run wizard
        ├── CredentialModal.ts  ← Add / Edit credential form
        ├── CredentialDetailModal.ts ← Read-only detail + copy buttons
        ├── PasswordGenModal.ts ← Password generator UI
        └── SettingsTab.ts      ← Plugin settings tab

tests/vault.test.mjs            ← Node tests (npm test): merge, crypto, two-device sync, PIN, auto-lock
```

---

## Source Modules

### `src/types.ts`
Core data interfaces:

```typescript
interface CredentialEntry {
  id: string;           // UUID
  title: string;
  username: string;
  password: string;
  url?: string;
  notes?: string;
  tags?: string[];
  createdAt: number;    // Unix timestamp
  updatedAt: number;
}

interface VaultData {
  version: number;
  salt: string;             // base64
  verificationHash: string; // base64
  iv: string;               // base64
  ciphertext: string;       // base64
}

interface PluginSettings {
  autoLockMinutes: number;       // 0 = disabled
  clipboardClearSeconds: number; // 0 = disabled
  passwordGenDefaults: PasswordGenOptions;
  pinHash?: string;              // salted SHA-256 hash of PIN
  pinSalt?: string;              // base64 salt for PIN hash
}
```

### `src/crypto.ts`
| Function | Description |
|---|---|
| `generateSalt()` | Returns 16 random bytes as base64 |
| `generateIV()` | Returns 12 random bytes as base64 |
| `deriveKey(password, salt)` | PBKDF2-SHA256 → AES-256-GCM CryptoKey |
| `encryptData(key, plaintext)` | Returns `{ iv, ciphertext }` as base64 |
| `decryptData(key, iv, ciphertext)` | Returns UTF-8 plaintext; throws if the key is wrong or the data was tampered with |
| `wrapKeyRaw` / `unwrapKeyRaw` | Wrap the vault key with a PIN-derived key (device-local quick unlock) |

Base64 conversion is chunked, so large vaults no longer overflow the call stack.

### `src/merge.ts`
`merge(base, local, remote)` — pure three-way merge by entry `id`. `snapshot()` / `sameSnapshot()` record and compare `id → updatedAt`.

### `src/store.ts`
| Method | Description |
|---|---|
| `isInitialized()` / `readState()` | File exists / classify as `ok`, `missing`, `corrupt` |
| `initialize(key, salt)` | Create the vault; refuses if a vault file already exists |
| `unlockWithKey(key)` | Decrypt and load credentials (decryption is the password check) |
| `addCredential` / `updateCredential` / `deleteCredential` | Read → merge → mutate → write, serialized |
| `syncFromDisk(key)` / `hasExternalChange()` | Merge in another device's changes; ignore our own writes |
| `changeMasterPassword(currentKey, newKey, newSalt)` | Merge, then re-key and write |
| `exportJSON()` / `exportCSV()` | Plaintext exports (CSV cells starting `= + - @` are neutralised against formula injection) |
| `importJSON(json, key)` | Validate and merge imported credentials |
| `listBackups()` / `backupNow()` / `restoreLatestBackup()` | Encrypted rolling backups |

Raises `VaultKeyChangedError` (password changed elsewhere) and `VaultCorruptError`, and calls `onInvalidated` so the plugin can lock.

### `src/auth.ts`
| Method | Description |
|---|---|
| `setupMasterPassword(password)` | Initialize vault with new master password |
| `unlock(password)` | Derive key, decrypt, start session; sets `lastFailure` (`wrong-password`, `corrupt`, `missing`) |
| `lock()` | Clear session key, notify `onLock` listeners |
| `isLocked()` | Returns boolean (also enforces the auto-lock deadline) |
| `changeMasterPassword(current, new)` | Verifies the current password by decrypting, then re-keys; clears this device's PIN |
| `setupPIN(pin)` / `removePIN()` / `hasPIN()` | Device-local PIN (6–12 digits) |
| `unlockWithPIN(pin)` | Unwrap the vault key; 5 wrong tries erases the PIN |
| `resetAutoLock(minutes)` / `noteActivity()` / `checkDeadline()` | Deadline-based auto-lock |
| `onLock(listener)` | Subscribe to every lock |

### `src/password-gen.ts`
| Function | Description |
|---|---|
| `generatePassword(options)` | Generates password per config |
| `checkStrength(password)` | Returns `{ score: 0–4, feedback: string }` |

**`PasswordGenOptions`:**
```typescript
{
  length: number;           // default: 20
  uppercase: boolean;       // default: true
  lowercase: boolean;       // default: true
  numbers: boolean;         // default: true
  symbols: boolean;         // default: true
  excludeAmbiguous: boolean; // default: false (excludes 0, O, l, 1, etc.)
}
```

---

## UI Components

### VaultView (Sidebar)
- Registered as a custom `ItemView` in the left sidebar
- Shows a searchable list of credential rows with a horizontally scrolling tag filter
- Each row shows: title, username, domain, tags, and **visible buttons** to copy the username, copy the password, and open a menu (edit / delete). Right-click still works on desktop
- Floating "+" button opens `CredentialModal`
- Header buttons (Lucide icons with accessible labels): Help, Export all credentials to CSV, Lock
- A locked view shows an Unlock button; it never opens a password dialog by itself when Obsidian restores the view at startup
- Help is also available on the locked screen

### HelpModal
- Quick-reference instructions: adding/finding credentials, locking & unlocking, copying passwords, export/import, and what to do if you forget your password
- Opened from the ❓ button on both the locked screen and the unlocked header

### UnlockModal
- Shown when you open the vault (ribbon / command) or press Unlock
- **Password mode:** Password input + "Unlock" button
- **PIN mode:** 6–12 digit keypad, also accepts the physical keyboard; opens on the PIN tab when a PIN is set on this device
- Closing it any way (Esc, tapping outside) always settles the caller — the view never hangs
- Tells a damaged vault file apart from a wrong password and offers *Restore latest backup*

### SetupModal (First Run)
Shown when no `login-vault.enc` exists:
0. Choose: create a new vault, or "I already have a vault on another device" (polls until it arrives). If this device had a vault before, the file is reported as missing and a backup can be restored
1. Create + confirm master password (min 10 characters, zxcvbn score 3, real-time strength meter)
2. Optionally set a device-local PIN (can be skipped)
3. Done screen with usage tips

### CredentialModal (Add / Edit)
- Fields: Title*, Username*, Password* (masked), URL, Notes, Tags (comma-separated)
- Inline password strength bar updates as user types
- "🔀 Generate" button populates the password field via `PasswordGenModal`
- "👁 Show/Hide" toggle on password field

### CredentialDetailModal
- All fields displayed read-only
- Password masked by default with reveal toggle
- Copy buttons for username and password
- Clipboard auto-clears after configured delay (countdown shown)
- Edit button → opens `CredentialModal` in edit mode

### PasswordGenModal
- Length slider (8–128)
- Toggles: Uppercase, Lowercase, Numbers, Symbols, Exclude Ambiguous
- Live-generated password preview + strength meter
- "🔄 Regenerate", "📋 Copy", "✅ Use This" buttons

### SettingsTab
Settings registered via `addSettingTab()`:
- Auto-lock timeout (dropdown)
- Clipboard auto-clear delay (dropdown)
- Change master password (requires current password)
- Set / change / remove this device's PIN (requires vault to be unlocked; cleared automatically if the master password changes)
- Sync and backups: vault file status, Obsidian Sync guidance, back up now
- Export: Plaintext JSON | CSV (both warn that they are unencrypted)
- Import: JSON file (entries are validated)
- Reset vault (confirmation required)

---

## Features

| Feature | Status |
|---|---|
| Add / Edit / Delete credentials | ✅ Implemented |
| Search & filter | ✅ Implemented |
| Tag / category organization | ✅ Implemented |
| Password generator | ✅ Implemented |
| Password strength meter (zxcvbn) | ✅ Implemented |
| Copy with clipboard auto-clear | ✅ Implemented |
| Master password auth | ✅ Implemented |
| PIN auth (works from cold start) | ✅ Implemented |
| Auto-lock timer (locks UI too, not just data) | ✅ Implemented |
| Export: Plaintext JSON / CSV | ✅ Implemented (with warning; CSV also available directly from the vault view) |
| Encrypted export | ❌ Not implemented (planned) |
| Import: JSON | ✅ Implemented |
| In-app help (❓ button) | ✅ Implemented |
| Merge changes from other devices | ✅ Three-way merge, automatic reload |
| Encrypted rolling backups + restore | ✅ Implemented |
| Obsidian Sync | ⚠️ Works only with "Sync all other types" enabled on every device |

---

## Settings Reference

| Setting | Default | Description |
|---|---|---|
| `autoLockMinutes` | `5` | Minutes of inactivity before auto-lock. `0` = disabled |
| `clipboardClearSeconds` | `30` | Seconds before clipboard is cleared after copy. `0` = disabled |
| `passwordGenDefaults.length` | `20` | Default generated password length |
| `passwordGenDefaults.uppercase` | `true` | Include uppercase letters |
| `passwordGenDefaults.lowercase` | `true` | Include lowercase letters |
| `passwordGenDefaults.numbers` | `true` | Include digits |
| `passwordGenDefaults.symbols` | `true` | Include symbols |
| `passwordGenDefaults.excludeAmbiguous` | `false` | Exclude 0, O, l, 1, I |

---

## Data Formats

### Export: Plaintext JSON
```json
[
  {
    "id": "abc123",
    "title": "GitHub",
    "username": "johndoe",
    "password": "s3cr3t!",
    "url": "https://github.com",
    "notes": "",
    "tags": ["dev", "git"],
    "createdAt": 1741537100000,
    "updatedAt": 1741537100000
  }
]
```

### Export: CSV
```
title,username,password,url,notes,tags
GitHub,johndoe,s3cr3t!,https://github.com,,dev|git
```

### Import format
Same as plaintext JSON export. Duplicate entries (matched by `id`) are skipped or updated based on `updatedAt` timestamp.

---

## Build & Development

### Prerequisites
- Node.js ≥ 18
- npm ≥ 9
- An Obsidian vault for testing

### Commands
```powershell
# Install dependencies
npm install

# Development build (watch mode)
npm run dev

# Production build
npm run build

# Type-check and run the tests
npm run typecheck
npm test
```

### Installing in Obsidian (development)

After building, the plugin files need to be in your vault's plugin folder:
```
<YourVault>/.obsidian/plugins/login-vault/
├── main.js
├── manifest.json
└── styles.css
```

The `esbuild.config.mjs` is configured to output directly to this location.

Enable the plugin in: **Settings → Community Plugins → Login Vault**

> **Note:** You must disable Safe Mode first: **Settings → Community Plugins → Turn off Safe Mode**

---

## Changelog

### v1.2.0 — 2026-11-05
Security, sync-safety and UI fixes. **Update the plugin on all your devices**: v1.1 cannot unlock a file saved by v1.2 (the password hash it requires is gone).

**Sync and data safety**
- **Fix:** A device that was open while another device changed the vault no longer overwrites those changes. Every save now reads the file, merges (three-way, by entry), then writes; changes from other devices are picked up automatically.
- **Fix:** Changing the master password on one device no longer lets another, still-unlocked device write a vault nobody can decrypt; it locks and asks for the new password.
- **Fix:** The first-run wizard can no longer overwrite an existing vault. A second device is asked whether a vault already exists and waits for it to sync. Settings now explain that Obsidian Sync needs "Sync all other types".
- **Fix:** A damaged vault file is reported as damaged instead of "Incorrect password", with one-click restore from the rolling encrypted backups.
- **Fix:** Saving a large vault no longer fails on mobile (base64 conversion overflowed the call stack).
- **Changed:** Reset moves the vault file to the vault trash (after a backup) instead of permanently deleting it. Saves are serialized.

**Security**
- **Fixed:** The stored `SHA-256(password+salt)` check allowed fast offline password guessing. It is removed; a wrong password now fails the AES-GCM tag.
- **Fixed:** PIN material was in the synced `data.json` and protected only by a 4–8 digit PIN. The PIN is now device-local (never synced), 6–12 digits, has no separate hash, and erases itself after 5 wrong tries. The old PIN is deleted on upgrade; set a new one. (A numeric PIN is still guessable by someone who can copy the device's files.)
- **Fixed:** Auto-lock now uses a deadline checked against the clock (mobile suspends timers), counts pointer/touch/scroll activity, closes every open credential dialog, and clears a copied secret from the clipboard.
- **Fixed:** "Copy password" in the right-click menu bypassed the clipboard auto-clear. The clipboard is only cleared if it still holds the copied value.
- **Changed:** Master password: min 10 characters and zxcvbn score 3. CSV export neutralises spreadsheet formulas. Imports are validated. Secret inputs disable autocomplete and spellcheck.

**Interface**
- **Fixed:** Pressing Esc or tapping outside the unlock dialog no longer leaves a blank pane, and Obsidian no longer shows a password prompt every time it restores the view at startup.
- **Changed:** Follows your Obsidian theme (light, dark, community themes) instead of a fixed dark palette; all styles are scoped to the plugin (a global `.modal-content` rule no longer affects other modals).
- **Changed:** Lucide icons with accessible labels replace emoji; each row has visible copy-username, copy-password and menu buttons (right-click isn't needed on mobile); the tag filter scrolls in one row; touch targets are 44 px on touch devices; the PIN pad accepts the keyboard.
- **Removed from docs:** favicon and encrypted-export claims (they were never implemented).

### v1.1.0 — 2026-08-18
- **Fix:** PIN unlock now actually works after a cold start. It previously only re-used an in-memory session key that was always `null` whenever the unlock screen appeared, so a correct PIN was always rejected. The vault key is now wrapped with a PIN-derived key and unwrapped on PIN unlock.
- **Removed:** Biometric unlock. It had the same always-`null`-session-key bug as PIN, and a sound fix isn't possible without an OS-backed secure keystore that isn't available to Obsidian plugins — storing the required wrapping secret in `data.json` would let anyone with filesystem access skip authentication entirely.
- **Fix:** Changing the master password now requires re-entering the current password; previously the field was collected but never checked.
- **Fix:** Changing the master password now clears any existing PIN (its wrapped key becomes stale) instead of leaving it silently broken.
- **Fix:** The auto-lock timer now refreshes any open vault view when it fires, instead of leaving the credential list visible and interactive until the user hit a confusing "vault is locked" error.
- **Fix:** Rapidly clicking "Copy" no longer stacks multiple independent clipboard-clear timers.
- **Added:** ❓ Help button on the locked screen and the main header, opening a quick-reference instructions modal.
- **Added:** Export all credentials to CSV directly from the vault view (previously only reachable via Settings).
- **Changed:** Author set to Unjaded Digital Products.

### v1.0.0 — 2026-03-09
- Initial release
- AES-256-GCM encryption with PBKDF2-SHA256 key derivation
- Master password, PIN, and biometric (mobile) authentication
- Full credential CRUD with search, tags, and categories
- Password generator with zxcvbn strength checking
- Clipboard auto-clear
- Export (encrypted JSON, plaintext JSON, CSV) and Import (JSON)
- Obsidian Sync compatible via vault-root encrypted file
- Auto-lock with configurable timeout
- Premium dark-mode UI with responsive mobile layout
