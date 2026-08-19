# Login Vault — Plugin Documentation

> **Version:** 1.0.0 | **Last Updated:** 2026-03-09

Login Vault is an Obsidian plugin that provides encrypted, organized storage and retrieval of login credentials directly inside your vault. All data is stored in a single encrypted file, compatible with Obsidian Sync.

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
- A salted SHA-256 hash of the password is stored in the encrypted file's header for unlock verification only
- The derived `CryptoKey` object is held in **memory only** for the duration of the unlocked session

### PIN
- The PIN is stored as a salted SHA-256 hash in the plugin's `data.json` (synced via Obsidian Sync), used as a fast pre-check
- The real vault key is also **wrapped** — encrypted with a separate key derived from the PIN via PBKDF2 — and that wrapped blob is stored alongside the hash
- On PIN unlock, the plugin re-derives the PIN key and unwraps the vault key from that blob, so a cold start (app fully closed, no key in memory) works from the PIN alone, without needing the master password
- Changing the master password re-encrypts the vault with a new key, which invalidates any existing PIN's wrapped blob — the plugin clears the PIN on password change and prompts the user to set a new one

### Biometric
Biometric unlock (Face ID / fingerprint via WebAuthn) was removed. A biometric assertion on this platform doesn't yield reusable key material the way a password or PIN does — there's no OS-backed secure enclave API exposed to Obsidian plugins to bind an assertion to a stored secret. Implementing it would mean either it silently fails after every restart (the original bug), or storing the vault-key-wrapping secret unprotected in `data.json`, which would let anyone with filesystem access decrypt the vault without any biometric check at all — worse than not having the feature.

### Encrypted File (`login-vault.enc`)
Stored as a JSON envelope in the vault root:
```json
{
  "version": 1,
  "salt": "<base64 — 16 bytes>",
  "verificationHash": "<base64 — SHA-256 of password+salt>",
  "iv": "<base64 — 12 bytes>",
  "ciphertext": "<base64 — AES-256-GCM encrypted payload>"
}
```
The plaintext payload (before encryption) is a JSON array of `CredentialEntry` objects.

---

## Authentication Methods

| Method | Desktop | Mobile | Notes |
|---|---|---|---|
| Master Password | ✅ | ✅ | Required for first unlock, or any time no PIN is set |
| PIN Code | ✅ | ✅ | 4–8 digit numeric code; unwraps the real vault key, works from a cold start |

### Session & Auto-Lock
- An auto-lock timer resets on every user interaction
- Configurable timeout: 1 minute to 60 minutes (default: 5 minutes), or disabled
- On lock, the in-memory `CryptoKey` is invalidated immediately

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
    ├── crypto.ts               ← Encryption / decryption / PBKDF2
    ├── store.ts                ← Credential CRUD + file I/O
    ├── auth.ts                 ← Session, PIN auth
    ├── password-gen.ts         ← Password generator + strength checker
    └── ui/
        ├── VaultView.ts        ← Main sidebar view (credential list)
        ├── UnlockModal.ts      ← Unlock screen (password / PIN)
        ├── SetupModal.ts       ← First-run wizard
        ├── CredentialModal.ts  ← Add / Edit credential form
        ├── CredentialDetailModal.ts ← Read-only detail + copy buttons
        ├── PasswordGenModal.ts ← Password generator UI
        └── SettingsTab.ts      ← Plugin settings tab
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
| `decryptData(key, iv, ciphertext)` | Returns UTF-8 plaintext string |
| `hashForVerification(password, salt)` | SHA-256(password + salt), base64 |

### `src/store.ts`
| Method | Description |
|---|---|
| `isInitialized()` | Check if `login-vault.enc` exists |
| `load(key)` | Decrypt and load credentials into memory |
| `save(key)` | Encrypt and write credentials to disk |
| `getAllCredentials()` | Return in-memory credential array |
| `addCredential(entry)` | Add + auto-save |
| `updateCredential(id, changes)` | Update + auto-save |
| `deleteCredential(id)` | Remove + auto-save |
| `exportJSON(encrypted?)` | Export as JSON (plain or re-encrypted) |
| `exportCSV()` | Export as plaintext CSV (warns user) |
| `importJSON(json, key)` | Merge imported credentials |

### `src/auth.ts`
| Method | Description |
|---|---|
| `setupMasterPassword(password)` | Initialize vault with new master password |
| `unlock(password)` | Derive key, verify, store in session |
| `lock()` | Clear session key, reset timer |
| `isLocked()` | Returns boolean |
| `setupPIN(pin)` | Hash PIN + wrap vault key with a PIN-derived key; store both in settings |
| `unlockWithPIN(pin)` | Verify hash, unwrap vault key, re-authorize session |
| `resetAutoLock(minutes)` | Call on user activity |

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
- Shows searchable, filterable list of credential cards
- Each card shows: title, username, URL favicon (if available), tags
- Floating "+ Add" button opens `CredentialModal`
- Header buttons: ❓ Help (opens `HelpModal`), ⬇️ Export all credentials to CSV, 🔒 Lock (`auth.lock()` + shows `UnlockModal` next time)
- ❓ Help button is also shown on the locked screen (the first thing you see after opening the view), so instructions are available before unlocking

### HelpModal
- Quick-reference instructions: adding/finding credentials, locking & unlocking, copying passwords, export/import, and what to do if you forget your password
- Opened from the ❓ button on both the locked screen and the unlocked header

### UnlockModal
- Shown automatically when the vault is locked and a credential action is attempted
- **Password mode:** Password input + "Unlock" button
- **PIN mode:** 4–8 digit keypad overlay

### SetupModal (First Run)
Three-step wizard shown when no `login-vault.enc` exists:
1. Create + confirm master password (with real-time strength meter)
2. Optionally set a PIN (can be skipped)
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
- Set / change / remove PIN (requires vault to be unlocked; cleared automatically if the master password changes)
- Export: Encrypted JSON | Plaintext JSON | CSV
- Import: JSON file
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
| Export: Encrypted JSON | ✅ Implemented |
| Export: Plaintext JSON / CSV | ✅ Implemented (with warning; CSV also available directly from the vault view) |
| Import: JSON | ✅ Implemented |
| In-app help (❓ button) | ✅ Implemented |
| Obsidian Sync compatible | ✅ By design (file in vault root) |

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
