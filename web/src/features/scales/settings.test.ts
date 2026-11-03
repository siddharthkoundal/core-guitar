import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, SETTINGS_KEY } from './settings';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('round trips validated settings and rejects malformed/oversized storage', () => {
  expect(saveSettings({ ...DEFAULT_SETTINGS, root: 7, tuningId: 'DADGAD', bpm: 120 })).toBeNull();
  expect(loadSettings().settings).toEqual({ ...DEFAULT_SETTINGS, root: 7, tuningId: 'DADGAD', bpm: 120 });
  for (const raw of ['{', 'x'.repeat(4097), JSON.stringify({ ...DEFAULT_SETTINGS, root: 12 }),
    JSON.stringify({ ...DEFAULT_SETTINGS, bpm: 999 }), JSON.stringify({ ...DEFAULT_SETTINGS, scaleId: 'fake' })]) {
    localStorage.setItem(SETTINGS_KEY, raw);
    expect(loadSettings().error).toMatch(/settings/i);
    expect(loadSettings().settings).toEqual(DEFAULT_SETTINGS);
  }
});

it('does not coerce arrays or objects into enum preferences', () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, display: ['notes'] }));
  expect(loadSettings().error).not.toBeNull();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, direction: { toString: 'ascending' } }));
  expect(loadSettings().error).not.toBeNull();
});

it('keeps bounded sound and meter preferences', () => {
  expect(saveSettings({ ...DEFAULT_SETTINGS, signature: '7/8', waveform: 'sine', volume: 0.4 })).toBeNull();
  expect(loadSettings().settings.signature).toBe('7/8');
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, volume: 8 }));
  expect(loadSettings().error).not.toBeNull();
});

it('reports storage permission/quota errors explicitly', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
  expect(saveSettings(DEFAULT_SETTINGS)).toMatch(/Quota exceeded/);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
  expect(loadSettings().error).toMatch(/Blocked/);
});
