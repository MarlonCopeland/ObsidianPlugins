// ─────────────────────────────────────────────────────────────────────────────
// store.ts — Credential persistence layer
//
// Reads and writes login-vault.enc (encrypted JSON) in the vault root.
// Credentials are only held in plaintext while unlocked (in memory).
//
// Sync safety: every write is serialized through a queue and is
// read → decrypt → three-way merge → mutate → write, so a stale in-memory
// list can never overwrite changes another device made (see merge.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { App, normalizePath, TFile } from "obsidian";
import type { CredentialEntry, VaultData } from "./types";
import { decryptData, encryptData } from "./crypto";
import { merge, sameSnapshot, snapshot, Snapshot } from "./merge";

export const VAULT_FILE = "login-vault.enc";

const BACKUP_KEEP = 8;
const BACKUP_MIN_INTERVAL_MS = 2 * 60 * 1000;
const BACKUP_NAME = /^login-vault-(\d+)\.enc$/;

/** The vault was re-keyed (master password changed) on another device. */
export class VaultKeyChangedError extends Error {
    constructor() {
        super("The master password was changed on another device. Unlock again with the new password.");
        this.name = "VaultKeyChangedError";
    }
}

/** The vault file is unreadable or failed authentication. */
export class VaultCorruptError extends Error {
    constructor(message = "The vault file is unreadable or damaged.") {
        super(message);
        this.name = "VaultCorruptError";
    }
}

export type VaultFileState = "ok" | "missing" | "corrupt";

export type InvalidationReason = "key-changed" | "corrupt";

/** Validates and normalizes an untrusted entry (from disk or an import). */
export function sanitizeEntry(raw: unknown, now = 0): CredentialEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : now);
    const id = str(e.id);
    if (!id) return null;
    const entry: CredentialEntry = {
        id,
        title: str(e.title),
        username: str(e.username),
        password: str(e.password),
        createdAt: num(e.createdAt),
        updatedAt: num(e.updatedAt),
    };
    if (typeof e.url === "string" && e.url) entry.url = e.url;
    if (typeof e.notes === "string" && e.notes) entry.notes = e.notes;
    if (Array.isArray(e.tags)) {
        const tags = e.tags.filter((t): t is string => typeof t === "string");
        if (tags.length) entry.tags = tags;
    }
    return entry;
}

function parseEntries(plaintext: string): CredentialEntry[] {
    const parsed: unknown = JSON.parse(plaintext);
    if (!Array.isArray(parsed)) throw new VaultCorruptError();
    return parsed.map((p) => sanitizeEntry(p)).filter((e): e is CredentialEntry => e !== null);
}

/** Prefix cells that spreadsheets would execute as formulas. */
function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
    return `"${safe.replace(/"/g, '""')}"`;
}

export class CredentialStore {
    private app: App;
    private backupDir: string;
    private credentials: CredentialEntry[] = [];
    private base: Snapshot = new Map();
    private unlocked = false;
    private header: { version: number; salt: string } | null = null;
    private lastWrittenRaw: string | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    /** Fired when the on-disk vault can no longer be used with the current session key. */
    onInvalidated: ((reason: InvalidationReason) => void) | null = null;
    /** Fired when the vault file was missing (e.g. removed by a sync) and is being re-created. */
    onFileRecreated: (() => void) | null = null;

    constructor(app: App, backupDir: string) {
        this.app = app;
        this.backupDir = normalizePath(backupDir);
    }

    // ── State ────────────────────────────────────────────────────────────────

    isUnlocked(): boolean {
        return this.unlocked;
    }

    async isInitialized(): Promise<boolean> {
        return this.getFile() !== null;
    }

    /** Classifies the vault file without needing any key. */
    async readState(): Promise<{ state: VaultFileState; data?: VaultData }> {
        const raw = await this.readRaw();
        if (raw === null) return { state: "missing" };
        const data = this.parse(raw);
        return data ? { state: "ok", data } : { state: "corrupt" };
    }

    async getSalt(): Promise<string | null> {
        const { data } = await this.readState();
        return data ? data.salt : null;
    }

    // ── Initialization (first run) ────────────────────────────────────────────

    /**
     * Creates a new encrypted vault file with an empty credential list.
     * Refuses to overwrite an existing file: on a second device the real vault
     * may simply not have synced yet, and replacing it would destroy it.
     */
    async initialize(key: CryptoKey, salt: string): Promise<void> {
        if (await this.isInitialized()) {
            throw new Error("A vault file already exists. Unlock it instead of creating a new one.");
        }
        const { iv, ciphertext } = await encryptData(key, JSON.stringify([]));
        const data: VaultData = { version: 1, salt, iv, ciphertext };
        await this.writeVault(data);
        this.header = { version: 1, salt };
        this.credentials = [];
        this.base = new Map();
        this.unlocked = true;
    }

    // ── Unlock ────────────────────────────────────────────────────────────────

    /**
     * Unlocks with an already-derived key. There is no stored password check:
     * decryption is the check — a wrong key fails the AES-GCM auth tag.
     */
    async unlockWithKey(key: CryptoKey): Promise<boolean> {
        const result = await this.enqueue(async () => {
            const raw = await this.readRaw();
            const data = raw === null ? null : this.parse(raw);
            if (!data) return null;
            let entries: CredentialEntry[];
            try {
                entries = parseEntries(await decryptData(key, data.iv, data.ciphertext));
            } catch {
                return null;
            }
            this.header = { version: data.version, salt: data.salt };
            this.credentials = entries;
            this.base = snapshot(entries);
            this.unlocked = true;
            return { legacy: data.verificationHash !== undefined };
        });
        if (!result) return false;

        // v1.0/1.1 files carry a fast SHA-256 of the password that allows
        // offline guessing without paying the PBKDF2 cost. Rewriting the file
        // drops it.
        if (result.legacy) {
            this.commit(key, () => undefined).catch((e) =>
                console.warn("LoginVault: could not strip legacy verification hash", e)
            );
        }
        return true;
    }

    /** True if `key` decrypts the vault currently on disk (used to re-check the current password). */
    async verifyKey(key: CryptoKey): Promise<boolean> {
        const raw = await this.readRaw();
        const data = raw === null ? null : this.parse(raw);
        if (!data) return false;
        try {
            await decryptData(key, data.iv, data.ciphertext);
            return true;
        } catch {
            return false;
        }
    }

    // ── Lock ──────────────────────────────────────────────────────────────────

    lock(): void {
        this.credentials = [];
        this.base = new Map();
        this.header = null;
        this.unlocked = false;
    }

    // ── CRUD ─────────────────────────────────────────────────────────────────

    getAllCredentials(): CredentialEntry[] {
        this.assertUnlocked();
        return [...this.credentials];
    }

    getCredentialById(id: string): CredentialEntry | undefined {
        this.assertUnlocked();
        return this.credentials.find((c) => c.id === id);
    }

    async addCredential(
        entry: Omit<CredentialEntry, "id" | "createdAt" | "updatedAt">,
        key: CryptoKey
    ): Promise<CredentialEntry> {
        return this.commit(key, (list) => {
            const now = Date.now();
            const created: CredentialEntry = { ...entry, id: this.generateId(), createdAt: now, updatedAt: now };
            list.push(created);
            return created;
        });
    }

    async updateCredential(
        id: string,
        changes: Partial<Omit<CredentialEntry, "id" | "createdAt">>,
        key: CryptoKey
    ): Promise<CredentialEntry | null> {
        return this.commit(key, (list) => {
            const idx = list.findIndex((c) => c.id === id);
            if (idx === -1) return null;
            list[idx] = { ...list[idx], ...changes, updatedAt: Date.now() };
            return list[idx];
        });
    }

    async deleteCredential(id: string, key: CryptoKey): Promise<boolean> {
        return this.commit(key, (list) => {
            const idx = list.findIndex((c) => c.id === id);
            if (idx === -1) return false;
            list.splice(idx, 1);
            return true;
        });
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    /** Re-encrypts and writes the current state (merged with whatever is on disk). */
    async save(key: CryptoKey): Promise<void> {
        await this.commit(key, () => undefined);
    }

    /**
     * Re-keys the vault: merges with disk using the current key, then writes
     * everything under the new key and salt.
     */
    async changeMasterPassword(currentKey: CryptoKey, newKey: CryptoKey, newSalt: string): Promise<void> {
        await this.commit(currentKey, () => undefined, { newKey, newSalt });
    }

    /** Has the file changed since we last wrote it? Used to ignore our own modify events. */
    async hasExternalChange(): Promise<boolean> {
        const raw = await this.readRaw();
        return raw !== this.lastWrittenRaw;
    }

    /**
     * Merges the on-disk vault into memory (after another device changed it).
     * Returns true if the in-memory list changed.
     */
    async syncFromDisk(key: CryptoKey): Promise<boolean> {
        return this.enqueue(async () => {
            if (!this.unlocked) return false;
            const remote = await this.loadRemote(key);
            if (remote === null) return false; // file removed: keep memory, re-create on next change
            const merged = merge(this.base, this.credentials, remote);
            const changed = !sameSnapshot(snapshot(merged), snapshot(this.credentials));
            this.credentials = merged;
            if (sameSnapshot(snapshot(merged), snapshot(remote))) {
                this.base = snapshot(merged);
            } else {
                // We hold changes the disk copy lacks (e.g. an entry created here): publish them.
                await this.persist(key);
            }
            return changed;
        });
    }

    // ── Export / Import ───────────────────────────────────────────────────────

    exportJSON(): string {
        this.assertUnlocked();
        return JSON.stringify(this.credentials, null, 2);
    }

    exportCSV(): string {
        this.assertUnlocked();
        const header = "title,username,password,url,notes,tags";
        const rows = this.credentials.map((c) => {
            const tags = (c.tags ?? []).join("|");
            return [c.title, c.username, c.password, c.url ?? "", c.notes ?? "", tags]
                .map((v) => csvCell(String(v)))
                .join(",");
        });
        return [header, ...rows].join("\n");
    }

    async importJSON(json: string, key: CryptoKey): Promise<{ added: number; skipped: number }> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch {
            throw new Error("Invalid JSON file");
        }
        if (!Array.isArray(parsed)) throw new Error("Invalid file: expected a list of credentials");

        const now = Date.now();
        const incoming: CredentialEntry[] = [];
        let rejected = 0;
        for (const raw of parsed) {
            const withId =
                raw && typeof raw === "object" && !(raw as Record<string, unknown>).id
                    ? { ...(raw as object), id: this.generateId() }
                    : raw;
            const entry = sanitizeEntry(withId, now);
            if (entry && entry.title && entry.password) incoming.push(entry);
            else rejected++;
        }

        return this.commit(key, (list) => {
            let added = 0;
            let skipped = rejected;
            for (const entry of incoming) {
                const idx = list.findIndex((c) => c.id === entry.id);
                if (idx === -1) {
                    list.push(entry);
                    added++;
                } else if (entry.updatedAt > list[idx].updatedAt) {
                    list[idx] = entry;
                    added++;
                } else {
                    skipped++;
                }
            }
            return { added, skipped };
        });
    }

    // ── Backups ───────────────────────────────────────────────────────────────

    /** Encrypted snapshots of the vault file, newest first. Stored in the plugin folder (device-local). */
    async listBackups(): Promise<string[]> {
        try {
            const adapter = this.app.vault.adapter;
            if (!(await adapter.exists(this.backupDir))) return [];
            const listing = await adapter.list(this.backupDir);
            return listing.files
                .filter((f) => BACKUP_NAME.test(f.split("/").pop() ?? ""))
                .sort((a, b) => this.backupTime(b) - this.backupTime(a));
        } catch {
            return [];
        }
    }

    /** Copies the current vault file into the backups folder regardless of the usual throttle. */
    async backupNow(): Promise<void> {
        const raw = await this.readRaw();
        if (raw !== null) await this.writeBackup(raw, true);
    }

    /** Replaces the vault file with the newest readable backup. Returns false if there is none. */
    async restoreLatestBackup(): Promise<boolean> {
        for (const path of await this.listBackups()) {
            try {
                const raw = await this.app.vault.adapter.read(path);
                if (!this.parse(raw)) continue;
                this.lastWrittenRaw = raw;
                const file = this.getFile();
                if (file) await this.app.vault.modify(file, raw);
                else await this.app.vault.create(normalizePath(VAULT_FILE), raw);
                return true;
            } catch {
                // try the next one
            }
        }
        return false;
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn);
        this.queue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    /** read disk → merge → mutate → write, serialized with every other write. */
    private commit<T>(
        key: CryptoKey,
        mutate: (list: CredentialEntry[]) => T,
        rekey?: { newKey: CryptoKey; newSalt: string }
    ): Promise<T> {
        return this.enqueue(async () => {
            this.assertUnlocked();
            const remote = await this.loadRemote(key);
            if (remote !== null) this.credentials = merge(this.base, this.credentials, remote);
            const result = mutate(this.credentials);
            await this.persist(key, rekey, remote === null);
            return result;
        });
    }

    /** Reads and decrypts the file on disk. Returns null if the file is missing. */
    private async loadRemote(key: CryptoKey): Promise<CredentialEntry[] | null> {
        const raw = await this.readRaw();
        if (raw === null) return null;
        const data = this.parse(raw);
        if (!data) return this.invalidate("corrupt", new VaultCorruptError());
        if (this.header && data.salt !== this.header.salt) {
            return this.invalidate("key-changed", new VaultKeyChangedError());
        }
        try {
            return parseEntries(await decryptData(key, data.iv, data.ciphertext));
        } catch (e) {
            if (e instanceof VaultCorruptError) return this.invalidate("corrupt", e);
            return this.invalidate("corrupt", new VaultCorruptError("The vault file failed authentication."));
        }
    }

    private invalidate(reason: InvalidationReason, error: Error): never {
        this.onInvalidated?.(reason);
        throw error;
    }

    private async persist(
        key: CryptoKey,
        rekey?: { newKey: CryptoKey; newSalt: string },
        recreated = false
    ): Promise<void> {
        const salt = rekey?.newSalt ?? this.header?.salt;
        if (!salt) throw new VaultCorruptError("The vault header is not loaded.");
        const { iv, ciphertext } = await encryptData(rekey?.newKey ?? key, JSON.stringify(this.credentials));
        const data: VaultData = { version: this.header?.version ?? 1, salt, iv, ciphertext };
        if (recreated) this.onFileRecreated?.();
        await this.writeVault(data);
        this.header = { version: data.version, salt };
        this.base = snapshot(this.credentials);
    }

    private getFile(): TFile | null {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(VAULT_FILE));
        return file instanceof TFile ? file : null;
    }

    private async readRaw(): Promise<string | null> {
        const file = this.getFile();
        return file ? this.app.vault.read(file) : null;
    }

    private parse(raw: string): VaultData | null {
        try {
            const d = JSON.parse(raw);
            if (
                d &&
                typeof d.salt === "string" &&
                typeof d.iv === "string" &&
                typeof d.ciphertext === "string"
            ) {
                return {
                    version: typeof d.version === "number" ? d.version : 1,
                    salt: d.salt,
                    iv: d.iv,
                    ciphertext: d.ciphertext,
                    verificationHash: typeof d.verificationHash === "string" ? d.verificationHash : undefined,
                };
            }
            return null;
        } catch {
            return null;
        }
    }

    private async writeVault(data: VaultData): Promise<void> {
        const json = JSON.stringify(
            { version: data.version, salt: data.salt, iv: data.iv, ciphertext: data.ciphertext },
            null,
            2
        );
        const path = normalizePath(VAULT_FILE);
        const file = this.getFile();

        if (!file) {
            this.lastWrittenRaw = json;
            await this.app.vault.create(path, json);
            return;
        }

        const previous = await this.app.vault.read(file);
        await this.writeBackup(previous, false);
        this.lastWrittenRaw = json;
        await this.app.vault.modify(file, json);

        // Read back: if the file is unreadable, put the previous version back
        // rather than leaving a corrupt vault for every synced device.
        const check = await this.app.vault.read(file);
        if (check !== json && !this.parse(check)) {
            this.lastWrittenRaw = previous;
            await this.app.vault.modify(file, previous);
            throw new VaultCorruptError("The vault file was damaged while saving. The previous version was restored.");
        }
    }

    private backupTime(path: string): number {
        const m = BACKUP_NAME.exec(path.split("/").pop() ?? "");
        return m ? parseInt(m[1], 10) : 0;
    }

    private async writeBackup(raw: string, force: boolean): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            if (!this.parse(raw)) return; // never keep a corrupt file as a "backup"
            if (!(await adapter.exists(this.backupDir))) await adapter.mkdir(this.backupDir);

            const existing = await this.listBackups();
            if (existing.length > 0) {
                const newest = existing[0];
                if (!force && Date.now() - this.backupTime(newest) < BACKUP_MIN_INTERVAL_MS) return;
                if ((await adapter.read(newest)) === raw) return;
            }
            await adapter.write(`${this.backupDir}/login-vault-${Date.now()}.enc`, raw);
            for (const old of existing.slice(BACKUP_KEEP - 1)) await adapter.remove(old);
        } catch (e) {
            console.warn("LoginVault: backup failed", e);
        }
    }

    private assertUnlocked(): void {
        if (!this.unlocked) throw new Error("Vault is locked");
    }

    private generateId(): string {
        const arr = new Uint8Array(16);
        window.crypto.getRandomValues(arr);
        return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
    }
}
