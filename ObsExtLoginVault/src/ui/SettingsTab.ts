// ─────────────────────────────────────────────────────────────────────────────
// SettingsTab.ts — Plugin settings registered via addSettingTab()
// ─────────────────────────────────────────────────────────────────────────────

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { AuthManager, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "../auth";
import type LoginVaultPlugin from "../main";
import { checkStrength } from "../password-gen";
import { downloadText, SECRET_INPUT_ATTRS } from "./components";
import { PasswordGenModal } from "./PasswordGenModal";
import { ResetVaultModal } from "./ResetVaultModal";

export class SettingsTab extends PluginSettingTab {
    plugin: LoginVaultPlugin;

    constructor(app: App, plugin: LoginVaultPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass("lv-settings");

        containerEl.createEl("h2", { text: "Login Vault Settings" });

        this.renderSessionSection();
        this.renderPasswordGenSection();
        this.renderAuthSection();
        this.renderSyncSection();
        this.renderDataSection();
        this.renderDangerSection();
    }

    // ── Session ───────────────────────────────────────────────────────────────

    private renderSessionSection(): void {
        const { containerEl } = this;
        containerEl.createEl("h3", { text: "Session" });

        new Setting(containerEl)
            .setName("Auto-lock timeout")
            .setDesc("Lock the vault after this many minutes of inactivity. 0 = never.")
            .addDropdown((dd) => {
                const opts: Record<string, string> = {
                    "0": "Never",
                    "1": "1 minute",
                    "5": "5 minutes",
                    "10": "10 minutes",
                    "30": "30 minutes",
                    "60": "1 hour",
                };
                for (const [k, v] of Object.entries(opts)) dd.addOption(k, v);
                dd.setValue(String(this.plugin.settings.autoLockMinutes));
                dd.onChange(async (v) => {
                    this.plugin.settings.autoLockMinutes = parseInt(v);
                    await this.plugin.saveData(this.plugin.settings);
                    this.plugin.auth.resetAutoLock(this.plugin.settings.autoLockMinutes);
                });
            });

        new Setting(containerEl)
            .setName("Clipboard auto-clear")
            .setDesc("Clear clipboard this many seconds after copying a password. 0 = never.")
            .addDropdown((dd) => {
                const opts: Record<string, string> = {
                    "0": "Never",
                    "15": "15 seconds",
                    "30": "30 seconds",
                    "60": "60 seconds",
                };
                for (const [k, v] of Object.entries(opts)) dd.addOption(k, v);
                dd.setValue(String(this.plugin.settings.clipboardClearSeconds));
                dd.onChange(async (v) => {
                    this.plugin.settings.clipboardClearSeconds = parseInt(v);
                    await this.plugin.saveData(this.plugin.settings);
                });
            });
    }

    // ── Password Generator ────────────────────────────────────────────────────

    private renderPasswordGenSection(): void {
        const { containerEl } = this;
        containerEl.createEl("h3", { text: "Password Generator Defaults" });

        const gen = this.plugin.settings.passwordGenDefaults;

        new Setting(containerEl)
            .setName("Default length")
            .addSlider((s) =>
                s.setLimits(8, 128, 1)
                    .setValue(gen.length)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        gen.length = v;
                        await this.plugin.saveData(this.plugin.settings);
                    })
            );

        const toggles: Array<{ key: keyof typeof gen; name: string }> = [
            { key: "uppercase", name: "Include uppercase (A-Z)" },
            { key: "lowercase", name: "Include lowercase (a-z)" },
            { key: "numbers", name: "Include numbers (0-9)" },
            { key: "symbols", name: "Include symbols (!@#…)" },
            { key: "excludeAmbiguous", name: "Exclude ambiguous characters (0, O, l, 1, I)" },
        ];

        for (const { key, name } of toggles) {
            new Setting(containerEl).setName(name).addToggle((t) =>
                t.setValue(gen[key] as boolean).onChange(async (v) => {
                    (gen[key] as boolean) = v;
                    await this.plugin.saveData(this.plugin.settings);
                })
            );
        }

        new Setting(containerEl)
            .setName("Open generator")
            .setDesc("Preview and test the password generator with current defaults.")
            .addButton((btn) =>
                btn.setButtonText("Open Generator").onClick(() => {
                    new PasswordGenModal(this.app, gen).open();
                })
            );
    }

    // ── Authentication ────────────────────────────────────────────────────────

    private renderAuthSection(): void {
        const { containerEl } = this;
        containerEl.createEl("h3", { text: "Authentication" });

        // Change master password
        const changePwContainer = containerEl.createDiv("lv-settings-subblock");
        changePwContainer.createEl("p", { text: "Change master password", cls: "lv-settings-sub-label" });
        const currentPw = changePwContainer.createEl("input", { type: "password", placeholder: "Current password", cls: "lv-settings-input", attr: SECRET_INPUT_ATTRS });
        const newPw = changePwContainer.createEl("input", { type: "password", placeholder: "New password (min 10 characters)", cls: "lv-settings-input", attr: SECRET_INPUT_ATTRS });
        const confirmPw = changePwContainer.createEl("input", { type: "password", placeholder: "Confirm new password", cls: "lv-settings-input", attr: SECRET_INPUT_ATTRS });
        const changePwBtn = changePwContainer.createEl("button", { text: "Change Password", cls: "lv-btn-secondary" });

        changePwBtn.onclick = async () => {
            if (this.plugin.auth.isLocked()) { new Notice("Vault must be unlocked first"); return; }
            if (!currentPw.value) { new Notice("Enter your current password"); return; }
            if (!newPw.value || newPw.value.length < 10) { new Notice("New password must be at least 10 characters"); return; }
            if (newPw.value !== confirmPw.value) { new Notice("Passwords do not match"); return; }
            const strength = checkStrength(newPw.value);
            if (strength.score < 3) { new Notice("Choose a stronger password. " + strength.feedback); return; }

            const hadPin = this.plugin.auth.hasPIN();

            changePwBtn.disabled = true;
            changePwBtn.setText("Changing…");
            const ok = await this.plugin.auth.changeMasterPassword(currentPw.value, newPw.value);
            if (ok) {
                new Notice("Password changed");
                if (hadPin) new Notice("This device's PIN was cleared by the password change. Set a new one below.");
                new Notice("Other devices will ask for the new password the next time they sync.", 8000);
                currentPw.value = "";
                newPw.value = "";
                confirmPw.value = "";
                this.display();
                return;
            } else {
                new Notice("Couldn't change the password. Check your current password.");
            }
            changePwBtn.disabled = false;
            changePwBtn.setText("Change Password");
        };

        // PIN management
        containerEl.createEl("hr");
        const pinContainer = containerEl.createDiv("lv-settings-subblock");
        const pinLabel = this.plugin.auth.hasPIN() ? "Change PIN" : "Set PIN";
        pinContainer.createEl("p", { text: pinLabel, cls: "lv-settings-sub-label" });
        pinContainer.createEl("p", {
            text: "Quick unlock for this device only. The PIN is never synced. Anyone who can copy this device's files could guess a numeric PIN, so your master password is still the real protection. After 5 wrong PINs it turns itself off.",
            cls: "setting-item-description",
        });
        const pinAttr = { inputmode: "numeric", pattern: "[0-9]*", maxlength: String(PIN_MAX_LENGTH), ...SECRET_INPUT_ATTRS };
        const pinInput = pinContainer.createEl("input", {
            type: "password",
            placeholder: `${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digit PIN`,
            cls: "lv-settings-input",
            attr: pinAttr,
        });
        const pinConfirm = pinContainer.createEl("input", {
            type: "password",
            placeholder: "Confirm PIN",
            cls: "lv-settings-input",
            attr: pinAttr,
        });
        const pinBtnRow = pinContainer.createDiv("lv-btn-row");
        const setPinBtn = pinBtnRow.createEl("button", { text: `${pinLabel}`, cls: "lv-btn-secondary" });

        if (this.plugin.auth.hasPIN()) {
            const removePinBtn = pinBtnRow.createEl("button", { text: "Remove PIN", cls: "lv-btn-danger" });
            removePinBtn.onclick = () => {
                this.plugin.auth.removePIN();
                new Notice("PIN removed");
                this.display();
            };
        }

        setPinBtn.onclick = async () => {
            if (this.plugin.auth.isLocked()) { new Notice("Vault must be unlocked to set a PIN"); return; }
            const pin = pinInput.value.trim();
            if (!AuthManager.isValidPin(pin)) { new Notice(`PIN must be ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits`); return; }
            if (pin !== pinConfirm.value.trim()) { new Notice("PINs do not match"); return; }
            try {
                await this.plugin.auth.setupPIN(pin);
                new Notice("PIN set for this device");
                pinInput.value = "";
                pinConfirm.value = "";
                this.display();
            } catch (e) {
                new Notice("Couldn't set the PIN: " + (e as Error).message);
            }
        };
    }

    // ── Sync & backups ────────────────────────────────────────────────────────

    private renderSyncSection(): void {
        const { containerEl } = this;
        containerEl.createEl("h3", { text: "Sync and backups" });

        const status = new Setting(containerEl)
            .setName("Vault file")
            .setDesc("Checking…");

        const refresh = async () => {
            const file = this.app.vault.getAbstractFileByPath("login-vault.enc");
            const backups = await this.plugin.store.listBackups();
            const parts: string[] = [];
            if (file && "stat" in file) {
                const stat = (file as unknown as { stat: { mtime: number; size: number } }).stat;
                parts.push(`login-vault.enc: ${(stat.size / 1024).toFixed(1)} KB, modified ${new Date(stat.mtime).toLocaleString()}`);
            } else {
                parts.push("login-vault.enc was not found in this vault.");
            }
            parts.push(`${backups.length} encrypted backup${backups.length === 1 ? "" : "s"} kept on this device.`);
            status.setDesc(parts.join(" "));
        };
        void refresh();

        new Setting(containerEl)
            .setName("Syncing with Obsidian Sync")
            .setDesc("Obsidian Sync only syncs unknown file types such as login-vault.enc if \"Sync all other types\" is turned on under Settings → Sync → Selective sync. It is off by default and is set separately on each device. Turn it on everywhere you use the vault, and check the modified time above updates after you change an entry on another device.");

        new Setting(containerEl)
            .setName("Back up now")
            .setDesc("Save an encrypted copy of the vault file in the plugin's backups folder on this device. Copies are made automatically as you edit.")
            .addButton((btn) =>
                btn.setButtonText("Back up").onClick(async () => {
                    await this.plugin.store.backupNow();
                    new Notice("Backup saved");
                    void refresh();
                })
            );
    }

    // ── Data (Export / Import) ────────────────────────────────────────────────

    private renderDataSection(): void {
        const { containerEl } = this;
        containerEl.createEl("h3", { text: "Export & Import" });

        new Setting(containerEl)
            .setName("Export as JSON")
            .setDesc("Download all credentials as a plaintext JSON file.")
            .addButton((btn) =>
                btn.setButtonText("Export JSON").setWarning().onClick(() => {
                    if (this.plugin.auth.isLocked()) { new Notice("Vault must be unlocked"); return; }
                    new Notice("Warning: the JSON contains plaintext passwords. Store it securely and delete it afterwards.", 6000);
                    downloadText(this.plugin.store.exportJSON(), "login-vault-export.json", "application/json");
                })
            );

        new Setting(containerEl)
            .setName("Export as CSV")
            .setDesc("Passwords will be in plaintext. Keep this file secure and delete it when you're done.")
            .addButton((btn) =>
                btn.setButtonText("Export CSV").setWarning().onClick(() => {
                    if (this.plugin.auth.isLocked()) { new Notice("Vault must be unlocked"); return; }
                    new Notice("Warning: the CSV contains plaintext passwords. Store it securely and delete it afterwards.", 6000);
                    downloadText(this.plugin.store.exportCSV(), "login-vault-export.csv", "text/csv");
                })
            );

        new Setting(containerEl)
            .setName("Import from JSON")
            .setDesc("Import credentials from a Login Vault JSON export. Duplicates are skipped/merged by timestamp.")
            .addButton((btn) =>
                btn.setButtonText("Choose File…").onClick(() => {
                    if (this.plugin.auth.isLocked()) { new Notice("Vault must be unlocked"); return; }
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = ".json";
                    input.onchange = async () => {
                        const file = input.files?.[0];
                        if (!file) return;
                        const text = await file.text();
                        try {
                            const key = this.plugin.auth.getSessionKey();
                            if (!key) { new Notice("Vault must be unlocked"); return; }
                            const result = await this.plugin.store.importJSON(text, key);
                            this.plugin.refreshOpenViews();
                            new Notice(`Imported ${result.added} entries, skipped ${result.skipped}`);
                        } catch (e) {
                            new Notice("Import failed: " + (e as Error).message);
                        }
                    };
                    input.click();
                })
            );
    }

    // ── Danger Zone ───────────────────────────────────────────────────────────

    private renderDangerSection(): void {
        const { containerEl } = this;
        containerEl.createEl("h3", { text: "Danger zone" });

        new Setting(containerEl)
            .setName("Reset vault")
            .setDesc("Remove the vault and start over. The removal syncs to your other devices. An encrypted copy is kept in the vault trash and the plugin's backups folder.")
            .addButton((btn) =>
                btn
                    .setButtonText("Reset Vault…")
                    .setWarning()
                    .onClick(() => {
                        new ResetVaultModal(this.app, this.plugin).open();
                    })
            );
    }

}
