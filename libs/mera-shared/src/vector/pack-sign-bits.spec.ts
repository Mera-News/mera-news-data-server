import { packSignBits } from './pack-sign-bits';

describe('packSignBits', () => {
  it('packs an all-positive vector to all-1 bits', () => {
    const vector = Array.from({ length: 8 }, () => 1);
    expect(packSignBits(vector)).toEqual(Buffer.from([0xff]));
  });

  it('packs an all-negative vector to all-0 bits', () => {
    const vector = Array.from({ length: 8 }, () => -1);
    expect(packSignBits(vector)).toEqual(Buffer.from([0x00]));
  });

  it('treats exactly 0 as non-negative (bit set) — `>= 0`, not `> 0`', () => {
    expect(packSignBits([0])).toEqual(Buffer.from([0x80]));
  });

  it('packs bit i to the MSB-first position within its byte', () => {
    // index 0 -> 0x80 (MSB), index 7 -> 0x01 (LSB). Only index 0 positive.
    const vector = [1, -1, -1, -1, -1, -1, -1, -1];
    expect(packSignBits(vector)).toEqual(Buffer.from([0b1000_0000]));

    // Only the LAST index (7) positive -> LSB set.
    const lastOnly = [-1, -1, -1, -1, -1, -1, -1, 1];
    expect(packSignBits(lastOnly)).toEqual(Buffer.from([0b0000_0001]));
  });

  it('reproduces a known byte-for-byte fixture for a mixed-sign vector', () => {
    // Bits (MSB-first): 1 0 1 1 0 0 0 1  =  0xB1
    const vector = [1, -2, 3, 4, -5, -6, -7, 8];
    expect(packSignBits(vector)).toEqual(Buffer.from([0b1011_0001]));
  });

  it('packs a 768-dim vector (Jina embedding dimension) to exactly 96 bytes', () => {
    const vector = Array.from({ length: 768 }, (_, i) =>
      i % 2 === 0 ? 1 : -1,
    );
    const packed = packSignBits(vector);
    expect(packed.length).toBe(96);
    // Alternating +/- starting positive -> every byte is 0b10101010 = 0xAA.
    expect(packed.every((byte) => byte === 0xaa)).toBe(true);
  });

  it('pads a length not a multiple of 8 to ceil(length/8) bytes with 0 trailing bits', () => {
    // 3 dims, all positive -> only the top 3 bits of 1 byte are set.
    const vector = [1, 1, 1];
    expect(packSignBits(vector)).toEqual(Buffer.from([0b1110_0000]));
  });

  it('packs an empty vector to an empty buffer', () => {
    expect(packSignBits([])).toEqual(Buffer.alloc(0));
  });

  it('is deterministic and order-sensitive across repeated calls', () => {
    const vector = [1, 1, -1, -1, -1, -1, -1, -1, 5];
    const a = packSignBits(vector);
    const b = packSignBits(vector);
    expect(a).toEqual(b);
    expect(a).not.toEqual(packSignBits([...vector].reverse()));
  });
});
