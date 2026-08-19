// ─────────────────────────────────────────────────────────────────────────────
// PasswordGenModal.ts — Password generator with live preview and strength meter
// ─────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice } from "obsidian";
import type { PasswordGenOptions } from "../types";
import { generatePassword, checkStrength } from "../password-gen";
import { renderStrengthBar } from "./components";

export class PasswordGenModal extends Modal {
    private options: PasswordGenOptions;
    private onUse?: (password: string) => void;
    private currentPassword = "";

    constructor(app: App, defaultOptions: PasswordGenOptions, onUse?: (password: string) => void) {
        super(app);
        // Clone options to avoid mutating the defaults
        this.options = { ...defaultOptions };
        this.onUse = onUse;
        this.modalEl.addClass("lv-gen-modal");
    }

    onOpen(): void {
        this.titleEl.setText("🔀 Password Generator");
        this.render();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        // Preview area
        const preview = contentEl.createDiv("lv-gen-preview");
        const pwText = preview.createEl("span", { cls: "lv-gen-pw-text" });
        const strengthBar = preview.createDiv("lv-strength-bar-wrap");
        const strengthLabel = preview.createEl("span", { cls: "lv-strength-label" });

        const refresh = () => {
            this.currentPassword = generatePassword(this.options);
            pwText.setText(this.currentPassword);
            const r = checkStrength(this.currentPassword);
            renderStrengthBar(strengthBar, r.score);
            strengthLabel.setText(r.label);
        };
        refresh();

        // Length slider
        const controls = contentEl.createDiv("lv-gen-controls");
        const lengthRow = controls.createDiv("lv-gen-row");
        lengthRow.createEl("label", { text: `Length: ${this.options.length}`, cls: "lv-gen-label lv-gen-length-label" });
        const slider = lengthRow.createEl("input", { type: "range", cls: "lv-gen-slider" });
        slider.min = "8";
        slider.max = "128";
        slider.value = String(this.options.length);
        slider.addEventListener("input", () => {
            this.options.length = parseInt(slider.value);
            lengthRow.querySelector(".lv-gen-length-label")!.setText(`Length: ${this.options.length}`);
            refresh();
        });

        // Toggles
        const toggleDefs: Array<{ key: keyof PasswordGenOptions; label: string }> = [
            { key: "uppercase", label: "A-Z Uppercase" },
            { key: "lowercase", label: "a-z Lowercase" },
            { key: "numbers", label: "0-9 Numbers" },
            { key: "symbols", label: "!@# Symbols" },
            { key: "excludeAmbiguous", label: "Exclude Ambiguous (0, O, l, 1)" },
        ];

        for (const { key, label } of toggleDefs) {
            const row = controls.createDiv("lv-gen-row lv-gen-toggle-row");
            const cb = row.createEl("input", { type: "checkbox", cls: "lv-gen-checkbox" });
            cb.checked = this.options[key] as boolean;
            row.createEl("label", { text: label, cls: "lv-gen-toggle-label" });
            cb.addEventListener("change", () => {
                (this.options[key] as boolean) = cb.checked;
                refresh();
            });
        }

        // Action buttons
        const btnRow = contentEl.createDiv("lv-gen-btn-row");

        const regenBtn = btnRow.createEl("button", { text: "🔄 Regenerate", cls: "lv-btn-secondary" });
        regenBtn.onclick = () => refresh();

        const copyBtn = btnRow.createEl("button", { text: "📋 Copy", cls: "lv-btn-secondary" });
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(this.currentPassword);
            new Notice("Password copied!");
            copyBtn.setText("✅ Copied");
            setTimeout(() => copyBtn.setText("📋 Copy"), 2000);
        };

        if (this.onUse) {
            const useBtn = btnRow.createEl("button", { text: "✅ Use This", cls: "lv-btn-primary" });
            useBtn.onclick = () => {
                this.onUse?.(this.currentPassword);
                this.close();
            };
        }

        const closeBtn = btnRow.createEl("button", { text: "Close", cls: "lv-btn-ghost" });
        closeBtn.onclick = () => this.close();
    }
}
