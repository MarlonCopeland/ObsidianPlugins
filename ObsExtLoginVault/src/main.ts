import { normalizePath, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings } from "./types";
import { CredentialStore, VAULT_FILE } from "./store";
import { AuthManager } from "./auth";
import { DeviceStore } from "./device-store";
import { VAULT_VIEW_TYPE, VaultView } from "./ui/VaultView";
import { SettingsTab } from "./ui/SettingsTab";
import { SetupModal } from "./ui/SetupModal";
import { UnlockModal } from "./ui/UnlockModal";
import { PasswordGenModal } from "./ui/PasswordGenModal";
import { flushPendingClipboardClear, SecretModal } from "./ui/components";

/** Delay before reacting to a change of the vault file, so bursts of sync writes collapse into one reload. */
const EXTERNAL_CHANGE_DEBOUNCE_MS = 500;

export default class LoginVaultPlugin extends Plugin {
    settings: PluginSettings = { ...DEFAULT_SETTINGS };
    store: CredentialStore = null!;
    auth: AuthManager = null!;
    device: DeviceStore = null!;

    private syncTimer: ReturnType<typeof setTimeout> | null = null;
    private legacyPinRemoved = false;

    async onload(): Promise<void> {
        await this.loadSettings();

        const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        this.device = new DeviceStore(this.app);
        this.store = new CredentialStore(this.app, `${pluginDir}/backups`);
        this.auth = new AuthManager(this, this.store, this.device);

        this.auth.onAutoLock = () => {
            new Notice("Login Vault auto-locked");
        };

        // One place reacts to every lock, however it happened: close any modal
        // that shows secrets, clear a copied secret, and re-render the views.
        this.auth.onLock(() => {
            SecretModal.closeAll();
            flushPendingClipboardClear();
            this.refreshOpenViews();
        });

        this.store.onInvalidated = (reason) => {
            this.auth.lock();
            new Notice(
                reason === "key-changed"
                    ? "Login Vault: the master password was changed on another device. Unlock again with the new password."
                    : "Login Vault: the vault file is damaged or unreadable, so it was locked to protect it. Use \"Restore latest backup\" on the unlock screen.",
                10000
            );
        };
        this.store.onFileRecreated = () => {
            new Notice("Login Vault: the vault file was missing (removed by sync?) and has been re-created from this device.", 8000);
        };

        // Register the main vault view
        this.registerView(VAULT_VIEW_TYPE, (leaf) => new VaultView(leaf, this));

        // Ribbon icon
        this.addRibbonIcon("shield", "Login Vault", async () => {
            await this.openVaultView();
        });

        // Commands
        this.addCommand({
            id: "open-login-vault",
            name: "Open Login Vault",
            callback: async () => { await this.openVaultView(); },
        });

        this.addCommand({
            id: "lock-login-vault",
            name: "Lock Login Vault",
            callback: () => {
                this.auth.lock();
                new Notice("Login Vault locked");
            },
        });

        this.addCommand({
            id: "generate-password",
            name: "Generate Password",
            callback: () => {
                new PasswordGenModal(this.app, this.settings.passwordGenDefaults, undefined, this.settings.clipboardClearSeconds).open();
            },
        });

        // Settings tab
        this.addSettingTab(new SettingsTab(this.app, this));

        // User activity keeps the session alive. Pointer, touch and scroll count
        // (not just keys/clicks), so reading on a phone doesn't lock mid-use.
        const activity = () => this.auth.noteActivity();
        const opts = { capture: true, passive: true } as const;
        this.registerDomEvent(document, "keydown", activity, opts);
        this.registerDomEvent(document, "pointerdown", activity, opts);
        this.registerDomEvent(document, "touchstart", activity, opts);
        this.registerDomEvent(document, "wheel", activity, opts);

        // Timers don't run while a mobile app is suspended, so check the
        // deadline against the clock whenever the app comes back.
        this.registerDomEvent(document, "visibilitychange", () => {
            if (!document.hidden) this.auth.checkDeadline();
        });
        this.registerDomEvent(window, "focus", () => this.auth.checkDeadline());

        // Pick up changes made by another device (Obsidian Sync etc.)
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (file.path === normalizePath(VAULT_FILE)) this.scheduleExternalSync();
            })
        );

        if (this.legacyPinRemoved) {
            this.app.workspace.onLayoutReady(() => {
                new Notice(
                    "Login Vault: your old PIN was removed for security. Set a new one (6+ digits) in the plugin settings.",
                    12000
                );
            });
        }
    }

    onunload(): void {
        if (this.syncTimer !== null) clearTimeout(this.syncTimer);
        this.auth.lock();
    }

    async loadSettings(): Promise<void> {
        const saved = ((await this.loadData()) ?? {}) as Record<string, unknown>;

        // Versions ≤ 1.1.0 kept PIN material in data.json, which syncs to other
        // devices and Obsidian's servers, and which a short PIN cannot protect.
        // Drop it; the PIN is now device-local and must be set again.
        for (const legacy of ["pinHash", "pinSalt", "pinWrappedKey"]) {
            if (legacy in saved) {
                delete saved[legacy];
                this.legacyPinRemoved = true;
            }
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved) as PluginSettings;
        this.settings.passwordGenDefaults = {
            ...DEFAULT_SETTINGS.passwordGenDefaults,
            ...(saved.passwordGenDefaults as object | undefined),
        };
        if (this.legacyPinRemoved) await this.saveData(this.settings);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    // ── External changes (sync) ───────────────────────────────────────────────

    private scheduleExternalSync(): void {
        if (this.syncTimer !== null) clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            void this.syncExternalChange();
        }, EXTERNAL_CHANGE_DEBOUNCE_MS);
    }

    private async syncExternalChange(): Promise<void> {
        if (!this.store.isUnlocked()) return;
        const key = this.auth.getSessionKey();
        if (!key) return;
        try {
            if (!(await this.store.hasExternalChange())) return; // our own write
            const changed = await this.store.syncFromDisk(key);
            if (changed) {
                this.refreshOpenViews();
                new Notice("Login Vault updated from another device");
            }
        } catch (e) {
            // VaultKeyChanged / VaultCorrupt already locked the vault via onInvalidated.
            console.warn("LoginVault: could not apply external change", e);
        }
    }

    // ── View management ───────────────────────────────────────────────────────

    async openVaultView(): Promise<void> {
        const { workspace } = this.app;

        // If vault is not set up (first run or after a reset), show setup
        const initialized = await this.store.isInitialized();
        if (!initialized) {
            // Close any stale vault view leaves first
            this.closeAllVaultLeaves();
            await this.showSetupModal();
            return;
        }

        // If view is already open, reveal and unlock if needed
        const existing = workspace.getLeavesOfType(VAULT_VIEW_TYPE);
        if (existing.length > 0) {
            workspace.revealLeaf(existing[0]);
            if (this.auth.isLocked()) {
                await this.showUnlockModal();
                this.refreshOpenViews();
            }
            return;
        }

        // Open a new leaf on the right sidebar
        let leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false);
        if (!leaf) leaf = workspace.getLeaf("tab");
        await leaf.setViewState({ type: VAULT_VIEW_TYPE, active: true });
        workspace.revealLeaf(leaf);

        // Ask for the password because the user just asked to open the vault.
        // (A view restored at startup does not prompt — it shows a locked screen.)
        if (this.auth.isLocked()) {
            await this.showUnlockModal();
            this.refreshOpenViews();
        }
    }

    // ── Vault reset ───────────────────────────────────────────────────────────

    /**
     * Resets the vault:
     *   1. Locks the session (clears in-memory key)
     *   2. Keeps an encrypted backup, then moves login-vault.enc to the trash
     *      (not a permanent delete — the removal syncs to every device, so a
     *      mistaken reset must be recoverable)
     *   3. Clears device-local PIN and the "has a vault" flag
     *   4. Closes open vault views
     *   5. Relaunches the first-run setup wizard
     */
    async resetVault(): Promise<void> {
        // 1. Lock immediately
        this.auth.lock();

        // 2. Back up, then trash the encrypted file
        await this.store.backupNow();
        const file = this.app.vault.getAbstractFileByPath(normalizePath(VAULT_FILE));
        if (file instanceof TFile) {
            await this.app.fileManager.trashFile(file);
        }

        // 3. Wipe auth-related state
        this.auth.removePIN();
        this.settings.hasMasterPassword = false;
        await this.saveData(this.settings);

        new Notice("Vault has been reset");

        // 4. Close open vault views
        this.closeAllVaultLeaves();

        // 5. Relaunch setup wizard
        await this.showSetupModal();
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    async showUnlockModal(): Promise<void> {
        return new Promise((resolve) => {
            new UnlockModal(this.app, this.auth, this.settings, () => resolve(), () => this.resetVault(), this).open();
        });
    }

    private async showSetupModal(): Promise<void> {
        const hasBackup = (await this.store.listBackups()).length > 0;
        return new Promise((resolve) => {
            new SetupModal(this.app, this.auth, this.settings, {
                vaultExists: () => this.store.isInitialized(),
                hadVaultBefore: this.settings.hasMasterPassword,
                hasBackup,
                restoreBackup: () => this.store.restoreLatestBackup(),
                onComplete: async () => {
                    resolve();
                    await this.openVaultView();
                },
                onDismiss: () => resolve(),
            }).open();
        });
    }

    refreshOpenViews(): void {
        this.app.workspace.getLeavesOfType(VAULT_VIEW_TYPE).forEach((leaf) => {
            if (leaf.view instanceof VaultView) {
                leaf.view.render();
            }
        });
    }

    private closeAllVaultLeaves(): void {
        this.app.workspace.getLeavesOfType(VAULT_VIEW_TYPE).forEach((leaf) => leaf.detach());
    }
}
