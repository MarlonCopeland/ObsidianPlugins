// ─────────────────────────────────────────────────────────────────────────────
// SetupModal.ts — First-run wizard: create master password, optional PIN
// ─────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice } from "obsidian";
import type { AuthManager } from "../auth";
import type { PluginSettings } from "../types";
import { checkStrength } from "../password-gen";
import { renderStrengthBar } from "./components";

export class SetupModal extends Modal {
    private auth: AuthManager;
    private settings: PluginSettings;
    private step = 1;
    private masterPassword = "";
    private onComplete: () => void;

    constructor(
        app: App,
        auth: AuthManager,
        settings: PluginSettings,
        onComplete: () => void
    ) {
        super(app);
        this.auth = auth;
        this.settings = settings;
        this.onComplete = onComplete;
        this.modalEl.addClass("lv-setup-modal");
    }

    onOpen(): void {
        this.renderStep();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private renderStep(): void {
        const { contentEl } = this;
        contentEl.empty();
        if (this.step === 1) this.renderStep1(contentEl);
        else if (this.step === 2) this.renderStep2(contentEl);
        else this.renderStep3(contentEl);
    }

    // ── Step 1: Create master password ───────────────────────────────────────

    private renderStep1(container: HTMLElement): void {
        this.titleEl.setText("🔐 Create Your Master Password");

        container.createEl("p", {
            text: "Your master password encrypts all stored credentials. It is never saved — you must remember it.",
            cls: "lv-setup-desc",
        });

        const form = container.createDiv("lv-form");

        const pwInput = form.createEl("input", {
            type: "password",
            placeholder: "Create master password",
            cls: "lv-password-input",
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
        });

        const nextBtn = form.createEl("button", { text: "Continue →", cls: "lv-btn-primary" });
        nextBtn.onclick = async () => {
            if (!pwInput.value || pwInput.value.length < 8) {
                new Notice("Password must be at least 8 characters");
                return;
            }
            if (pwInput.value !== confirmInput.value) {
                new Notice("Passwords do not match");
                return;
            }
            const strength = checkStrength(pwInput.value);
            if (strength.score < 2) {
                new Notice("Please choose a stronger password: " + strength.feedback);
                return;
            }

            nextBtn.disabled = true;
            nextBtn.setText("Setting up…");
            const ok = await this.auth.setupMasterPassword(pwInput.value);
            if (ok) {
                this.masterPassword = pwInput.value;
                this.step = 2;
                this.renderStep();
            } else {
                new Notice("❌ Setup failed — please try again");
                nextBtn.disabled = false;
                nextBtn.setText("Continue →");
            }
        };
    }

    // ── Step 2: Optional PIN ──────────────────────────────────────────────────

    private renderStep2(container: HTMLElement): void {
        this.titleEl.setText("🔢 Set a PIN (Optional)");

        container.createEl("p", {
            text: "A PIN lets you unlock quickly without re-typing your full password. You can also set one later in Settings.",
            cls: "lv-setup-desc",
        });

        const form = container.createDiv("lv-form");

        const pinInput = form.createEl("input", {
            type: "password",
            placeholder: "4–8 digit PIN (optional)",
            cls: "lv-password-input",
            attr: { inputmode: "numeric", pattern: "[0-9]*", maxlength: "8" },
        });

        const confirmPin = form.createEl("input", {
            type: "password",
            placeholder: "Confirm PIN",
            cls: "lv-password-input",
            attr: { inputmode: "numeric", pattern: "[0-9]*", maxlength: "8" },
        });

        const btnRow = form.createDiv("lv-btn-row");
        const skipBtn = btnRow.createEl("button", { text: "Skip", cls: "lv-btn-ghost" });
        const nextBtn = btnRow.createEl("button", { text: "Set PIN →", cls: "lv-btn-primary" });

        skipBtn.onclick = () => { this.step = 3; this.renderStep(); };

        nextBtn.onclick = async () => {
            const pin = pinInput.value.trim();
            if (!/^\d{4,8}$/.test(pin)) {
                new Notice("PIN must be 4–8 digits");
                return;
            }
            if (pin !== confirmPin.value.trim()) {
                new Notice("PINs do not match");
                return;
            }
            await this.auth.setupPIN(pin);
            this.step = 3;
            this.renderStep();
        };
    }

    // ── Step 3: All done ──────────────────────────────────────────────────────

    private renderStep3(container: HTMLElement): void {
        this.titleEl.setText("✅ You're all set!");

        container.createEl("p", {
            text: "Your Login Vault is ready. Click the shield icon in the ribbon to open it.",
            cls: "lv-setup-desc",
        });

        const tips = container.createEl("ul", { cls: "lv-setup-tips" });
        [
            "Use the + button to add credentials",
            "Click any entry to view details and copy passwords",
            "Auto-lock engages after inactivity (configurable in Settings)",
            "Credentials sync automatically via Obsidian Sync",
        ].forEach((tip) => tips.createEl("li", { text: tip }));

        const doneBtn = container.createEl("button", { text: "Open Vault →", cls: "lv-btn-primary" });
        doneBtn.onclick = () => {
            this.close();
            this.onComplete();
        };
    }
}
