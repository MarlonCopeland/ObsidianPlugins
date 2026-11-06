// ─────────────────────────────────────────────────────────────────────────────
// merge.ts — Three-way merge of credential lists (pure, no Obsidian imports)
//
// Why this exists: the vault is one file that may be rewritten by another
// device (Obsidian Sync etc.) while this device is unlocked. Saving our
// in-memory list over the disk copy would silently erase the other device's
// changes. Instead every write is "read disk → merge → write".
//
//   base   = id → updatedAt of the list as of our last successful load/save
//   local  = what this device holds in memory now
//   remote = what is on disk right now
//
// With the base we can tell "deleted elsewhere" from "added here" without
// storing tombstones in the file (so the file format is unchanged).
// ─────────────────────────────────────────────────────────────────────────────

import type { CredentialEntry } from "./types";

export type Snapshot = Map<string, number>;

export function snapshot(list: CredentialEntry[]): Snapshot {
    const map: Snapshot = new Map();
    for (const e of list) map.set(e.id, e.updatedAt);
    return map;
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
    if (a.size !== b.size) return false;
    for (const [id, ts] of a) {
        if (b.get(id) !== ts) return false;
    }
    return true;
}

export function merge(
    base: Snapshot,
    local: CredentialEntry[],
    remote: CredentialEntry[]
): CredentialEntry[] {
    const localMap = new Map(local.map((e) => [e.id, e]));
    const remoteMap = new Map(remote.map((e) => [e.id, e]));
    const out: CredentialEntry[] = [];

    for (const [id, l] of localMap) {
        const r = remoteMap.get(id);
        const b = base.get(id);
        if (r) {
            // Edited on both sides: newest wins; a tie keeps the local copy.
            out.push(r.updatedAt > l.updatedAt ? r : l);
        } else if (b === undefined) {
            // Never seen on disk: created here, not yet saved.
            out.push(l);
        } else if (l.updatedAt > b) {
            // Deleted elsewhere but edited here afterwards: keep the edit.
            out.push(l);
        }
        // else: deleted elsewhere and untouched here → drop.
    }

    for (const [id, r] of remoteMap) {
        if (localMap.has(id)) continue;
        const b = base.get(id);
        if (b === undefined) {
            // Created on another device.
            out.push(r);
        } else if (r.updatedAt > b) {
            // Deleted here but edited elsewhere afterwards: keep the edit.
            out.push(r);
        }
        // else: deleted here and untouched elsewhere → stay deleted.
    }

    return out;
}
