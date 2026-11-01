import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '../../test-utils';
import { PcmCapture } from '../../audio/recorder';
import type * as CaptureModule from '../../audio/recorder';
import type * as WarningsModule from '../../components/ProcessingWarnings';
import { Recorder } from './Recorder';

let callbacks: ConstructorParameters<typeof PcmCapture>[0];
const warningsRendered = vi.hoisted(() => vi.fn());
vi.mock('../../audio/recorder', async importOriginal => {
  const actual = await importOriginal<typeof CaptureModule>();
  return {
    ...actual,
    PcmCapture: class extends actual.PcmCapture {
      constructor(value: ConstructorParameters<typeof actual.PcmCapture>[0]) {
        super(value);
        callbacks = value;
      }
    },
  };
});
vi.mock('../../components/ProcessingWarnings', async importOriginal => {
  const actual = await importOriginal<typeof WarningsModule>();
  return {
    ProcessingWarnings: (props: Parameters<typeof actual.ProcessingWarnings>[0]) => {
      warningsRendered();
      return <actual.ProcessingWarnings {...props} />;
    },
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); warningsRendered.mockClear(); });

it('updates elapsed time, input level and sticky clipping without rerendering recorder controls', () => {
  render(<Recorder selection={{ mode: 'free', bpm: 80 }} onRecorded={vi.fn()} onUpload={vi.fn()} />);
  act(() => callbacks.event({ type: 'buffer' }));
  warningsRendered.mockClear();
  for (let index = 1; index <= 10; index++) {
    act(() => callbacks.level(0.2, index === 1 ? 1 : 0.4, index / 10));
  }
  expect(screen.getByText('1.0 s / 180 s')).toBeDefined();
  expect(Number(screen.getByRole('meter').getAttribute('value'))).toBeCloseTo(0.6);
  expect(screen.getByText('Clipping detected: lower the input or amp level.')).toBeDefined();
  expect(warningsRendered).not.toHaveBeenCalled();
});

it('resets meter and clipping for the next microphone attempt and disposes on unmount', async () => {
  const arm = vi.spyOn(PcmCapture.prototype, 'arm').mockResolvedValue();
  const dispose = vi.spyOn(PcmCapture.prototype, 'dispose').mockResolvedValue();
  const { userEvent, unmount } = render(
    <Recorder selection={{ mode: 'free' }} onRecorded={vi.fn()} onUpload={vi.fn()} />,
  );
  act(() => {
    callbacks.event({ type: 'buffer' });
    callbacks.level(1, 1, 5);
    callbacks.event({ type: 'cancel' });
  });
  expect(screen.queryByRole('meter')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Enable microphone' }));
  expect(arm).toHaveBeenCalled();
  act(() => callbacks.event({ type: 'buffer' }));
  expect(screen.getByText('0.0 s / 180 s')).toBeDefined();
  expect(screen.getByText('No clipping observed yet.')).toBeDefined();
  unmount();
  expect(dispose).toHaveBeenCalledTimes(1);
});
