/**
 * SoundShare — Encoder
 * ---------------------------------------------------------------------------
 * Converts UTF-8 text into the binary bit stream that will be transmitted as
 * audio tones (FSK).
 *
 * On-the-air packet layout (see README.md for the diagram):
 *
 *   PREAMBLE       48 bits   (32 alternating + 16-bit sync word 0x5AA5)
 *   MESSAGE_LENGTH 16 bits   (payload byte count, big-endian)
 *   PAYLOAD        8·N bits  (UTF-8 bytes, MSB-first)
 *   CRC32          32 bits   (of [length_hi, length_lo, ...payload])
 *   END_MARKER     16 bits   (0xA55A)
 *
 * Modulation (per symbol):
 *   bit 0 -> 1000 Hz tone
 *   bit 1 -> 2000 Hz tone
 *   symbol duration = 100 ms  (see SS.Protocol.SYMBOL_SECONDS)
 *
 * Exposes:
 *   SS.Protocol   — shared protocol constants (also consumed by decoder.js)
 *   SS.Encoder.encodeText(text) -> { bytes, packetBits, byteCount, totalBits,
 *                                    durationSeconds, totalSymbols }
 */

(function () {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;
  const SS = (root.SS = root.SS || {});

  /* ------------------------------------------------------------------ */
  /* Protocol constants shared by encoder, decoder and audio engine.     */
  /* ------------------------------------------------------------------ */
  const Protocol = {
    /* Tone frequencies (Hz) */
    FREQ_ZERO: 1000,
    FREQ_ONE: 2000,

    /* Symbol timing */
    SYMBOL_SECONDS: 0.1,

    /* Preamble composition */
    ALT_BITS: 32,        /* alternating calibration bits              */
    SYNC_WORD: 0x5aa5,   /* 16-bit sync word appended after the alarm */
    PREAMBLE_BITS: 48,   /* 32 alternating + 16 sync = total preamble */

    /* Field sizes */
    LENGTH_FIELD_BITS: 16,
    CRC_BITS: 32,
    END_MARKER: 0xa55a,

    /* Safety ceiling for the payload decoder */
    MAX_PAYLOAD_BYTES: 2048,
  };

  /**
   * Builds the 48-bit preamble bit array:
   *   bits 0..31  : alternating 1,0,1,0,...  (maximises transitions so the
   *                 receiver can lock its symbol clock)
   *   bits 32..47 : the 16-bit sync word 0x5AA5 (distinctive tail marker)
   * @returns {number[]} preamble bits, MSB first
   */
  function buildPreamble() {
    const bits = [];
    for (let i = 0; i < Protocol.ALT_BITS; i++) {
      bits.push(i % 2 === 0 ? 1 : 0);
    }
    bits.push(...bitsFromUint16BE(Protocol.SYNC_WORD));
    return bits;
  }

  Protocol.preambleBits = buildPreamble();

  /* ------------------------------------------------------------------ */
  /* Bit helpers (every byte / word is emitted most-significant-bit first). */
  /* ------------------------------------------------------------------ */

  /**
   * Converts one byte to 8 bits, MSB first.
   * @param {number} b - byte value 0..255
   * @returns {number[]} 8 bits
   */
  function bitsFromByte(b) {
    const out = [];
    for (let i = 7; i >= 0; i--) out.push((b >> i) & 1);
    return out;
  }

  /**
   * Converts a byte sequence to a flat bit array, MSB first.
   * @param {Uint8Array|number[]} bytes
   * @returns {number[]} N*8 bits
   */
  function bitsFromBytes(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) out.push(...bitsFromByte(bytes[i]));
    return out;
  }

  /**
   * Converts a 16-bit unsigned integer to bits, big-endian.
   * @param {number} n
   * @returns {number[]} 16 bits
   */
  function bitsFromUint16BE(n) {
    return bitsFromBytes([(n >>> 8) & 0xff, n & 0xff]);
  }

  /**
   * Encodes a text message into a complete on-the-air bit packet.
   *
   * Steps:
   *   1. UTF-8 encode the text      -> payload bytes
   *   2. 16-bit big-endian length   -> length field bits
   *   3. CRC-32 over [len,len,payload]
   *   4. Assemble bits: preamble | length | payload | crc32 | end marker
   *
   * @param {string} text - message to transmit
   * @returns {{bytes: Uint8Array, packetBits: number[], byteCount: number,
   *            totalBits: number, totalSymbols: number, durationSeconds: number}}
   */
  function encodeText(text) {
    const payloadBytes = new TextEncoder().encode(text);

    if (payloadBytes.length === 0) {
      throw new Error("Message is empty — nothing to send.");
    }
    if (payloadBytes.length > Protocol.MAX_PAYLOAD_BYTES) {
      throw new Error(
        "Message too long (" + payloadBytes.length + " bytes, max " +
        Protocol.MAX_PAYLOAD_BYTES + ")."
      );
    }

    /* 16-bit big-endian message length field. */
    const lengthBytes = new Uint8Array([
      (payloadBytes.length >>> 8) & 0xff,
      payloadBytes.length & 0xff,
    ]);

    /* CRC-32 input = [length_hi, length_lo, ...payload]. */
    const crcInput = new Uint8Array(2 + payloadBytes.length);
    crcInput.set(lengthBytes, 0);
    crcInput.set(payloadBytes, 2);
    const crcBytes = SS.CRC32.toUint32BE(SS.CRC32.crc32(crcInput));

    /* Assemble the whole packet, bit by bit. */
    const packetBits = [
      ...Protocol.preambleBits,                /* PREAMBLE        : 48 bits  */
      ...bitsFromBytes(lengthBytes),           /* MESSAGE_LENGTH  : 16 bits  */
      ...bitsFromBytes(payloadBytes),          /* PAYLOAD         : 3N bits  */
      ...bitsFromBytes(crcBytes),              /* CRC32           : 32 bits  */
      ...bitsFromUint16BE(Protocol.END_MARKER) /* END_MARKER      : 16 bits  */
    ];

    const totalBits = packetBits.length;

    return {
      text,
      bytes: payloadBytes,
      packetBits,
      byteCount: payloadBytes.length,
      totalBits,
      totalSymbols: packetBits.length, /* 1 symbol per bit */
      durationSeconds: totalBits * Protocol.SYMBOL_SECONDS,
    };
  }

  SS.Protocol = Protocol;
  SS.Encoder = { encodeText, bitsFromByte, bitsFromBytes, bitsFromUint16BE };
})();