// ─────────────────────────────────────────────────────────────────────────────
// UnlockModal.ts — Password / PIN unlock screen
// ─────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice } from "obsidian";
import type { AuthManager } from "../auth";
import type { PluginSettings } from "../types";
import type LoginVaultPlugin from "../main";
import { ResetVaultModal } from "./ResetVaultModal";

export type UnlockResult = "unlocked" | "cancelled";

type UnlockTab = "password" | "pin";

export class UnlockModal extends Modal {
    private auth: AuthManager;
    private settings: PluginSettings;
    private resolve: (result: UnlockResult) => void;
    private onReset: () => Promise<void>;
    private activeTab: UnlockTab = "password";
    private pinDigits = "";
    private plugin: LoginVaultPlugin;

    constructor(
        app: App,
        auth: AuthManager,
        settings: PluginSettings,
        resolve: (result: UnlockResult) => void,
        onReset: () => Promise<void>,
        plugin: LoginVaultPlugin
    ) {
        super(app);
        this.auth = auth;
        this.settings = settings;
        this.resolve = resolve;
        this.onReset = onReset;
        this.plugin = plugin;
    }

    async onOpen(): Promise<void> {
        this.modalEl.addClass("lv-unlock-modal");
        this.titleEl.setText("🔐 Login Vault Locked");
        this.renderTabs();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private renderTabs(): void {
        const { contentEl } = this;
        contentEl.empty();

        // Tab bar
        const tabBar = contentEl.createDiv("lv-tab-bar");
        this.addTab(tabBar, "password", "🔑 Password");
        if (this.auth.hasPIN()) this.addTab(tabBar, "pin", "🔢 PIN");

        // Content
        const tabContent = contentEl.createDiv("lv-tab-content");
        if (this.activeTab === "password") this.renderPasswordTab(tabContent);
        else this.renderPinTab(tabContent);

        // Forgot password footer
        const footer = contentEl.createDiv("lv-unlock-footer");
        const resetLink = footer.createEl("button", {
            text: "Forgot password? Reset vault…",
            cls: "lv-link-btn",
        });
        resetLink.onclick = () => {
            this.close();
            new ResetVaultModal(this.app, this.plugin).open();
        };
    }

    private addTab(bar: HTMLElement, id: UnlockTab, label: string): void {
        const btn = bar.createEl("button", { text: label });
        btn.addClass("lv-tab-btn");
        if (this.activeTab === id) btn.addClass("active");
        btn.onclick = () => {
            this.activeTab = id;
            this.pinDigits = "";
            this.renderTabs();
        };
    }

    // ── Password tab ──────────────────────────────────────────────────────────

    private renderPasswordTab(container: HTMLElement): void {
        const form = container.createDiv("lv-form");

        const input = form.createEl("input", {
            type: "password",
            placeholder: "Master password",
            cls: "lv-password-input",
        });
        input.focus();

        const unlockBtn = form.createEl("button", { text: "Unlock", cls: "lv-btn-primary" });
        const cancelBtn = form.createEl("button", { text: "Cancel", cls: "lv-btn-ghost" });

        const doUnlock = async () => {
            if (!input.value) return;
            unlockBtn.disabled = true;
            unlockBtn.setText("Unlocking…");
            const ok = await this.auth.unlock(input.value);
            if (ok) {
                this.resolve("unlocked");
                this.close();
            } else {
                new Notice("❌ Incorrect password");
                unlockBtn.disabled = false;
                unlockBtn.setText("Unlock");
                input.value = "";
                input.focus();
            }
        };

        input.addEventListener("keydown", (e) => { if (e.key === "Enter") doUnlock(); });
        unlockBtn.onclick = doUnlock;
        cancelBtn.onclick = () => { this.resolve("cancelled"); this.close(); };
    }

    // ── PIN tab ───────────────────────────────────────────────────────────────

    private renderPinTab(container: HTMLElement): void {
        const wrap = container.createDiv("lv-pin-wrap");

        const display = wrap.createDiv("lv-pin-display");
        this.updatePinDisplay(display);

        const grid = wrap.createDiv("lv-pin-grid");
        const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"];
        for (const d of digits) {
            const btn = grid.createEl("button", { text: d, cls: "lv-pin-key" });
            if (d === "⌫") btn.addClass("lv-pin-del");
            if (d === "✓") btn.addClass("lv-pin-confirm");
            btn.onclick = async () => {
                if (d === "⌫") {
                    this.pinDigits = this.pinDigits.slice(0, -1);
                    this.updatePinDisplay(display);
                } else if (d === "✓") {
                    await this.verifyPin();
                } else {
                    if (this.pinDigits.length >= 8) return;
                    this.pinDigits += d;
                    this.updatePinDisplay(display);
                    if (this.pinDigits.length >= 4 && this.settings.pinHash) {
                        // Auto-confirm at max expected length
                    }
                }
            };
        }

        const cancelBtn = wrap.createEl("button", { text: "Cancel", cls: "lv-btn-ghost lv-pin-cancel" });
        cancelBtn.onclick = () => { this.resolve("cancelled"); this.close(); };
    }

    private updatePinDisplay(el: HTMLElement): void {
        el.empty();
        const maxLen = Math.max(4, this.pinDigits.length);
        for (let i = 0; i < maxLen; i++) {
            const dot = el.createDiv("lv-pin-dot");
            if (i < this.pinDigits.length) dot.addClass("filled");
        }
    }

    private async verifyPin(): Promise<void> {
        if (this.pinDigits.length < 4) {
            new Notice("PIN must be at least 4 digits");
            return;
        }
        const ok = await this.auth.unlockWithPIN(this.pinDigits);
        if (ok) {
            this.resolve("unlocked");
            this.close();
        } else {
            new Notice("❌ Incorrect PIN");
            this.pinDigits = "";
            const display = this.contentEl.querySelector(".lv-pin-display") as HTMLElement;
            if (display) this.updatePinDisplay(display);
        }
    }

}
