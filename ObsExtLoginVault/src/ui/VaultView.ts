// ─────────────────────────────────────────────────────────────────────────────
// VaultView.ts — Main ItemView: credential list with search & filter
// ─────────────────────────────────────────────────────────────────────────────

import { ItemView, Menu, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type LoginVaultPlugin from "../main";
import type { CredentialEntry } from "../types";
import { UnlockModal } from "./UnlockModal";
import { CredentialModal } from "./CredentialModal";
import { CredentialDetailModal } from "./CredentialDetailModal";
import { HelpModal } from "./HelpModal";
import { copyWithTimeout, createIconButton, downloadText } from "./components";

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
        // Never prompt here: Obsidian restores open views at startup, and a
        // password dialog on every launch is a nuisance. A locked view shows
        // an Unlock button; explicit "open vault" actions prompt (see main.ts).
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
        const helpBtn = createIconButton(container, "help-circle", "Help", "lv-icon-btn lv-help-btn-corner");
        helpBtn.onclick = () => new HelpModal(this.app).open();

        const lock = container.createDiv("lv-locked-state");
        setIcon(lock.createDiv("lv-lock-icon"), "lock");
        lock.createEl("p", { text: "Vault is locked", cls: "lv-lock-text" });
        const btn = lock.createEl("button", { text: "Unlock", cls: "lv-btn-primary" });
        btn.onclick = async () => {
            const ok = await this.ensureUnlocked();
            if (ok) this.render();
        };
    }

    private renderHeader(container: HTMLElement): void {
        const header = container.createDiv("lv-header");
        header.createEl("span", { text: "Login Vault", cls: "lv-title" });

        const actions = header.createDiv("lv-header-actions");

        const helpBtn = createIconButton(actions, "help-circle", "Help");
        helpBtn.onclick = () => new HelpModal(this.app).open();

        const exportBtn = createIconButton(actions, "download", "Export all to CSV");
        exportBtn.onclick = () => this.exportCSV();

        const lockBtn = createIconButton(actions, "lock", "Lock vault");
        lockBtn.onclick = () => this.plugin.auth.lock(); // the lock listener re-renders
    }

    private exportCSV(): void {
        const creds = this.plugin.store.getAllCredentials();
        if (creds.length === 0) {
            new Notice("No credentials to export");
            return;
        }
        new Notice("Warning: the CSV contains plaintext passwords. Store it securely and delete it afterwards.", 6000);
        downloadText(this.plugin.store.exportCSV(), "login-vault-export.csv", "text/csv");
    }

    private renderSearchBar(container: HTMLElement): void {
        const bar = container.createDiv("lv-search-bar");
        const input = bar.createEl("input", {
            type: "text",
            placeholder: "Search credentials…",
            attr: { "aria-label": "Search credentials", autocomplete: "off", autocapitalize: "off", spellcheck: "false" },
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
            setIcon(empty.createDiv("lv-empty-icon"), "key-round");
            empty.createEl("p", {
                text: this.searchQuery
                    ? "No credentials match your search"
                    : "Start your vault. Add your first credential with the + button.",
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

        const main = card.createDiv("lv-card-main");
        main.setAttribute("role", "button");
        main.tabIndex = 0;
        main.setAttribute("aria-label", `Open ${entry.title}`);

        const info = main.createDiv("lv-card-info");
        info.createEl("span", { text: entry.title, cls: "lv-card-title" });
        info.createEl("span", { text: entry.username, cls: "lv-card-username" });
        if (entry.url) {
            const domain = this.getDomain(entry.url);
            if (domain) info.createEl("span", { text: domain, cls: "lv-card-url" });
        }

        if (entry.tags?.length) {
            const tagWrap = main.createDiv("lv-card-tags");
            for (const tag of entry.tags.slice(0, 3)) {
                tagWrap.createEl("span", { text: tag, cls: "lv-tag-chip-ro" });
            }
        }

        // Visible actions: the common tasks must not depend on a right-click
        // or long-press (the context-menu event is unreliable on iOS).
        const actions = card.createDiv("lv-card-actions");
        const copyUser = createIconButton(actions, "user", `Copy username for ${entry.title}`);
        copyUser.onclick = (e) => { e.stopPropagation(); this.copySecret(entry.username, "Username copied"); };
        const copyPw = createIconButton(actions, "key", `Copy password for ${entry.title}`, "lv-icon-btn lv-icon-btn-accent");
        copyPw.onclick = (e) => { e.stopPropagation(); this.copySecret(entry.password, "Password copied"); };
        const more = createIconButton(actions, "more-horizontal", `More actions for ${entry.title}`);
        more.onclick = (e) => { e.stopPropagation(); this.showMenu(entry, e); };

        main.onclick = () => this.openDetail(entry);
        main.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.openDetail(entry); }
        });
        card.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.showMenu(entry, e);
        });
    }

    private showMenu(entry: CredentialEntry, e: MouseEvent): void {
        const menu = new Menu();
        menu.addItem((item) => {
            item.setTitle("Edit").setIcon("pencil").onClick(() => this.openEdit(entry));
        });
        menu.addItem((item) => {
            item.setTitle("Copy username").setIcon("user").onClick(() => this.copySecret(entry.username, "Username copied"));
        });
        menu.addItem((item) => {
            item.setTitle("Copy password").setIcon("key").onClick(() => this.copySecret(entry.password, "Password copied"));
        });
        menu.addItem((item) => {
            item.setTitle("Delete").setIcon("trash-2").onClick(() => this.deleteEntry(entry));
        });
        menu.showAtMouseEvent(e);
    }

    /** Every copy goes through the clipboard-clear timer. */
    private copySecret(value: string, message: string): void {
        copyWithTimeout(value, this.plugin.settings.clipboardClearSeconds);
        new Notice(message);
    }

    private renderFAB(container: HTMLElement): void {
        const fab = createIconButton(container, "plus", "Add credential", "lv-fab");
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
        const key = this.plugin.auth.getSessionKey();
        if (!key) { this.render(); return; }
        new CredentialModal(
            this.app,
            this.plugin.store,
            key,
            this.plugin.settings,
            () => this.render()
        ).open();
    }

    private openEdit(entry: CredentialEntry): void {
        const key = this.plugin.auth.getSessionKey();
        if (!key) { this.render(); return; }
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
        const key = this.plugin.auth.getSessionKey();
        if (!key) { this.render(); return; }
        try {
            await this.plugin.store.deleteCredential(entry.id, key);
            new Notice(`Deleted "${entry.title}"`);
        } catch (e) {
            new Notice("Couldn't delete: " + (e as Error).message);
        }
        if (!this.plugin.auth.isLocked()) this.render();
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
