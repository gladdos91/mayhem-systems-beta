import { randomBytes } from 'crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function nanoid(size = 10): string {
  const bytes = randomBytes(size);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}
