/**
 * Minimal Stellar strkey ENCODING for the sandbox CLI — generates a testnet
 * keypair with node:crypto so the CLI stays dependency-free. Encoding only;
 * the runtime library deliberately does no local key validation.
 */

import { generateKeyPairSync } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** CRC16-XModem (poly 0x1021, init 0x0000) — the strkey checksum. */
function crc16xmodem(data: Uint8Array): number {
    let crc = 0;
    for (const byte of data) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) {
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc;
}

function base32(data: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of data) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

/** version || payload || crc16(little-endian), base32'd. */
export function strkeyEncode(versionByte: number, payload: Uint8Array): string {
    const framed = new Uint8Array(payload.length + 3);
    framed[0] = versionByte;
    framed.set(payload, 1);
    const crc = crc16xmodem(framed.subarray(0, payload.length + 1));
    framed[payload.length + 1] = crc & 0xff;
    framed[payload.length + 2] = crc >> 8;
    return base32(framed);
}

/** A fresh ed25519 Stellar keypair (G… / S…) from node:crypto. */
export function generateStellarKeypair(): { publicKey: string; secret: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    // Raw ed25519 material is the trailing 32 bytes of the DER encodings.
    const pubRaw = new Uint8Array(
        publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );
    const seed = new Uint8Array(
        privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
    );
    return {
        publicKey: strkeyEncode(6 << 3, pubRaw), // 'G'
        secret: strkeyEncode(18 << 3, seed), // 'S'
    };
}
