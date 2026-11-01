import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '../../test-utils';
import { parseEnvelope } from '../../api';
import { Results } from './Results';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('shows quality before notes and labels coaching as unmeasured suggestions', () => {
  const golden = readFileSync(resolve(process.cwd(), '../tests/golden/late.json'), 'utf8');
  const envelope = parseEnvelope({
    analysis_id: 'analysis', take_id: 'take', source: 'upload', request: {},
    track_settings: {}, lossy: false, result: JSON.parse(golden),
  });
  render(<Results envelope={envelope} />);
  const headings = screen.getAllByRole('heading').map(heading => heading.textContent);
  expect(headings.indexOf('Input quality')).toBeLessThan(headings.indexOf('Note table'));
  expect(screen.getByText('24/24 notes matched')).toBeDefined();
  expect(screen.getByText('Possible causes (not measured)')).toBeDefined();
  expect(screen.getByText('Drill (suggestion)')).toBeDefined();
  expect(screen.getByText('Suggestions, not measured')).toBeDefined();
});
