/**
 * SoundShare — offline round-trip test (Node, no browser required).
 *
 * Verifies the full encoder → synthesizer → decoder chain by generating the
 * actual FSK waveform (1000/2000 Hz, 100 ms symbols) for a packet, feeding
 * the raw PCM into the decoder and asserting that the original text comes out
 * intact (or that a corrupted packet is correctly rejected).
 *
 * Run:  node test/acoustic.test.js
 */

"use strict";

const path = require("path");
const assert = require("assert");

/* Load the browser modules inside a Node-flavoured global. */
globalThis.window = undefined;
require(path.join(__dirname, "..", "js", "crc.js"));
require(path.join(__dirname, "..", "js", "encoder.js"));
require(path.join(__dirname, "..", "js", "decoder.js"));

const SS = globalThis.SS;
const P = SS.Protocol;
const FS = 44100;
const SYMBOL_N = Math.round(FS * P.SYMBOL_SECONDS); /* 4410 samples */

/* ------------------------------------------------------------------------ */
/* FSK waveform synthesizer (mirror of the Web Audio transmitter)           */
/* ------------------------------------------------------------------------ */

/**
 * Renders the packet bits as a sine-wave FSK signal.
 * @param {number[]} bits - packet bits (0/1)
 * @param {object} [opts]
 * @param {number} [opts.noise=0]      - additive white noise amplitude
 * @param {number} [opts.gain=0.9]     - tone amplitude
 * @param {number} [opts.leadIn=0.3]   - silence before the first tone (s)
 * @param {number} [opts.trailing=1.0] - silence after the last tone (s)
 * @param {number} [opts.flipBit=-1]   - symbol index to corrupt (negative = none)
 * @returns {Float32Array}
 */
function synthesize(bits, opts = {}) {
  const {
    noise = 0,
    gain = 0.9,
    leadIn = 0.3,
    trailing = 1.0,
    flipBit = -1,
  } = opts;

  const leadN = Math.round(leadIn * FS);
  const trailN = Math.round(trailing * FS);
  const out = new Float32Array(leadN + bits.length * SYMBOL_N + trailN);

  let rngState = 12345;
  const rng = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff - 0.5; /* [-0.5, 0.5] */
  };

  const write = (idx, t, value) => {
    out[idx] = value + (noise ? noise * rng() : 0);
  };

  for (let i = 0; i < bits.length; i++) {
    const bit = i === flipBit ? 1 - bits[i] : bits[i];
    const freq = bit ? P.FREQ_ONE : P.FREQ_ZERO;
    const start = leadN + i * SYMBOL_N;
    for (let s = 0; s < SYMBOL_N; s++) {
      const t = (start + s) / FS; /* global time keeps phase continuous */
      write(start + s, t, gain * Math.sin(2 * Math.PI * freq * t));
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Test driver: feed a waveform, collect decoder events.                    */
/* ------------------------------------------------------------------------ */

function runDecoder(pcm, opts = {}) {
  const events = [];
  const decoder = new SS.Decoder({
    onSync: (m) => events.push({ type: "sync", ...m }),
    onMessage: (text, meta) => events.push({ type: "message", text, ...meta }),
    onError: (reason) => events.push({ type: "error", reason }),
    onDebug: () => {},
  }, { sampleRate: FS });

  /* Feed in irregular chunk sizes to prove sample-count timing is what matters. */
  let idx = 0;
  const chunkSizes = [4096, 1024, 8192, 512]; /* irregular on purpose */
  let c = 0;
  while (idx < pcm.length) {
    const n = Math.min(chunkSizes[c++ % chunkSizes.length], pcm.length - idx);
    decoder.processSamples(pcm.subarray(idx, idx + n));
    idx += n;
  }
  return { decoder, events };
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", name + " — " + e.message]);
  }
}

/* 1. Protocol shape ------------------------------------------------------ */
test("protocol preamble is 48 bits (32 alternating + 16 sync)", () => {
  assert.strictEqual(P.preambleBits.length, 48);
  assert.strictEqual(P.ALT_BITS, 32);
  assert.strictEqual(P.SYNC_WORD, 0x5aa5);
  assert.strictEqual(P.END_MARKER, 0xa55a);
  assert.strictEqual(P.preambleBits[0], 1);
  assert.strictEqual(P.preambleBits[1], 0);
});

/* 2. "Hello World" round trip, clean signal ------------------------------ */
test('"Hello World" round-trips through the acoustic chain', () => {
  const packet = SS.Encoder.encodeText("Hello World");
  assert.strictEqual(packet.byteCount, 11);
  assert.strictEqual(packet.totalBits, 48 + 16 + 88 + 32 + 16);

  const pcm = synthesize(packet.packetBits);
  const { events } = runDecoder(pcm);

  const msg = events.find((e) => e.type === "message");
  assert.ok(msg, "expected a decoded message, got: " + JSON.stringify(events));
  assert.strictEqual(msg.text, "Hello World");
  assert.strictEqual(msg.bytes, 11);
  assert.ok(msg.crcOk === true);
});

/* 3. Multi-byte / emoji / whitespace -------------------------------------- */
test("emoji + newlines survive a round trip", () => {
  const text = "Line 1\nLine 2 — 你好, 世界 🌍";
  const packet = SS.Encoder.encodeText(text);
  const { events } = runDecoder(synthesize(packet.packetBits));
  const msg = events.find((e) => e.type === "message");
  assert.ok(msg, "expected message, got " + JSON.stringify(events));
  assert.strictEqual(msg.text, text);
});

/* 4. Noise robustness ----------------------------------------------------- */
test("passes with light additive noise (amplitude 0.03)", () => {
  const packet = SS.Encoder.encodeText("Noisy but intact");
  const { events } = runDecoder(synthesize(packet.packetBits, { noise: 0.03 }));
  const msg = events.find((e) => e.type === "message");
  assert.ok(msg, "expected message under noise, got " + JSON.stringify(events));
  assert.strictEqual(msg.text, "Noisy but intact");
});

/* 5. Corruption must be caught by CRC32 ----------------------------------- */
test("corrupted payload symbol is rejected (CRC32 mismatch)", () => {
  const packet = SS.Encoder.encodeText("This message will be corrupted");
  /* Corrupt a symbol inside the payload region. */
  const payloadBitIndex = 64 + 8 + 3; /* 3 bytes into the payload's bits */
  const pcm = synthesize(packet.packetBits, { flipBit: payloadBitIndex });
  const { events } = runDecoder(pcm);
  const msg = events.find((e) => e.type === "message");
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event for a corrupt packet");
  assert.ok(!msg, "corrupt packet must not produce a message");
});

/* 6. Empty input guard ---------------------------------------------------- */
test("encoder rejects empty messages", () => {
  assert.throws(() => SS.Encoder.encodeText(""), /empty/i);
});

/* 7. Long-ish payload sanity ---------------------------------------------- */
test("a 200-byte payload decodes correctly", () => {
  const text = "abc".repeat(200).slice(0, 199);
  const packet = SS.Encoder.encodeText(text);
  const { events } = runDecoder(synthesize(packet.packetBits));
  const msg = events.find((e) => e.type === "message");
  assert.ok(msg, "expected 200-byte message");
  assert.strictEqual(msg.bytes, 199);
  assert.strictEqual(JSON.stringify(msg.text), JSON.stringify(text));
});

/* 8. Mid-stream acquisition ------------------------------------------------- */
test("preamble is found when tones begin mid-stream", () => {
  const packet = SS.Encoder.encodeText("Late arrival");
  /* Mic picks up 2.5 s of silence before the tones actually start. */
  const pcm = synthesize(packet.packetBits, { leadIn: 2.5, trailing: 0.5 });
  const { events } = runDecoder(pcm);
  const msg = events.find((e) => e.type === "message");
  assert.ok(msg, "expected late message, got " + JSON.stringify(events));
  assert.strictEqual(msg.text, "Late arrival");
});

/* 9. 48 kHz hardware --------------------------------------------------------- */
test("decodes at a 48 kHz sample rate (48000 Hz)", () => {
  const packet = SS.Encoder.encodeText("48k");
  const synth = (bits) => {
    const leadN = Math.round(0.3 * 48000);
    const trailN = Math.round(0.5 * 48000);
    const symN = Math.round(48000 * P.SYMBOL_SECONDS);
    const out = new Float32Array(leadN + bits.length * symN + trailN);
    bits.forEach((bit, i) => {
      const f = bit ? P.FREQ_ONE : P.FREQ_ZERO;
      const start = leadN + i * symN;
      for (let s = 0; s < symN; s++) {
        out[start + s] = 0.9 * Math.sin(2 * Math.PI * f * (start + s) / 48000);
      }
    });
    return out;
  };
  const events = [];
  const decoder = new SS.Decoder({
    onMessage: (text, meta) => events.push({ type: "message", text }),
    onError: (r) => events.push({ type: "error", reason: r }),
    onSync: () => {},
    onDebug: () => {},
  }, { sampleRate: 48000 });
  const pcm = synth(packet.packetBits);
  decoder.processSamples(pcm);
  const msg = events.find((e) => e.type === "message");
  assert.ok(msg, "expected 48k message, got " + JSON.stringify(events));
  assert.strictEqual(msg.text, "48k");
});

/* 10. Attenuated signal ------------------------------------------------------ */
test("quiet but clean tones still decode (gain 0.2, + noise)", () => {
  const packet = SS.Encoder.encodeText("Whisper link");
  const { events } = runDecoder(
    synthesize(packet.packetBits, { gain: 0.2, noise: 0.02 }));
  const msg = events.find((e) => e.type === "message");
  assert.ok(msg, "expected quiet message, got " + JSON.stringify(events));
  assert.strictEqual(msg.text, "Whisper link");
});

/* ------------------------------------------------------------------------ */

console.log("\n  SoundShare acoustic chain test\n  " + "=".repeat(40));
for (const [kind, name] of results) {
  console.log("  [" + kind + "] " + name);
}
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log("  " + "=".repeat(40));
console.log("  " + (results.length - failed) + "/" + results.length + " passed\n");
process.exit(failed ? 1 : 0);