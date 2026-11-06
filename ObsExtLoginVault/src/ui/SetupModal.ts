// ─────────────────────────────────────────────────────────────────────────────
// SetupModal.ts — First-run wizard: choose new/existing vault, master password, optional PIN
// ─────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice } from "obsidian";
import { AuthManager, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "../auth";
import type { PluginSettings } from "../types";
import { checkStrength } from "../password-gen";
import { renderStrengthBar, SECRET_INPUT_ATTRS } from "./components";

export interface SetupOptions {
    /** True once a vault file exists on disk (e.g. it finished syncing). */
    vaultExists: () => Promise<boolean>;
    /** This device had a vault before, so a missing file is suspicious (deleted or not yet synced). */
    hadVaultBefore: boolean;
    hasBackup: boolean;
    restoreBackup: () => Promise<boolean>;
    onComplete: () => void | Promise<void>;
    /** Called if the wizard is closed without completing (Esc, tap outside). */
    onDismiss?: () => void;
}

type Step = "choose" | "waiting" | 1 | 2 | 3;

const POLL_MS = 2000;

export class SetupModal extends Modal {
    private auth: AuthManager;
    private opts: SetupOptions;
    private step: Step = "choose";
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private finished = false;

    constructor(app: App, auth: AuthManager, _settings: PluginSettings, opts: SetupOptions) {
        super(app);
        this.auth = auth;
        this.opts = opts;
        this.modalEl.addClass("lv-setup-modal");
    }

    onOpen(): void {
        this.renderStep();
    }

    onClose(): void {
        this.stopPolling();
        this.contentEl.empty();
        if (!this.finished) this.opts.onDismiss?.();
    }

    private renderStep(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.stopPolling();
        if (this.step === "choose") this.renderChoose(contentEl);
        else if (this.step === "waiting") this.renderWaiting(contentEl);
        else if (this.step === 1) this.renderStep1(contentEl);
        else if (this.step === 2) this.renderStep2(contentEl);
        else this.renderStep3(contentEl);
    }

    private stopPolling(): void {
        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    // ── Step 0: new vault or existing one? ────────────────────────────────────

    private renderChoose(container: HTMLElement): void {
        const missing = this.opts.hadVaultBefore;
        this.titleEl.setText(missing ? "Your vault file is missing" : "Set up Login Vault");

        container.createEl("p", {
            text: missing
                ? "This device had a vault, but login-vault.enc can't be found. It may have been deleted, or a sync hasn't delivered it yet. Creating a new vault now would replace it everywhere it syncs."
                : "Do you already use Login Vault on another device with this Obsidian vault? If so, wait for it to sync instead of creating a new one — a second vault would overwrite the first.",
            cls: "lv-setup-desc",
        });

        const col = container.createDiv("lv-form");

        const waitBtn = col.createEl("button", {
            text: "I have a vault on another device — wait for it",
            cls: "lv-btn-primary",
        });
        waitBtn.onclick = () => { this.step = "waiting"; this.renderStep(); };

        if (this.opts.hasBackup) {
            const restoreBtn = col.createEl("button", { text: "Restore the latest backup", cls: "lv-btn-secondary" });
            restoreBtn.onclick = async () => {
                restoreBtn.disabled = true;
                const ok = await this.opts.restoreBackup();
                if (ok) {
                    new Notice("Backup restored. Unlock with your master password.");
                    this.finish();
                } else {
                    new Notice("No readable backup was found");
                    restoreBtn.disabled = false;
                }
            };
        }

        const newBtn = col.createEl("button", {
            text: missing ? "Start a new, empty vault" : "Create a new vault",
            cls: missing ? "lv-btn-danger" : "lv-btn-secondary",
        });
        newBtn.onclick = () => { this.step = 1; this.renderStep(); };
    }

    // ── Waiting for a synced vault ────────────────────────────────────────────

    private renderWaiting(container: HTMLElement): void {
        this.titleEl.setText("Waiting for your vault to sync");

        container.createEl("p", {
            text: "Checking for login-vault.enc every couple of seconds. This window closes when it arrives.",
            cls: "lv-setup-desc",
        });
        const tips = container.createEl("ul", { cls: "lv-setup-tips" });
        [
            "Make sure Obsidian Sync (or your sync tool) has finished on this device.",
            "Obsidian Sync only syncs unknown file types if \"Sync all other types\" is turned on in Settings → Sync → Selective sync. It is off by default and is set per device — turn it on here and on the device that has the vault.",
        ].forEach((t) => tips.createEl("li", { text: t }));

        const row = container.createDiv("lv-btn-row");
        const backBtn = row.createEl("button", { text: "Back", cls: "lv-btn-ghost" });
        backBtn.onclick = () => { this.step = "choose"; this.renderStep(); };

        this.pollTimer = setInterval(async () => {
            if (await this.opts.vaultExists()) {
                new Notice("Your vault arrived. Unlock it with your master password.");
                this.finish();
            }
        }, POLL_MS);
    }

    private finish(): void {
        if (this.finished) return;
        this.finished = true;
        this.close();
        void this.opts.onComplete();
    }

    // ── Step 1: Create master password ───────────────────────────────────────

    private renderStep1(container: HTMLElement): void {
        this.titleEl.setText("Create your master password");

        container.createEl("p", {
            text: "Your master password encrypts all stored credentials. It is never saved — you must remember it. Use a long passphrase: it is the main protection for your vault.",
            cls: "lv-setup-desc",
        });

        const form = container.createDiv("lv-form");

        const pwInput = form.createEl("input", {
            type: "password",
            placeholder: "Create master password",
            cls: "lv-password-input",
            attr: SECRET_INPUT_ATTRS,
        });

        const strengthContainer = form.createDiv("lv-strength-container");
        const strengthBar = strengthContainer.createDiv("lv-strength-bar-wrap");
        const strengthLabel = strengthContainer.createEl("span", { cls: "lv-strength-label", text: "" });

        pwInput.addEventListener("input", () => {
            const result = checkStrength(pwInput.value);
            renderStrengthBar(strengthBar, result.score);
            strengthLabel.setText(pwInput.value ? result.label : "");
        });

        const confirmInput = form.createEl("input", {
            type: "password",
            placeholder: "Confirm master password",
            cls: "lv-password-input",
            attr: SECRET_INPUT_ATTRS,
        });

        const nextBtn = form.createEl("button", { text: "Continue", cls: "lv-btn-primary" });
        nextBtn.onclick = async () => {
            if (!pwInput.value || pwInput.value.length < 10) {
                new Notice("Password must be at least 10 characters");
                return;
            }
            if (pwInput.value !== confirmInput.value) {
                new Notice("Passwords do not match");
                return;
            }
            const strength = checkStrength(pwInput.value);
            if (strength.score < 3) {
                new Notice("Choose a stronger password. " + strength.feedback);
                return;
            }

            nextBtn.disabled = true;
            nextBtn.setText("Setting up…");
            try {
                await this.auth.setupMasterPassword(pwInput.value);
                this.step = 2;
                this.renderStep();
            } catch (e) {
                new Notice("Setup failed: " + (e as Error).message);
                nextBtn.disabled = false;
                nextBtn.setText("Continue");
            }
        };
    }

    // ── Step 2: Optional PIN ──────────────────────────────────────────────────

    private renderStep2(container: HTMLElement): void {
        this.titleEl.setText("Set a PIN (optional)");

        container.createEl("p", {
            text: "A PIN lets you unlock this device quickly. It is stored only on this device and never synced. Someone who can copy this device's files could guess a numeric PIN, so keep a strong master password and skip this on shared devices. You can also set one later in Settings.",
            cls: "lv-setup-desc",
        });

        const form = container.createDiv("lv-form");

        const attr = { inputmode: "numeric", pattern: "[0-9]*", maxlength: String(PIN_MAX_LENGTH), ...SECRET_INPUT_ATTRS };
        const pinInput = form.createEl("input", {
            type: "password",
            placeholder: `${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digit PIN`,
            cls: "lv-password-input",
            attr,
        });

        const confirmPin = form.createEl("input", {
            type: "password",
            placeholder: "Confirm PIN",
            cls: "lv-password-input",
            attr,
        });

        const btnRow = form.createDiv("lv-btn-row");
        const skipBtn = btnRow.createEl("button", { text: "Skip", cls: "lv-btn-ghost" });
        const nextBtn = btnRow.createEl("button", { text: "Set PIN", cls: "lv-btn-primary" });

        skipBtn.onclick = () => { this.step = 3; this.renderStep(); };

        nextBtn.onclick = async () => {
            const pin = pinInput.value.trim();
            if (!AuthManager.isValidPin(pin)) {
                new Notice(`PIN must be ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits`);
                return;
            }
            if (pin !== confirmPin.value.trim()) {
                new Notice("PINs do not match");
                return;
            }
            try {
                await this.auth.setupPIN(pin);
                this.step = 3;
                this.renderStep();
            } catch (e) {
                new Notice("Couldn't set the PIN: " + (e as Error).message);
            }
        };
    }

    // ── Step 3: All done ──────────────────────────────────────────────────────

    private renderStep3(container: HTMLElement): void {
        this.titleEl.setText("You're all set");

        container.createEl("p", {
            text: "Your Login Vault is ready. Select the shield icon in the ribbon to open it.",
            cls: "lv-setup-desc",
        });

        const tips = container.createEl("ul", { cls: "lv-setup-tips" });
        [
            "Use the + button to add credentials",
            "Select an entry to view details and copy passwords",
            "Auto-lock engages after inactivity (configurable in Settings)",
            "To use the vault on other devices, turn on \"Sync all other types\" in Obsidian Sync's selective sync on every device",
        ].forEach((tip) => tips.createEl("li", { text: tip }));

        const doneBtn = container.createEl("button", { text: "Open vault", cls: "lv-btn-primary" });
        doneBtn.onclick = () => this.finish();
    }
}
