// Sequence files for specs that need real ones.

// An FSEQ v2 file, uncompressed: 32-byte header, then the variable headers
// (an "mf" media file name here, as xLights writes), then the frames.
export function fseqV2(o: { stepMs: number; channels: number; frames: number; media?: string }): Buffer {
  const vars: Buffer[] = [];
  if (o.media) {
    const name = Buffer.from(o.media + '\0', 'latin1');
    const v = Buffer.alloc(4);
    v.writeUInt16LE(4 + name.length, 0);
    v.write('mf', 2, 'latin1');
    vars.push(v, name);
  }
  const varLen = vars.reduce((n, b) => n + b.length, 0);
  const offset = 32 + varLen;
  const h = Buffer.alloc(32);
  h.write('PSEQ', 0, 'latin1');
  h.writeUInt16LE(offset, 4);
  h.writeUInt8(0, 6); // minor
  h.writeUInt8(2, 7); // major
  h.writeUInt16LE(32, 8); // where the variable headers start
  h.writeUInt32LE(o.channels, 10);
  h.writeUInt32LE(o.frames, 14);
  h.writeUInt8(o.stepMs, 18);
  return Buffer.concat([h, ...vars, Buffer.alloc(o.channels * o.frames, 0x10)]);
}
