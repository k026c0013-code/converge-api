import { hash, verify } from '@node-rs/argon2';

// OWASP minimum recommendation for argon2id (ADR-0008 §1).
const OPTIONS = { algorithm: 2 /* Algorithm.Argon2id (const enum) */, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real verification. Used when the email does not exist,
 * so response timing does not reveal which accounts exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalization');
  await verifyPassword(await dummyHash, password);
  return false;
}
