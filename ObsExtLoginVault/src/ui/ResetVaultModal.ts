// ─────────────────────────────────────────────────────────────────────────────
// ResetVaultModal.ts — Two-step confirmation before destroying the vault
// ─────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice } from "obsidian";
import type LoginVaultPlugin from "../main";

/**
 * A two-step confirmation modal for the nuclear option.
 * Step 1: Warn the user clearly what will happen.
 * Step 2: Ask them to type "RESET" to confirm — prevents accidental taps.
 */
export class ResetVaultModal extends Modal {
    private plugin: LoginVaultPlugin;
    private step: 1 | 2 = 1;

    constructor(app: App, plugin: LoginVaultPlugin) {
        super(app);
        this.plugin = plugin;
        this.modalEl.addClass("lv-reset-modal");
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
        if (this.step === 1) this.renderWarning(contentEl);
        else this.renderConfirm(contentEl);
    }

    // ── Step 1: Clearly explain what will happen ──────────────────────────────

    private renderWarning(container: HTMLElement): void {
        this.titleEl.setText("Reset vault");

        const box = container.createDiv("lv-reset-warning-box");
        box.createEl("p", {
            text: "This will remove your Login Vault from this device and every device it syncs to:",
            cls: "lv-reset-lead",
        });
        const list = box.createEl("ul", { cls: "lv-reset-list" });
        [
            "You will lose access to all stored credentials unless you remember the old master password",
            "Your PIN will be removed",
            "The encrypted vault file (login-vault.enc) moves to the vault trash, and the removal syncs to your other devices",
            "An encrypted copy stays in the plugin's backups folder on this device",
        ].forEach((item) => list.createEl("li", { text: item }));

        box.createEl("p", {
            text: "After resetting you will be prompted to create a new master password.",
            cls: "lv-reset-after",
        });

        const btnRow = container.createDiv("lv-btn-row");
        const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "lv-btn-ghost" });
        const continueBtn = btnRow.createEl("button", { text: "Continue", cls: "lv-btn-danger" });

        cancelBtn.onclick = () => this.close();
        continueBtn.onclick = () => {
            this.step = 2;
            this.renderStep();
        };
    }

    // ── Step 2: Type RESET to confirm ─────────────────────────────────────────

    private renderConfirm(container: HTMLElement): void {
        this.titleEl.setText("Final confirmation");

        container.createEl("p", {
            text: 'Type RESET in the box below to reset your vault.',
            cls: "lv-reset-lead",
        });

        const input = container.createEl("input", {
            type: "text",
            placeholder: "Type RESET here",
            cls: "lv-text-input lv-reset-confirm-input",
        });
        input.focus();

        const btnRow = container.createDiv("lv-btn-row");
        const backBtn = btnRow.createEl("button", { text: "Back", cls: "lv-btn-ghost" });
        const resetBtn = btnRow.createEl("button", { text: "Reset vault", cls: "lv-btn-danger" });
        resetBtn.disabled = true;

        input.addEventListener("input", () => {
            resetBtn.disabled = input.value.trim() !== "RESET";
        });
        input.addEventListener("keydown", async (e) => {
            if (e.key === "Enter" && input.value.trim() === "RESET") await this.executeReset();
        });

        backBtn.onclick = () => { this.step = 1; this.renderStep(); };
        resetBtn.onclick = async () => await this.executeReset();
    }

    private async executeReset(): Promise<void> {
        try {
            await this.plugin.resetVault();
            this.close();
        } catch (e) {
            new Notice("Reset failed: " + (e as Error).message);
        }
    }
}
