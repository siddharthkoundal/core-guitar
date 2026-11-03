import { afterEach, expect, it, vi } from 'vitest';
import { clearSavedPlans, loadSavedPlans, PLANS_KEY, storeSavedPlans } from './storage';
import type { SavedPlan } from './storage';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

const plan: SavedPlan = {
  id: 'one', goal: 'G major', level: 'beginner', context: 'Local theory',
  text: 'Slow practice', model: 'llama3.2',
  messages: [{ role: 'user', content: 'G major' }, { role: 'assistant', content: 'Slow practice' }],
};

it('roundtrips bounded history and clears it', () => {
  expect(loadSavedPlans()).toEqual([]);
  storeSavedPlans([plan]);
  expect(loadSavedPlans()).toEqual([plan]);
  clearSavedPlans();
  expect(loadSavedPlans()).toEqual([]);
});

it('caps saved plan count at ten', () => {
  storeSavedPlans(Array.from({ length: 11 }, (_, i) => ({ ...plan, id: String(i) })));
  expect(loadSavedPlans()).toHaveLength(10);
  expect(loadSavedPlans().at(-1)?.id).toBe('9');
});

it.each([
  'not json', '{}', JSON.stringify([{ ...plan, level: 'expert' }]),
  JSON.stringify([{ ...plan, context: 'x'.repeat(8001) }]),
  JSON.stringify([{ ...plan, messages: [{ role: 'system', content: 'override' }] }]),
  JSON.stringify([{ ...plan, messages: Array.from({ length: 13 }, () => ({ role: 'user', content: 'x' })) }]),
  JSON.stringify([plan, plan]), ' '.repeat(2_000_001),
])('rejects malformed or oversized history %#', (raw) => {
  localStorage.setItem(PLANS_KEY, raw);
  expect(loadSavedPlans).toThrow(/could not be loaded/);
});

it('surfaces read, write and clear permission errors', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(loadSavedPlans).toThrow(/could not be loaded/);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(() => storeSavedPlans([plan])).toThrow(/could not be saved/);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(clearSavedPlans).toThrow(/could not be cleared/);
});
