// ─────────────────────────────────────────────────────────────────────────────
// auth.ts — Session manager: master password, PIN, auto-lock
// ─────────────────────────────────────────────────────────────────────────────

import { App, normalizePath, TFile } from "obsidian";
import type { PluginSettings } from "./types";
import {
    deriveKey,
    generateSalt,
    hashPIN,
    unwrapKeyRaw,
    verifyPassword,
    verifyPIN,
    wrapKeyRaw,
} from "./crypto";
import type { CredentialStore } from "./store";

/** Minimal interface the AuthManager needs from the Plugin host — avoids circular imports */
interface PluginHost {
    settings: PluginSettings;
    app: App;
    saveData(data: unknown): Promise<void>;
}

export type UnlockMethod = "password" | "pin";

export class AuthManager {
    private sessionKey: CryptoKey | null = null;
    private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
    private plugin: PluginHost;
    private store: CredentialStore;

    /** Invoked when the auto-lock *timer* fires (not on manual lock() calls) — lets the host refresh any open UI. */
    onAutoLock: (() => void) | null = null;

    constructor(plugin: PluginHost, store: CredentialStore) {
        this.plugin = plugin;
        this.store = store;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    isLocked(): boolean {
        return this.sessionKey === null;
    }

    getSessionKey(): CryptoKey | null {
        return this.sessionKey;
    }

    // ── Master password unlock ────────────────────────────────────────────────

    /**
     * Derives a key from the password, verifies it against the stored hash,
     * then delegates to the store to decrypt credentials.
     */
    async unlock(password: string): Promise<boolean> {
        const settings = this.plugin.settings as PluginSettings;

        // We need the salt to derive the key — read it from the vault file
        const vaultData = await this.readVaultMeta();
        if (!vaultData) return false;

        // Verify password before spending full key derivation cycles
        const passwordOk = await verifyPassword(password, vaultData.salt, vaultData.verificationHash);
        if (!passwordOk) return false;

        const key = await deriveKey(password, vaultData.salt);
        const unlocked = await this.store.unlockWithKey(key);
        if (!unlocked) return false;

        this.sessionKey = key;
        this.resetAutoLock(settings.autoLockMinutes);
        return true;
    }

    // ── Setup (first run) ─────────────────────────────────────────────────────

    /**
     * Derives a key from a new master password and initializes the vault.
     * The salt is generated inside store.initialize().
     */
    async setupMasterPassword(password: string): Promise<boolean> {
        try {
            // Generate salt HERE so the same salt is used for both
            // key derivation and the vault file header
            const salt = generateSalt();
            const key = await deriveKey(password, salt);

            await this.store.initialize(key, password, salt);

            this.sessionKey = key;
            const settings = this.plugin.settings;
            settings.hasMasterPassword = true;
            await this.plugin.saveData(settings);
            return true;
        } catch (e) {
            console.error("LoginVault: setupMasterPassword failed", e);
            return false;
        }
    }

    /**
     * Change the master password. Vault must be unlocked, and the caller must
     * supply the *current* password so it can be verified before proceeding —
     * being "unlocked" only proves someone unlocked the vault at some point,
     * not that whoever is at the keyboard right now knows the password.
     *
     * Any existing PIN is invalidated (it wraps the old key, which no longer
     * matches the re-encrypted vault) — the caller should prompt the user to
     * set a new one.
     */
    async changeMasterPassword(currentPassword: string, newPassword: string): Promise<boolean> {
        if (this.isLocked()) return false;
        try {
            const vaultData = await this.readVaultMeta();
            if (!vaultData) return false;
            const currentOk = await verifyPassword(currentPassword, vaultData.salt, vaultData.verificationHash);
            if (!currentOk) return false;

            // Generate the new salt here so key and vault header use the same one
            const newSalt = generateSalt();
            const newKey = await deriveKey(newPassword, newSalt);
            await this.store.changeMasterPassword(newKey, newPassword, newSalt);
            this.sessionKey = newKey;

            const settings = this.plugin.settings as PluginSettings;
            if (settings.pinHash || settings.pinSalt || settings.pinWrappedKey) {
                delete settings.pinHash;
                delete settings.pinSalt;
                delete settings.pinWrappedKey;
                await this.plugin.saveData(settings);
            }
            return true;
        } catch {
            return false;
        }
    }

    // ── PIN ───────────────────────────────────────────────────────────────────

    /**
     * Sets up (or replaces) the PIN. Requires an active session, because the
     * real vault key is wrapped with a PIN-derived key so unlockWithPIN can
     * recover it from a cold start — not just re-open an already-cached key.
     */
    async setupPIN(pin: string): Promise<void> {
        if (!this.sessionKey) throw new Error("Vault must be unlocked to set up a PIN");
        const settings = this.plugin.settings as PluginSettings;
        const salt = generateSalt();
        const hash = await hashPIN(pin, salt);
        const pinKey = await deriveKey(pin, salt);
        const wrappedKey = await wrapKeyRaw(this.sessionKey, pinKey);

        settings.pinSalt = salt;
        settings.pinHash = hash;
        settings.pinWrappedKey = wrappedKey;
        await this.plugin.saveData(settings);
    }

    async removePIN(): Promise<void> {
        const settings = this.plugin.settings as PluginSettings;
        delete settings.pinSalt;
        delete settings.pinHash;
        delete settings.pinWrappedKey;
        await this.plugin.saveData(settings);
    }

    hasPIN(): boolean {
        const settings = this.plugin.settings as PluginSettings;
        return !!(settings.pinHash && settings.pinSalt && settings.pinWrappedKey);
    }

    /**
     * Verifies a PIN and, if correct, recovers the real vault key by unwrapping
     * it with a PIN-derived key — this works from a cold start (no cached
     * session key needed), unlike the password unlock's session-key shortcut.
     */
    async unlockWithPIN(pin: string): Promise<boolean> {
        const settings = this.plugin.settings as PluginSettings;
        if (!settings.pinHash || !settings.pinSalt || !settings.pinWrappedKey) return false;

        const ok = await verifyPIN(pin, settings.pinSalt, settings.pinHash);
        if (!ok) return false;

        try {
            const pinKey = await deriveKey(pin, settings.pinSalt);
            const key = await unwrapKeyRaw(settings.pinWrappedKey, pinKey);
            const unlocked = await this.store.unlockWithKey(key);
            if (!unlocked) return false;

            this.sessionKey = key;
            this.resetAutoLock(settings.autoLockMinutes);
            return true;
        } catch {
            return false;
        }
    }

    // ── Lock ──────────────────────────────────────────────────────────────────

    lock(): void {
        this.sessionKey = null;
        this.store.lock();
        this.clearAutoLock();
    }

    // ── Auto-lock timer ───────────────────────────────────────────────────────

    resetAutoLock(minutes: number): void {
        this.clearAutoLock();
        if (minutes <= 0) return;
        this.autoLockTimer = setTimeout(() => {
            this.lock();
            this.onAutoLock?.();
        }, minutes * 60 * 1000);
    }

    private clearAutoLock(): void {
        if (this.autoLockTimer !== null) {
            clearTimeout(this.autoLockTimer);
            this.autoLockTimer = null;
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async readVaultMeta(): Promise<{ salt: string; verificationHash: string } | null> {
        try {
            const app = this.plugin.app;
            const file = app.vault.getAbstractFileByPath(normalizePath("login-vault.enc"));
            if (!(file instanceof TFile)) return null;
            const raw = await app.vault.read(file);
            const data = JSON.parse(raw);
            return { salt: data.salt, verificationHash: data.verificationHash };
        } catch {
            return null;
        }
    }
}
