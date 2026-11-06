// ─────────────────────────────────────────────────────────────────────────────
// auth.ts — Session manager: master password, quick-unlock PIN, auto-lock
// ─────────────────────────────────────────────────────────────────────────────

import type { App } from "obsidian";
import type { PluginSettings } from "./types";
import { deriveKey, generateSalt, unwrapKeyRaw, wrapKeyRaw } from "./crypto";
import type { EncryptedPayload } from "./crypto";
import type { CredentialStore } from "./store";
import type { DeviceStore } from "./device-store";

/** Minimal interface the AuthManager needs from the Plugin host — avoids circular imports */
interface PluginHost {
    settings: PluginSettings;
    app: App;
    saveData(data: unknown): Promise<void>;
}

export type UnlockMethod = "password" | "pin";

/** Why the last unlock attempt failed — lets the UI say something more useful than "incorrect". */
export type UnlockFailure =
    | "wrong-password"
    | "wrong-pin"
    | "corrupt"
    | "missing"
    | "pin-disabled"   // too many wrong PINs, or no PIN set
    | "pin-stale";     // the master password changed since this PIN was set

export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 12;
export const PIN_MAX_ATTEMPTS = 5;

/**
 * Device-local quick-unlock slot. It never touches data.json (which syncs).
 *
 * Be honest about what this protects: the slot holds the vault key wrapped
 * with a key derived from the PIN, so anyone who can copy this device's
 * files can brute-force a numeric PIN offline. The attempt counter only
 * stops someone using the plugin UI. A strong master password remains the
 * real protection.
 */
interface QuickUnlockSlot {
    salt: string;           // PBKDF2 salt for the PIN-derived wrapping key
    vaultSalt: string;      // salt of the vault the key belongs to (detects a changed password)
    wrapped: EncryptedPayload;
    failures: number;
}

const SLOT_KEY = "quick-unlock";

export class AuthManager {
    private sessionKey: CryptoKey | null = null;
    private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
    private lockDeadline: number | null = null;
    private lastActivity = 0;
    private lockListeners = new Set<() => void>();
    private plugin: PluginHost;
    private store: CredentialStore;
    private device: DeviceStore;

    /** Set after a failed unlock/setup attempt. */
    lastFailure: UnlockFailure | null = null;

    /** Invoked when the auto-lock fires (not on manual lock() calls). */
    onAutoLock: (() => void) | null = null;

    constructor(plugin: PluginHost, store: CredentialStore, device: DeviceStore) {
        this.plugin = plugin;
        this.store = store;
        this.device = device;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    isLocked(): boolean {
        this.checkDeadline();
        return this.sessionKey === null;
    }

    getSessionKey(): CryptoKey | null {
        this.checkDeadline();
        return this.sessionKey;
    }

    /** Subscribe to every lock (manual, timer, vault invalidated). Returns an unsubscribe function. */
    onLock(listener: () => void): () => void {
        this.lockListeners.add(listener);
        return () => this.lockListeners.delete(listener);
    }

    // ── Master password unlock ────────────────────────────────────────────────

    /**
     * Derives a key from the password and tries to decrypt the vault with it.
     * A wrong password simply fails the AES-GCM authentication tag — there is
     * deliberately no stored password hash to test guesses against.
     */
    async unlock(password: string): Promise<boolean> {
        this.lastFailure = null;
        const { state, data } = await this.store.readState();
        if (state !== "ok" || !data) {
            this.lastFailure = state === "missing" ? "missing" : "corrupt";
            return false;
        }

        const key = await deriveKey(password, data.salt);
        const unlocked = await this.store.unlockWithKey(key);
        if (!unlocked) {
            this.lastFailure = "wrong-password";
            return false;
        }

        this.sessionKey = key;
        this.resetAutoLock(this.plugin.settings.autoLockMinutes);
        return true;
    }

    // ── Setup (first run) ─────────────────────────────────────────────────────

    /**
     * Derives a key from a new master password and creates the vault.
     * Throws (with a user-presentable message) if a vault file already exists.
     */
    async setupMasterPassword(password: string): Promise<void> {
        // Generate salt HERE so the same salt is used for both
        // key derivation and the vault file header
        const salt = generateSalt();
        const key = await deriveKey(password, salt);

        await this.store.initialize(key, salt);

        this.sessionKey = key;
        this.resetAutoLock(this.plugin.settings.autoLockMinutes);
        const settings = this.plugin.settings;
        settings.hasMasterPassword = true;
        await this.plugin.saveData(settings);
    }

    /**
     * Change the master password. Vault must be unlocked, and the caller must
     * supply the *current* password so it can be verified before proceeding —
     * being "unlocked" only proves someone unlocked the vault at some point,
     * not that whoever is at the keyboard right now knows the password.
     *
     * The device's PIN is invalidated (it wraps the old key); the caller
     * should prompt the user to set a new one.
     */
    async changeMasterPassword(currentPassword: string, newPassword: string): Promise<boolean> {
        if (this.isLocked()) return false;
        try {
            const salt = await this.store.getSalt();
            if (!salt) return false;
            const currentKey = await deriveKey(currentPassword, salt);
            if (!(await this.store.verifyKey(currentKey))) return false;

            // Generate the new salt here so key and vault header use the same one
            const newSalt = generateSalt();
            const newKey = await deriveKey(newPassword, newSalt);
            await this.store.changeMasterPassword(currentKey, newKey, newSalt);
            this.sessionKey = newKey;
            this.device.set(SLOT_KEY, null);
            return true;
        } catch (e) {
            console.error("LoginVault: changeMasterPassword failed", e);
            return false;
        }
    }

    // ── PIN (device-local quick unlock) ───────────────────────────────────────

    static isValidPin(pin: string): boolean {
        return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
    }

    /**
     * Sets up (or replaces) this device's PIN. Requires an active session
     * because the real vault key is wrapped with a PIN-derived key.
     */
    async setupPIN(pin: string): Promise<void> {
        if (!AuthManager.isValidPin(pin)) {
            throw new Error(`PIN must be ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits`);
        }
        const key = this.getSessionKey();
        if (!key) throw new Error("Vault must be unlocked to set up a PIN");
        const vaultSalt = await this.store.getSalt();
        if (!vaultSalt) throw new Error("Vault file not found");

        const salt = generateSalt();
        const pinKey = await deriveKey(pin, salt);
        const wrapped = await wrapKeyRaw(key, pinKey);
        const slot: QuickUnlockSlot = { salt, vaultSalt, wrapped, failures: 0 };
        this.device.set(SLOT_KEY, slot);
    }

    removePIN(): void {
        this.device.set(SLOT_KEY, null);
    }

    hasPIN(): boolean {
        return this.device.get<QuickUnlockSlot>(SLOT_KEY) !== null;
    }

    pinAttemptsLeft(): number {
        const slot = this.device.get<QuickUnlockSlot>(SLOT_KEY);
        return slot ? Math.max(0, PIN_MAX_ATTEMPTS - slot.failures) : 0;
    }

    /**
     * Recovers the vault key by unwrapping it with the PIN-derived key. A wrong
     * PIN fails the AES-GCM tag. After PIN_MAX_ATTEMPTS wrong tries the slot is
     * erased and the master password is required again.
     */
    async unlockWithPIN(pin: string): Promise<boolean> {
        this.lastFailure = null;
        const slot = this.device.get<QuickUnlockSlot>(SLOT_KEY);
        if (!slot) {
            this.lastFailure = "pin-disabled";
            return false;
        }

        const vaultSalt = await this.store.getSalt();
        if (vaultSalt === null) {
            this.lastFailure = "missing";
            return false;
        }
        if (vaultSalt !== slot.vaultSalt) {
            this.device.set(SLOT_KEY, null);
            this.lastFailure = "pin-stale";
            return false;
        }

        let key: CryptoKey;
        try {
            const pinKey = await deriveKey(pin, slot.salt);
            key = await unwrapKeyRaw(slot.wrapped, pinKey);
        } catch {
            slot.failures += 1;
            if (slot.failures >= PIN_MAX_ATTEMPTS) {
                this.device.set(SLOT_KEY, null);
                this.lastFailure = "pin-disabled";
            } else {
                this.device.set(SLOT_KEY, slot);
                this.lastFailure = "wrong-pin";
            }
            return false;
        }

        const unlocked = await this.store.unlockWithKey(key);
        if (!unlocked) {
            const { state } = await this.store.readState();
            if (state === "corrupt") {
                this.lastFailure = "corrupt";
            } else {
                this.device.set(SLOT_KEY, null);
                this.lastFailure = "pin-stale";
            }
            return false;
        }

        if (slot.failures > 0) {
            slot.failures = 0;
            this.device.set(SLOT_KEY, slot);
        }
        this.sessionKey = key;
        this.resetAutoLock(this.plugin.settings.autoLockMinutes);
        return true;
    }

    // ── Lock ──────────────────────────────────────────────────────────────────

    lock(): void {
        const wasUnlocked = this.sessionKey !== null || this.store.isUnlocked();
        this.sessionKey = null;
        this.store.lock();
        this.clearAutoLock();
        if (wasUnlocked) {
            for (const listener of [...this.lockListeners]) {
                try {
                    listener();
                } catch (e) {
                    console.error("LoginVault: lock listener failed", e);
                }
            }
        }
    }

    // ── Auto-lock ─────────────────────────────────────────────────────────────

    /**
     * The timer is only a convenience: mobile OSes suspend timers while the
     * app is in the background. The real check is the stored deadline, which
     * is compared against the clock every time the session key is requested
     * and whenever the app returns to the foreground.
     */
    resetAutoLock(minutes: number): void {
        this.clearAutoLock();
        if (minutes <= 0 || this.sessionKey === null) return;
        const ms = minutes * 60 * 1000;
        this.lockDeadline = Date.now() + ms;
        this.autoLockTimer = setTimeout(() => this.checkDeadline(), ms + 50);
    }

    /** Call on user activity. Extends the session — unless it has already expired. */
    noteActivity(): void {
        if (this.sessionKey === null) return;
        if (this.checkDeadline()) return;
        const now = Date.now();
        if (now - this.lastActivity < 1000) return;
        this.lastActivity = now;
        this.resetAutoLock(this.plugin.settings.autoLockMinutes);
    }

    /** Locks if the deadline has passed. Returns true if it did. */
    checkDeadline(): boolean {
        if (this.sessionKey === null || this.lockDeadline === null) return false;
        if (Date.now() < this.lockDeadline) return false;
        this.lock();
        this.onAutoLock?.();
        return true;
    }

    private clearAutoLock(): void {
        if (this.autoLockTimer !== null) {
            clearTimeout(this.autoLockTimer);
            this.autoLockTimer = null;
        }
        this.lockDeadline = null;
    }
}
