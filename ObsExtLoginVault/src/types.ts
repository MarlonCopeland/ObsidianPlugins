// ─────────────────────────────────────────────────────────────────────────────
// types.ts — Core data interfaces for Login Vault plugin
// ─────────────────────────────────────────────────────────────────────────────

export interface CredentialEntry {
    id: string;
    title: string;
    username: string;
    password: string;
    url?: string;
    notes?: string;
    tags?: string[];
    createdAt: number;
    updatedAt: number;
}

/** The raw structure stored in login-vault.enc (all crypto fields as base64) */
export interface VaultData {
    version: number;
    salt: string;             // base64, 16 bytes — PBKDF2 salt
    /** Legacy (v1.0/1.1 files only). Never written any more — it allowed fast offline password guessing. */
    verificationHash?: string;
    iv: string;               // base64, 12 bytes — AES-GCM IV
    ciphertext: string;       // base64 — encrypted JSON array of CredentialEntry[]
}

export interface PasswordGenOptions {
    length: number;
    uppercase: boolean;
    lowercase: boolean;
    numbers: boolean;
    symbols: boolean;
    excludeAmbiguous: boolean;
}

export interface PluginSettings {
    autoLockMinutes: number;            // 0 = disabled
    clipboardClearSeconds: number;      // 0 = disabled
    passwordGenDefaults: PasswordGenOptions;
    hasMasterPassword: boolean;         // false on first run
    // Quick-unlock (PIN) material is intentionally NOT here: data.json is synced
    // to other devices (and Obsidian's servers). It lives in device-local storage.
}

export const DEFAULT_SETTINGS: PluginSettings = {
    autoLockMinutes: 5,
    clipboardClearSeconds: 30,
    hasMasterPassword: false,
    passwordGenDefaults: {
        length: 20,
        uppercase: true,
        lowercase: true,
        numbers: true,
        symbols: true,
        excludeAmbiguous: false,
    },
};

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface StrengthResult {
    score: StrengthScore;
    label: string;
    feedback: string;
}
