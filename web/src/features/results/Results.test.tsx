import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '../../test-utils';
import { parseEnvelope } from '../../api';
import { Results } from './Results';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function lateEnvelope() {
  const golden = readFileSync(resolve(process.cwd(), '../tests/golden/late.json'), 'utf8');
  return parseEnvelope({
    analysis_id: 'analysis', take_id: 'take', source: 'upload', request: {},
    track_settings: {}, lossy: false, result: JSON.parse(golden),
  });
}
it('puts the first useful observation before collapsed analysis details', async () => {
  const envelope = lateEnvelope();
  const { userEvent } = render(<Results envelope={envelope} />);
  const summary = screen.getByRole('region', { name: 'First thing to work on' });
  expect(screen.getByText(/24\/24 notes matched · 1 measured finding/)).toBeDefined();
  expect(summary.textContent).toMatch(/B2.*late by about 80 ms/);
  expect(screen.getByRole('button', { name: 'Listen to this moment' })).toBeDefined();
  expect(screen.getByText('Full analysis details').closest('details')?.hasAttribute('open')).toBe(false);
  await userEvent.click(screen.getByText('Full analysis details'));
  const headings = screen.getAllByRole('heading').map(heading => heading.textContent);
  expect(headings.indexOf('Input quality')).toBeLessThan(headings.indexOf('First thing to work on'));
  expect(headings.indexOf('First thing to work on')).toBeLessThan(headings.indexOf('Note table'));
  expect(screen.getByText('Possible causes (not measured)')).toBeDefined();
  expect(screen.getAllByText('Drill (suggestion)').length).toBeGreaterThan(0);
  expect(screen.getByText('Suggestions, not measured')).toBeDefined();
});

it('labels findings without a practice priority as observations', () => {
  const envelope = lateEnvelope();
  const unprioritized = { ...envelope, result: { ...envelope.result, priorities: [] } };
  render(<Results envelope={unprioritized} />);
  const summary = screen.getByRole('region', { name: 'Measured observation' });
  expect(summary.textContent).toContain('high confidence · no practice priority assigned');
  expect(screen.queryByRole('heading', { name: 'First thing to work on' })).toBeNull();
});

it('shows the experimental tone check with its traits and caveat', () => {
  render(<Results envelope={lateEnvelope()} />);
  const tone = screen.getByRole('region', { name: /Tone check/ });
  expect(tone.textContent).toContain('Mic + amp input');
  expect(tone.querySelector('[data-tone-code="drive_clean"]')?.textContent).toContain('Drive: clean');
  expect(tone.textContent).toContain('experimental');
});
