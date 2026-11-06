// ─────────────────────────────────────────────────────────────────────────────
// device-store.ts — Per-device, per-vault key/value storage that is NOT synced
//
// Plugin data.json is synced between devices (and through Obsidian's servers),
// so anything that only makes sense on one device — or that must never leave
// it, like quick-unlock key material — goes here instead.
//
// Uses app.saveLocalStorage (Obsidian ≥ 1.8.7, vault-scoped) and falls back to
// window.localStorage with a vault-name prefix on older versions.
// ─────────────────────────────────────────────────────────────────────────────

import type { App } from "obsidian";

type LocalStorageApp = App & {
    saveLocalStorage?: (key: string, data: unknown | null) => void;
    loadLocalStorage?: (key: string) => unknown;
};

export class DeviceStore {
    private app: LocalStorageApp;

    constructor(app: App) {
        this.app = app as LocalStorageApp;
    }

    get<T>(key: string): T | null {
        try {
            if (typeof this.app.loadLocalStorage === "function") {
                const v = this.app.loadLocalStorage(`login-vault:${key}`);
                return (v ?? null) as T | null;
            }
            const raw = window.localStorage.getItem(this.fallbackKey(key));
            return raw === null ? null : (JSON.parse(raw) as T);
        } catch {
            return null;
        }
    }

    set(key: string, value: unknown | null): void {
        try {
            if (typeof this.app.saveLocalStorage === "function") {
                this.app.saveLocalStorage(`login-vault:${key}`, value);
                return;
            }
            if (value === null) window.localStorage.removeItem(this.fallbackKey(key));
            else window.localStorage.setItem(this.fallbackKey(key), JSON.stringify(value));
        } catch (e) {
            console.warn("LoginVault: could not write device-local storage", e);
        }
    }

    private fallbackKey(key: string): string {
        return `login-vault:${this.app.vault.getName()}:${key}`;
    }
}
