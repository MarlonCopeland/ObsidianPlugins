// ─────────────────────────────────────────────────────────────────────────────
// crypto.ts — All cryptographic operations via the Web Crypto API
//
// Algorithm:  AES-256-GCM  (authenticated encryption)
// Key Derive: PBKDF2-SHA256, 310,000 iterations, 16-byte random salt
// IV:         12-byte random per encryption
// Verification: none stored — a wrong key fails the AES-GCM auth tag, so the
//               ciphertext is the only oracle (no fast hash for offline guessing)
// ─────────────────────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 310_000;
const KEY_LENGTH_BITS = 256;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Chunked so large buffers don't overflow the engine's argument limit
 * (spreading a whole buffer into String.fromCharCode throws a RangeError
 * once the vault grows past a few hundred entries, first on mobile/JSC).
 */
function toBase64(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

/** Generate cryptographically random bytes, returned as base64 */
export function generateSalt(): string {
    const buf = new Uint8Array(16);
    window.crypto.getRandomValues(buf);
    return toBase64(buf.buffer);
}

export function generateIV(): string {
    const buf = new Uint8Array(12);
    window.crypto.getRandomValues(buf);
    return toBase64(buf.buffer);
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derives an AES-256-GCM CryptoKey from a password and base64-encoded salt.
 *
 * Extractable: quick-unlock (PIN) needs to wrap/unwrap the raw key bytes with
 * a separately-derived key (see wrapKeyRaw/unwrapKeyRaw below), which requires
 * an extractable CryptoKey. The raw bytes are only ever exported transiently
 * in memory to produce that wrapped blob — they are never persisted directly.
 */
export async function deriveKey(password: string, saltB64: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const salt = fromBase64(saltB64);

    const baseKey = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt as unknown as ArrayBuffer,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        baseKey,
        { name: "AES-GCM", length: KEY_LENGTH_BITS },
        true,        // extractable — required to wrap for PIN quick-unlock
        ["encrypt", "decrypt"]
    );
}

// ── Key wrapping (for PIN quick-unlock) ─────────────────────────────────────

/**
 * Exports `key`'s raw bytes and encrypts them with `wrapperKey`.
 * Used to let a PIN-derived key "wrap" the real vault key, so the PIN can
 * recover the real key from cold start without ever storing it unencrypted.
 */
export async function wrapKeyRaw(key: CryptoKey, wrapperKey: CryptoKey): Promise<EncryptedPayload> {
    const raw = await window.crypto.subtle.exportKey("raw", key);
    return encryptData(wrapperKey, toBase64(raw));
}

/** Reverses wrapKeyRaw: decrypts the wrapped blob and imports it as a non-extractable AES-GCM key. */
export async function unwrapKeyRaw(payload: EncryptedPayload, wrapperKey: CryptoKey): Promise<CryptoKey> {
    const rawB64 = await decryptData(wrapperKey, payload.iv, payload.ciphertext);
    const raw = fromBase64(rawB64);
    return window.crypto.subtle.importKey(
        "raw",
        raw as unknown as ArrayBuffer,
        "AES-GCM",
        false,       // not extractable
        ["encrypt", "decrypt"]
    );
}

// ── Encryption / Decryption ───────────────────────────────────────────────────

export interface EncryptedPayload {
    iv: string;         // base64
    ciphertext: string; // base64
}

/**
 * Encrypts a UTF-8 plaintext string with AES-256-GCM.
 * A fresh IV is generated on every call.
 */
export async function encryptData(
    key: CryptoKey,
    plaintext: string
): Promise<EncryptedPayload> {
    const enc = new TextEncoder();
    const ivB64 = generateIV();
    const iv = fromBase64(ivB64);

    const ciphertextBuf = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
        key,
        enc.encode(plaintext)
    );

    return {
        iv: ivB64,
        ciphertext: toBase64(ciphertextBuf),
    };
}

/**
 * Decrypts an AES-256-GCM ciphertext.
 * Throws if the ciphertext has been tampered with (GCM authentication tag failure).
 */
export async function decryptData(
    key: CryptoKey,
    ivB64: string,
    ciphertextB64: string
): Promise<string> {
    const iv = fromBase64(ivB64);
    const ciphertext = fromBase64(ciphertextB64);

    const plaintextBuf = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
        key,
        ciphertext
    );

    return new TextDecoder().decode(plaintextBuf);
}
