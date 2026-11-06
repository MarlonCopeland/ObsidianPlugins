// ─────────────────────────────────────────────────────────────────────────────
// UnlockModal.ts — Password / PIN unlock screen
// ─────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice, setIcon } from "obsidian";
import { AuthManager, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "../auth";
import type { PluginSettings } from "../types";
import type LoginVaultPlugin from "../main";
import { ResetVaultModal } from "./ResetVaultModal";
import { SECRET_INPUT_ATTRS } from "./components";

export type UnlockResult = "unlocked" | "cancelled";

type UnlockTab = "password" | "pin";

export class UnlockModal extends Modal {
    private auth: AuthManager;
    private resolve: (result: UnlockResult) => void;
    private resolved = false;
    private activeTab: UnlockTab = "password";
    private pinDigits = "";
    private plugin: LoginVaultPlugin;
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;

    constructor(
        app: App,
        auth: AuthManager,
        _settings: PluginSettings,
        resolve: (result: UnlockResult) => void,
        _onReset: () => Promise<void>,
        plugin: LoginVaultPlugin
    ) {
        super(app);
        this.auth = auth;
        this.resolve = resolve;
        this.plugin = plugin;
        // Start on the PIN pad when one is set on this device.
        if (this.auth.hasPIN()) this.activeTab = "pin";
    }

    async onOpen(): Promise<void> {
        this.modalEl.addClass("lv-unlock-modal");
        this.titleEl.setText("Login Vault is locked");
        this.renderTabs();
    }

    /**
     * Every way of closing this modal (Esc, tapping outside, buttons) must
     * settle the promise the caller is awaiting — otherwise the view that
     * opened it waits forever.
     */
    onClose(): void {
        this.detachKeys();
        this.contentEl.empty();
        this.settle("cancelled");
    }

    private settle(result: UnlockResult): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolve(result);
    }

    private succeed(): void {
        this.settle("unlocked");
        this.close();
    }

    private renderTabs(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.detachKeys();

        if (this.auth.hasPIN()) {
            const tabBar = contentEl.createDiv("lv-tab-bar");
            this.addTab(tabBar, "password", "Password");
            this.addTab(tabBar, "pin", "PIN");
        } else if (this.activeTab === "pin") {
            this.activeTab = "password";
        }

        const tabContent = contentEl.createDiv("lv-tab-content");
        if (this.activeTab === "password") this.renderPasswordTab(tabContent);
        else this.renderPinTab(tabContent);

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

    /** Explains a failed attempt; offers a backup restore when the file itself is damaged. */
    private reportFailure(container?: HTMLElement): void {
        switch (this.auth.lastFailure) {
            case "corrupt":
                new Notice("The vault file is damaged or unreadable. It is not a wrong password — restore a backup below.", 8000);
                if (container) this.renderRestore(container);
                break;
            case "missing":
                new Notice("The vault file wasn't found. If you use sync, wait for it to arrive.", 8000);
                break;
            case "wrong-pin":
                new Notice(`Incorrect PIN. ${this.auth.pinAttemptsLeft()} attempts left.`);
                break;
            case "pin-disabled":
                new Notice("Too many wrong PINs. Quick unlock was turned off — use your master password.", 8000);
                break;
            case "pin-stale":
                new Notice("The master password changed since this PIN was set. Use your master password, then set a new PIN.", 8000);
                break;
            default:
                new Notice("Incorrect password");
        }
    }

    private renderRestore(container: HTMLElement): void {
        if (container.querySelector(".lv-restore-btn")) return;
        const btn = container.createEl("button", { text: "Restore latest backup", cls: "lv-btn-secondary lv-restore-btn" });
        btn.onclick = async () => {
            btn.disabled = true;
            const ok = await this.plugin.store.restoreLatestBackup();
            new Notice(ok ? "Backup restored. Enter your master password." : "No readable backup was found");
            if (ok) this.renderTabs();
            else btn.disabled = false;
        };
    }

    // ── Password tab ──────────────────────────────────────────────────────────

    private renderPasswordTab(container: HTMLElement): void {
        const form = container.createDiv("lv-form");

        const input = form.createEl("input", {
            type: "password",
            placeholder: "Master password",
            cls: "lv-password-input",
            attr: SECRET_INPUT_ATTRS,
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
                this.succeed();
            } else {
                this.reportFailure(form);
                unlockBtn.disabled = false;
                unlockBtn.setText("Unlock");
                input.value = "";
                input.focus();
            }
        };

        input.addEventListener("keydown", (e) => { if (e.key === "Enter") doUnlock(); });
        unlockBtn.onclick = doUnlock;
        cancelBtn.onclick = () => this.close();
    }

    // ── PIN tab ───────────────────────────────────────────────────────────────

    private renderPinTab(container: HTMLElement): void {
        const wrap = container.createDiv("lv-pin-wrap");

        const display = wrap.createDiv("lv-pin-display");
        this.updatePinDisplay(display);

        const press = async (d: string) => {
            if (d === "back") {
                this.pinDigits = this.pinDigits.slice(0, -1);
                this.updatePinDisplay(display);
            } else if (d === "enter") {
                await this.verifyPin(wrap);
            } else if (/^\d$/.test(d) && this.pinDigits.length < PIN_MAX_LENGTH) {
                this.pinDigits += d;
                this.updatePinDisplay(display);
            }
        };

        const grid = wrap.createDiv("lv-pin-grid");
        const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "enter"];
        for (const k of keys) {
            const isDigit = /^\d$/.test(k);
            const btn = grid.createEl("button", {
                cls: "lv-pin-key",
                attr: { type: "button", "aria-label": isDigit ? k : k === "back" ? "Delete" : "Unlock" },
            });
            if (isDigit) btn.setText(k);
            else {
                setIcon(btn, k === "back" ? "delete" : "check");
                btn.addClass(k === "back" ? "lv-pin-del" : "lv-pin-confirm");
            }
            btn.onclick = () => press(k);
        }

        // Physical keyboard: digits, Backspace, Enter.
        this.keyHandler = (e: KeyboardEvent) => {
            if (/^\d$/.test(e.key)) press(e.key);
            else if (e.key === "Backspace") press("back");
            else if (e.key === "Enter") press("enter");
            else return;
            e.preventDefault();
        };
        this.modalEl.addEventListener("keydown", this.keyHandler);
        this.modalEl.tabIndex = -1;
        this.modalEl.focus();

        const cancelBtn = wrap.createEl("button", { text: "Cancel", cls: "lv-btn-ghost lv-pin-cancel" });
        cancelBtn.onclick = () => this.close();
    }

    private detachKeys(): void {
        if (this.keyHandler) {
            this.modalEl.removeEventListener("keydown", this.keyHandler);
            this.keyHandler = null;
        }
    }

    private updatePinDisplay(el: HTMLElement): void {
        el.empty();
        const maxLen = Math.max(PIN_MIN_LENGTH, this.pinDigits.length);
        for (let i = 0; i < maxLen; i++) {
            const dot = el.createDiv("lv-pin-dot");
            if (i < this.pinDigits.length) dot.addClass("filled");
        }
    }

    private async verifyPin(wrap: HTMLElement): Promise<void> {
        if (this.pinDigits.length < PIN_MIN_LENGTH) {
            new Notice(`PIN must be at least ${PIN_MIN_LENGTH} digits`);
            return;
        }
        const ok = await this.auth.unlockWithPIN(this.pinDigits);
        if (ok) {
            this.succeed();
            return;
        }
        this.pinDigits = "";
        this.reportFailure(wrap);
        if (!this.auth.hasPIN()) {
            // The slot was erased (too many tries / stale): fall back to the password screen.
            this.activeTab = "password";
            this.renderTabs();
            return;
        }
        const display = this.contentEl.querySelector(".lv-pin-display") as HTMLElement | null;
        if (display) this.updatePinDisplay(display);
    }
}
