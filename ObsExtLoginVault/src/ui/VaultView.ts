// ─────────────────────────────────────────────────────────────────────────────
// VaultView.ts — Main ItemView: credential list with search & filter
// ─────────────────────────────────────────────────────────────────────────────

import { ItemView, Menu, Notice, WorkspaceLeaf } from "obsidian";
import type LoginVaultPlugin from "../main";
import type { CredentialEntry } from "../types";
import { UnlockModal } from "./UnlockModal";
import { CredentialModal } from "./CredentialModal";
import { CredentialDetailModal } from "./CredentialDetailModal";
import { HelpModal } from "./HelpModal";
import { downloadText } from "./components";

export const VAULT_VIEW_TYPE = "login-vault-view";

export class VaultView extends ItemView {
    private plugin: LoginVaultPlugin;
    private searchQuery = "";
    private activeTag: string | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: LoginVaultPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return VAULT_VIEW_TYPE; }
    getDisplayText(): string { return "Login Vault"; }
    getIcon(): string { return "shield"; }

    async onOpen(): Promise<void> {
        await this.ensureUnlocked();
        this.render();
    }

    async onClose(): Promise<void> {
        this.contentEl.empty();
    }

    // ── Unlock gate ───────────────────────────────────────────────────────────

    private async ensureUnlocked(): Promise<boolean> {
        if (!this.plugin.auth.isLocked()) return true;

        return new Promise((resolve) => {
            new UnlockModal(
                this.app,
                this.plugin.auth,
                this.plugin.settings,
                (result) => resolve(result === "unlocked"),
                () => this.plugin.resetVault(),
                this.plugin
            ).open();
        });
    }

    // ── Render ────────────────────────────────────────────────────────────────

    async render(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("lv-view");

        if (this.plugin.auth.isLocked()) {
            this.renderLockedState(contentEl);
            return;
        }

        this.renderHeader(contentEl);
        this.renderSearchBar(contentEl);
        this.renderTagFilter(contentEl);
        this.renderCredentialList(contentEl);
        this.renderFAB(contentEl);
    }

    private renderLockedState(container: HTMLElement): void {
        const helpBtn = container.createEl("button", { cls: "lv-icon-btn lv-help-btn-corner", title: "Help" });
        helpBtn.setText("❓");
        helpBtn.onclick = () => new HelpModal(this.app).open();

        const lock = container.createDiv("lv-locked-state");
        lock.createDiv("lv-lock-icon").setText("🔐");
        lock.createEl("p", { text: "Vault is locked", cls: "lv-lock-text" });
        const btn = lock.createEl("button", { text: "Unlock", cls: "lv-btn-primary" });
        btn.onclick = async () => {
            const ok = await this.ensureUnlocked();
            if (ok) this.render();
        };
    }

    private renderHeader(container: HTMLElement): void {
        const header = container.createDiv("lv-header");
        header.createEl("span", { text: "🔐 Login Vault", cls: "lv-title" });

        const actions = header.createDiv("lv-header-actions");

        const helpBtn = actions.createEl("button", { cls: "lv-icon-btn", title: "Help" });
        helpBtn.setText("❓");
        helpBtn.onclick = () => new HelpModal(this.app).open();

        const exportBtn = actions.createEl("button", { cls: "lv-icon-btn", title: "Export all to CSV" });
        exportBtn.setText("⬇️");
        exportBtn.onclick = () => this.exportCSV();

        const lockBtn = actions.createEl("button", { cls: "lv-icon-btn", title: "Lock vault" });
        lockBtn.setText("🔒");
        lockBtn.onclick = () => {
            this.plugin.auth.lock();
            this.render();
        };
    }

    private exportCSV(): void {
        const creds = this.plugin.store.getAllCredentials();
        if (creds.length === 0) {
            new Notice("No credentials to export");
            return;
        }
        new Notice("⚠️ CSV contains plaintext passwords — handle with care!", 5000);
        downloadText(this.plugin.store.exportCSV(), "login-vault-export.csv", "text/csv");
    }

    private renderSearchBar(container: HTMLElement): void {
        const bar = container.createDiv("lv-search-bar");
        const input = bar.createEl("input", {
            type: "text",
            placeholder: "🔍 Search credentials…",
            cls: "lv-search-input",
        });
        input.value = this.searchQuery;
        input.addEventListener("input", () => {
            this.searchQuery = input.value;
            const list = container.querySelector(".lv-credential-list") as HTMLElement;
            if (list) this.refreshList(list);
        });
    }

    private renderTagFilter(container: HTMLElement): void {
        const creds = this.plugin.store.getAllCredentials();
        const allTags = [...new Set(creds.flatMap((c) => c.tags ?? []))].sort();
        if (allTags.length === 0) return;

        const tagBar = container.createDiv("lv-tag-filter-bar");
        const allBtn = tagBar.createEl("button", {
            text: "All",
            cls: "lv-tag-filter-btn" + (this.activeTag === null ? " active" : ""),
        });
        allBtn.onclick = () => { this.activeTag = null; this.render(); };

        for (const tag of allTags) {
            const btn = tagBar.createEl("button", {
                text: tag,
                cls: "lv-tag-filter-btn" + (this.activeTag === tag ? " active" : ""),
            });
            btn.onclick = () => { this.activeTag = tag; this.render(); };
        }
    }

    private renderCredentialList(container: HTMLElement): void {
        const list = container.createDiv("lv-credential-list");
        this.refreshList(list);
    }

    private refreshList(list: HTMLElement): void {
        list.empty();
        const creds = this.getFilteredCredentials();

        if (creds.length === 0) {
            const empty = list.createDiv("lv-empty-state");
            empty.createDiv("lv-empty-icon").setText("🗝️");
            empty.createEl("p", {
                text: this.searchQuery
                    ? "No credentials match your search"
                    : "No credentials yet — click + to add one",
                cls: "lv-empty-text",
            });
            return;
        }

        for (const entry of creds) {
            this.renderCredentialCard(list, entry);
        }
    }

    private renderCredentialCard(container: HTMLElement, entry: CredentialEntry): void {
        const card = container.createDiv("lv-credential-card");

        const info = card.createDiv("lv-card-info");
        info.createEl("span", { text: entry.title, cls: "lv-card-title" });
        info.createEl("span", { text: entry.username, cls: "lv-card-username" });
        if (entry.url) {
            const domain = this.getDomain(entry.url);
            if (domain) info.createEl("span", { text: domain, cls: "lv-card-url" });
        }

        if (entry.tags?.length) {
            const tagWrap = card.createDiv("lv-card-tags");
            for (const tag of entry.tags.slice(0, 3)) {
                tagWrap.createEl("span", { text: tag, cls: "lv-tag-chip-ro" });
            }
        }

        card.onclick = () => this.openDetail(entry);
        card.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const menu = new Menu();
            menu.addItem((item) => {
                item.setTitle("✏️ Edit").onClick(() => this.openEdit(entry));
            });
            menu.addItem((item) => {
                item.setTitle("📋 Copy Password").onClick(() => {
                    navigator.clipboard.writeText(entry.password);
                    new Notice("Password copied");
                });
            });
            menu.addItem((item) => {
                item.setTitle("🗑️ Delete").onClick(() => this.deleteEntry(entry));
            });
            menu.showAtMouseEvent(e);
        });
    }

    private renderFAB(container: HTMLElement): void {
        const fab = container.createEl("button", { cls: "lv-fab", text: "+" });
        fab.title = "Add credential";
        fab.onclick = () => this.openAdd();
    }

    // ── CRUD actions ──────────────────────────────────────────────────────────

    private openDetail(entry: CredentialEntry): void {
        new CredentialDetailModal(
            this.app,
            entry,
            this.plugin.settings,
            () => this.openEdit(entry),
            () => this.deleteEntry(entry)
        ).open();
    }

    private openAdd(): void {
        const key = this.plugin.auth.getSessionKey()!;
        new CredentialModal(
            this.app,
            this.plugin.store,
            key,
            this.plugin.settings,
            () => this.render()
        ).open();
    }

    private openEdit(entry: CredentialEntry): void {
        const key = this.plugin.auth.getSessionKey()!;
        new CredentialModal(
            this.app,
            this.plugin.store,
            key,
            this.plugin.settings,
            () => this.render(),
            entry
        ).open();
    }

    private async deleteEntry(entry: CredentialEntry): Promise<void> {
        const key = this.plugin.auth.getSessionKey()!;
        await this.plugin.store.deleteCredential(entry.id, key);
        new Notice(`Deleted "${entry.title}"`);
        this.render();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private getFilteredCredentials(): CredentialEntry[] {
        let creds = this.plugin.store.getAllCredentials();
        if (this.activeTag) {
            creds = creds.filter((c) => c.tags?.includes(this.activeTag!));
        }
        if (this.searchQuery.trim()) {
            const q = this.searchQuery.toLowerCase();
            creds = creds.filter(
                (c) =>
                    c.title.toLowerCase().includes(q) ||
                    c.username.toLowerCase().includes(q) ||
                    (c.url ?? "").toLowerCase().includes(q) ||
                    (c.notes ?? "").toLowerCase().includes(q) ||
                    (c.tags ?? []).some((t) => t.toLowerCase().includes(q))
            );
        }
        return creds.sort((a, b) => a.title.localeCompare(b.title));
    }

    private getDomain(url: string): string | null {
        try {
            return new URL(url).hostname.replace("www.", "");
        } catch {
            return null;
        }
    }
}
