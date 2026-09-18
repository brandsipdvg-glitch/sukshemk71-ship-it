/**
 * SoundShare — CRC-32
 * ---------------------------------------------------------------------------
 * Standard CRC-32 (IEEE 802.3): polynomial 0x04C11DB7, reflected lookup-table
 * implementation, init 0xFFFFFFFF, final XOR 0xFFFFFFFF.
 *
 * Used to verify that an acoustic packet arrived intact. If the CRC recomputed
 * from the received message differs from the CRC carried in the packet, the
 * receiver declares a transmission error.
 *
 * Exposes:
 *   SS.CRC32.crc32(bytes: Uint8Array) -> number      (unsigned 32-bit value)
 *   SS.CRC32.toUint32BE(n: number)    -> Uint8Array  (4 bytes, big-endian)
 */

(function () {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;
  const SS = (root.SS = root.SS || {});

  /* Reflected CRC-32 polynomial (see https://reveng.sourceforge.io/crc-catalogue/) */
  const POLY = 0xedb88320;

  /* Lookup table for all 256 possible byte values. */
  const TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (POLY ^ (c >>> 1)) : (c >>> 1);
    }
    TABLE[i] = c >>> 0;
  }

  /**
   * Computes the CRC-32 checksum of a byte sequence.
   * @param {Uint8Array|number[]} bytes - data to checksum
   * @returns {number} unsigned 32-bit CRC value
   */
  function crc32(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Serializes an unsigned 32-bit integer big-endian (most significant byte
   * first) into a 4-byte Uint8Array. This is the on-the-air byte order.
   * @param {number} n - unsigned 32-bit value
   * @returns {Uint8Array} 4 bytes
   */
  function toUint32BE(n) {
    return new Uint8Array([
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    ]);
  }

  SS.CRC32 = { crc32, toUint32BE };
})();