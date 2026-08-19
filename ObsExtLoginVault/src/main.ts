import { normalizePath, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings } from "./types";
import { CredentialStore } from "./store";
import { AuthManager } from "./auth";
import { VAULT_VIEW_TYPE, VaultView } from "./ui/VaultView";
import { SettingsTab } from "./ui/SettingsTab";
import { SetupModal } from "./ui/SetupModal";
import { UnlockModal } from "./ui/UnlockModal";
import { PasswordGenModal } from "./ui/PasswordGenModal";

export default class LoginVaultPlugin extends Plugin {
    settings: PluginSettings = DEFAULT_SETTINGS;
    store: CredentialStore = null!;
    auth: AuthManager = null!;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.store = new CredentialStore(this.app);
        this.auth = new AuthManager(this, this.store);
        this.auth.onAutoLock = () => {
            new Notice("🔒 Login Vault auto-locked");
            this.refreshOpenViews();
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
                new Notice("🔒 Login Vault locked");
                this.refreshOpenViews();
            },
        });

        this.addCommand({
            id: "generate-password",
            name: "Generate Password",
            callback: () => {
                new PasswordGenModal(this.app, this.settings.passwordGenDefaults).open();
            },
        });

        // Settings tab
        this.addSettingTab(new SettingsTab(this.app, this));

        // Reset auto-lock timer on any user activity
        this.registerDomEvent(document, "keydown", () => {
            if (!this.auth.isLocked()) {
                this.auth.resetAutoLock(this.settings.autoLockMinutes);
            }
        });
        this.registerDomEvent(document, "click", () => {
            if (!this.auth.isLocked()) {
                this.auth.resetAutoLock(this.settings.autoLockMinutes);
            }
        });
    }

    onunload(): void {
        this.auth.lock();
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    // ── View management ───────────────────────────────────────────────────────

    async openVaultView(): Promise<void> {
        const { workspace } = this.app;

        // If vault is not set up (first run or after a reset), always show setup
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
    }

    // ── Vault reset ───────────────────────────────────────────────────────────

    /**
     * Destroys the vault completely:
     *   1. Locks the session (clears in-memory key)
     *   2. Deletes login-vault.enc from the vault
     *   3. Clears hasMasterPassword, pinHash, pinSalt from saved settings
     *   4. Closes open vault views
     *   5. Relaunches the first-run setup wizard
     */
    async resetVault(): Promise<void> {
        // 1. Lock immediately
        this.auth.lock();

        // 2. Delete the encrypted file
        const file = this.app.vault.getAbstractFileByPath(normalizePath("login-vault.enc"));
        if (file instanceof TFile) {
            await this.app.vault.delete(file);
        }

        // 3. Wipe auth-related settings
        this.settings.hasMasterPassword = false;
        delete this.settings.pinHash;
        delete this.settings.pinSalt;
        await this.saveData(this.settings);

        new Notice("🗑️ Vault has been reset");

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

    private showSetupModal(): Promise<void> {
        return new Promise((resolve) => {
            new SetupModal(this.app, this.auth, this.settings, async () => {
                resolve();
                await this.openVaultView();
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
