// ─────────────────────────────────────────────────────────────────────────────
// CredentialDetailModal.ts — Read-only credential view with copy + reveal
// ─────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice } from "obsidian";
import type { CredentialEntry, PluginSettings } from "../types";
import { copyWithTimeout } from "./components";

export class CredentialDetailModal extends Modal {
    private entry: CredentialEntry;
    private settings: PluginSettings;
    private onEdit: () => void;
    private onDelete: () => void;

    constructor(
        app: App,
        entry: CredentialEntry,
        settings: PluginSettings,
        onEdit: () => void,
        onDelete: () => void
    ) {
        super(app);
        this.entry = entry;
        this.settings = settings;
        this.onEdit = onEdit;
        this.onDelete = onDelete;
        this.modalEl.addClass("lv-detail-modal");
    }

    onOpen(): void {
        const { contentEl } = this;
        this.titleEl.setText(this.entry.title);

        const body = contentEl.createDiv("lv-detail-body");

        // Username row
        this.detailRow(body, "👤 Username", this.entry.username, false);

        // Password row (masked)
        this.passwordRow(body);

        // URL row
        if (this.entry.url) {
            const urlRow = body.createDiv("lv-detail-row");
            urlRow.createEl("span", { text: "🔗 URL", cls: "lv-detail-label" });
            const link = urlRow.createEl("a", { text: this.entry.url, cls: "lv-detail-url" });
            link.href = this.entry.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
        }

        // Notes
        if (this.entry.notes) {
            const notesRow = body.createDiv("lv-detail-row lv-detail-notes-row");
            notesRow.createEl("span", { text: "📝 Notes", cls: "lv-detail-label" });
            notesRow.createEl("p", { text: this.entry.notes, cls: "lv-detail-notes" });
        }

        // Tags
        if (this.entry.tags?.length) {
            const tagRow = body.createDiv("lv-detail-row");
            tagRow.createEl("span", { text: "🏷️ Tags", cls: "lv-detail-label" });
            const chips = tagRow.createDiv("lv-tag-chips-readonly");
            for (const tag of this.entry.tags) {
                chips.createEl("span", { text: tag, cls: "lv-tag-chip-ro" });
            }
        }

        // Metadata
        const meta = body.createDiv("lv-detail-meta");
        meta.createEl("span", {
            text: `Created: ${new Date(this.entry.createdAt).toLocaleDateString()}`,
            cls: "lv-meta-text",
        });
        if (this.entry.updatedAt !== this.entry.createdAt) {
            meta.createEl("span", {
                text: `Updated: ${new Date(this.entry.updatedAt).toLocaleDateString()}`,
                cls: "lv-meta-text",
            });
        }

        // Action buttons
        const btnRow = contentEl.createDiv("lv-detail-actions");
        const editBtn = btnRow.createEl("button", { text: "✏️ Edit", cls: "lv-btn-secondary" });
        const deleteBtn = btnRow.createEl("button", { text: "🗑️ Delete", cls: "lv-btn-danger" });

        editBtn.onclick = () => {
            this.close();
            this.onEdit();
        };

        deleteBtn.onclick = () => {
            const confirmModal = new ConfirmDeleteModal(this.app, this.entry.title, () => {
                this.close();
                this.onDelete();
            });
            confirmModal.open();
        };
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private detailRow(
        container: HTMLElement,
        label: string,
        value: string,
        masked: boolean
    ): void {
        const row = container.createDiv("lv-detail-row");
        row.createEl("span", { text: label, cls: "lv-detail-label" });
        const valueEl = row.createEl("span", {
            text: masked ? "••••••••" : value,
            cls: "lv-detail-value",
        });

        const copyBtn = row.createEl("button", { text: "📋 Copy", cls: "lv-btn-copy" });

        copyBtn.onclick = () => {
            const remaining = this.settings.clipboardClearSeconds;

            copyWithTimeout(
                value,
                remaining,
                (r) => {
                    copyBtn.setText(r > 0 ? `⏳ ${r}s` : "📋 Copy");
                    if (r <= 0) new Notice("Clipboard cleared");
                },
                () => { copyBtn.setText("📋 Copy"); }
            );

            copyBtn.setText(remaining > 0 ? `⏳ ${remaining}s` : "✅ Copied");
            new Notice("Copied to clipboard");
        };
    }

    private passwordRow(container: HTMLElement): void {
        const row = container.createDiv("lv-detail-row");
        row.createEl("span", { text: "🔑 Password", cls: "lv-detail-label" });

        const valueWrap = row.createDiv("lv-detail-pw-wrap");
        const valueEl = valueWrap.createEl("span", { text: "••••••••", cls: "lv-detail-value lv-detail-pw" });
        let revealed = false;

        const revealBtn = valueWrap.createEl("button", { text: "👁", cls: "lv-btn-icon" });
        revealBtn.title = "Show password";
        revealBtn.onclick = () => {
            revealed = !revealed;
            valueEl.setText(revealed ? this.entry.password : "••••••••");
            revealBtn.setText(revealed ? "🙈" : "👁");
        };

        const copyBtn = row.createEl("button", { text: "📋 Copy", cls: "lv-btn-copy" });
        copyBtn.onclick = () => {
            copyWithTimeout(
                this.entry.password,
                this.settings.clipboardClearSeconds,
                (r) => { copyBtn.setText(r > 0 ? `⏳ ${r}s` : "📋 Copy"); },
                () => { new Notice("Clipboard cleared"); }
            );
            copyBtn.setText(
                this.settings.clipboardClearSeconds > 0
                    ? `⏳ ${this.settings.clipboardClearSeconds}s`
                    : "✅ Copied"
            );
            new Notice("Password copied to clipboard");
        };
    }
}

// ── Confirm Delete sub-modal ──────────────────────────────────────────────────

class ConfirmDeleteModal extends Modal {
    private title: string;
    private onConfirm: () => void;

    constructor(app: App, title: string, onConfirm: () => void) {
        super(app);
        this.title = title;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        this.titleEl.setText("⚠️ Delete Credential");
        this.contentEl.createEl("p", {
            text: `Are you sure you want to delete "${this.title}"? This cannot be undone.`,
            cls: "lv-confirm-text",
        });
        const btnRow = this.contentEl.createDiv("lv-btn-row");
        const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "lv-btn-ghost" });
        const deleteBtn = btnRow.createEl("button", { text: "Delete", cls: "lv-btn-danger" });
        cancelBtn.onclick = () => this.close();
        deleteBtn.onclick = () => { this.close(); this.onConfirm(); };
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
