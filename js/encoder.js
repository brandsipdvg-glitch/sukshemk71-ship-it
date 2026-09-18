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

    /* -------------------------------------------------------------- */
    /* "Ultra" fast mode: 4-FSK, 2 bits per tone, 15 ms per symbol.   */
    /* -------------------------------------------------------------- */
    QUAD_MODE: "fast",
    QUAD_TONES: [1100, 1800, 2500, 3200],  /* 4 Quad-FSK tones (Hz)   */
    QUAD_SYMBOL_SECONDS: 0.015,            /* 15 ms per quad symbol   */
    QUAD_PREAMBLE_SYMBOLS: 32,             /* length of QUAD_PREAMBLE */
    QUAD_CRC_BITS: 32,                     /* checksum still CRC-32    */
    QUAD_END_MARKER: 0xa55a,
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

  /* Ultra-mode preamble: 32 quad symbols from an LFSR so the sequence is
     aperiodic — partial matches of the pattern score far below the real lock,
     and a best shift → back to searching, instead of locking half a packet
     late. */
  Protocol.QUAD_PREAMBLE = [0,0,0,1,1,2,0,3,3,1,0,0,3,3,3,3,0,2,0,1,1,0,3,3,2,2,2,2,3,2,0,0];

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
   * Encodes a text message into a complete "Slow" (2-FSK) on-the-air packet.
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
      ...bitsFromBytes(payloadBytes),          /* PAYLOAD         : 8·N bits */
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

  /* ---------------------------------------------------------------- */
  /* Quad (4-FSK) helpers — each quad carries two bits, MSB-first.    */
  /* ---------------------------------------------------------------- */

  /**
   * Converts one byte to 4 quads (2 bits each), MSB-first:
   * bits  (b7 b6)(b5 b4)(b3 b2)(b1 b0) -> [q0..q3], q0 holds b7,b6.
   * @param {number} b - byte 0..255
   * @returns {number[]} 4 quad values (0..3)
   */
  function quadsFromByte(b) {
    return [
      (b >> 6) & 0x3, (b >> 4) & 0x3, (b >> 2) & 0x3, b & 0x3,
    ];
  }

  /**
   * Converts a byte sequence to a flat quad array (2 bits per quad).
   * @param {Uint8Array|number[]} bytes
   * @returns {number[]} N*4 quads
   */
  function quadsFromBytes(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) out.push(...quadsFromByte(bytes[i]));
    return out;
  }

  /**
   * Converts a 16-bit integer to quads (4 quads = 8 bits per half).
   * @param {number} n
   * @returns {number[]} 8 quads
   */
  function quadsFromUint16BE(n) {
    return quadsFromBytes([(n >>> 8) & 0xff, n & 0xff]);
  }

  /**
   * Encodes a text message into a "Ultra" (4-FSK) on-the-air packet.
   *
   * Packet layout (each symbol carries 2 bits):
   *   PREAMBLE       32 quads  (LFSR pattern)
   *   MESSAGE_LENGTH  8 quads  (16 bits, big-endian)
   *   PAYLOAD         4·N quads (8 bits per byte)
   *   CRC32          16 quads  (of [length_hi, length_lo, ...payload])
   *   END_MARKER      8 quads  (0xA55A)
   *
   * @param {string} text
   * @returns {{bytes: Uint8Array, quads: number[], byteCount: number,
   *            totalSymbols: number, durationSeconds: number}}
   */
  function encodeTextQuad(text) {
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

    const lengthBytes = new Uint8Array([
      (payloadBytes.length >>> 8) & 0xff,
      payloadBytes.length & 0xff,
    ]);

    const crcInput = new Uint8Array(2 + payloadBytes.length);
    crcInput.set(lengthBytes, 0);
    crcInput.set(payloadBytes, 2);
    const crcBytes = SS.CRC32.toUint32BE(SS.CRC32.crc32(crcInput));

    const quads = [
      ...Protocol.QUAD_PREAMBLE,           /* PREAMBLE        : 32 quads  */
      ...quadsFromBytes(lengthBytes),      /* MESSAGE_LENGTH  :  8 quads  */
      ...quadsFromBytes(payloadBytes),     /* PAYLOAD         :  4·N quads */
      ...quadsFromBytes(crcBytes),         /* CRC32           : 16 quads  */
      ...quadsFromUint16BE(Protocol.END_MARKER), /* END_MARKER : 8 quads  */
    ];

    return {
      text,
      bytes: payloadBytes,
      quads,
      byteCount: payloadBytes.length,
      totalSymbols: quads.length,
      durationSeconds: quads.length * Protocol.QUAD_SYMBOL_SECONDS,
    };
  }

  SS.Protocol = Protocol;
  SS.Encoder = {
    encodeText,
    encodeTextQuad,
    bitsFromByte,
    bitsFromBytes,
    bitsFromUint16BE,
    quadsFromByte,
    quadsFromBytes,
    quadsFromUint16BE,
  };
})();