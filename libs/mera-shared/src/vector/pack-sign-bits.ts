/**
 * Sign-bit packing for float vectors — builds the packed vector sidecar
 * (`NewsArticle.vector_sidecar_packed`) that rides alongside
 * `embedding_article_data_retrieval` for on-device Hamming-distance
 * near-duplicate candidate generation.
 *
 * Shipping the full 768 float32s per article is 3 KB × ~400 articles/sync =
 * 1.2 MB, too heavy on mobile at a 60s cadence. Packing to 1 bit/dimension
 * gives 768 bits = 96 bytes/article — ~38 KB per sync — cheap enough to send
 * on every hydration response and compute a candidate-generation Hamming
 * distance over, entirely on-device.
 *
 * bit i = (vector[i] >= 0) ? 1 : 0
 *
 * BIT ORDER — MSB-FIRST WITHIN EACH BYTE. This is the exact contract the
 * client MUST reproduce byte-for-byte, or its Hamming distances will be a
 * plausible-looking but WRONG number (there is no crash to catch this):
 *   - vector indices are grouped into bytes of 8, in order: indices [0..7]
 *     pack into byte 0, [8..15] into byte 1, and so on
 *     (byteIndex = floor(i / 8)).
 *   - WITHIN a byte, the FIRST index in the group (8*byteIndex + 0) is the
 *     MOST significant bit (mask 0x80), and the LAST index in the group
 *     (8*byteIndex + 7) is the LEAST significant bit (mask 0x01). In other
 *     words: bit = 0x80 >> (i % 8).
 *   - A 768-dim vector (the Jina `jina-embeddings-v5-text-nano` dimension)
 *     packs to EXACTLY 96 bytes, no padding needed. For a length not a
 *     multiple of 8 in general, the output is `ceil(length / 8)` bytes and
 *     any unused trailing bits in the final byte are left 0.
 */
export function packSignBits(vector: readonly number[]): Buffer {
  const numBytes = Math.ceil(vector.length / 8);
  const out = Buffer.alloc(numBytes);

  for (let i = 0; i < vector.length; i++) {
    if (vector[i] >= 0) {
      const byteIndex = i >> 3; // Math.floor(i / 8)
      const bitMask = 0x80 >> (i & 7); // MSB-first within the byte
      out[byteIndex] |= bitMask;
    }
  }

  return out;
}
