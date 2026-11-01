export function encodeWav(chunks: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('Invalid capture sample rate.');
  const samples = chunks.reduce((count, chunk) => count + chunk.length, 0);
  const output = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(output);
  function text(offset: number, value: string) {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  }
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) {
    if (!Number.isFinite(sample)) throw new Error('Capture contains a non-finite sample.');
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clipped < 0 ? clipped * 32768 : clipped * 32767, true);
    offset += 2;
  }
  return output;
}
