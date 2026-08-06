import { describe, expect, it } from 'vitest';
// Reference implementation to verify our dependency-free encoder against.
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { generateStellarKeypair } from '../src/cli/strkey';

describe('CLI strkey encoding', () => {
    it('generates keypairs the Stellar SDK validates and derives identically', () => {
        for (let i = 0; i < 10; i++) {
            const { publicKey, secret } = generateStellarKeypair();

            expect(publicKey.startsWith('G')).toBe(true);
            expect(secret.startsWith('S')).toBe(true);
            expect(publicKey).toHaveLength(56);
            expect(secret).toHaveLength(56);

            expect(StrKey.isValidEd25519PublicKey(publicKey)).toBe(true);
            expect(StrKey.isValidEd25519SecretSeed(secret)).toBe(true);

            // The seed must derive exactly the public key we encoded.
            expect(Keypair.fromSecret(secret).publicKey()).toBe(publicKey);
        }
    });
});
