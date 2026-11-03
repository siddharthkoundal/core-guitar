import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '../../test-utils';
import { ChordStudio } from './ChordStudio';
import type { MicrophoneCallbacks } from './microphone';

let callbacks: MicrophoneCallbacks;
const input = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), dispose: vi.fn() }));
vi.mock('./microphone', () => ({
  ChordMicrophone: class {
    constructor(value: MicrophoneCallbacks) { callbacks = value; }
    start() { input.start(); callbacks.onStatus({ state: 'permission' }); return Promise.resolve(); }
    stop() { input.stop(); callbacks.onStatus({ state: 'idle' }); }
    dispose() { input.dispose(); }
  },
}));
vi.mock('../coach/client', () => ({ askCoach: vi.fn() }));

afterEach(() => {
  cleanup(); localStorage.clear(); vi.restoreAllMocks();
  input.start.mockClear(); input.stop.mockClear(); input.dispose.mockClear();
});

it('shows cancellable permission, explicit denial and disposes when leaving the studio', async () => {
  const { userEvent, unmount } = render(<ChordStudio />);
  expect(input.start).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Start chord microphone' }));
  expect(screen.getByText(/Waiting for microphone permission/)).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel microphone request' }));
  expect(input.stop).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'Start chord microphone' }));
  act(() => callbacks.onStatus({ state: 'error', message: 'Microphone permission denied.' }));
  expect(screen.getByText('Microphone permission denied.')).toBeDefined();
  unmount();
  expect(input.dispose).toHaveBeenCalledOnce();
});

it('announces listening, no signal, ambiguity and detection without duplicating sustained chords', async () => {
  const onDetected = vi.fn();
  const { userEvent } = render(<ChordStudio onDetected={onDetected} />);
  await userEvent.click(screen.getByRole('button', { name: 'Start chord microphone' }));
  act(() => callbacks.onStatus({ state: 'listening' }));
  expect(screen.getByText(/Listening — averaging/)).toBeDefined();
  act(() => callbacks.onResult({ state: 'no-signal' }));
  expect(screen.getByText(/No signal: check/)).toBeDefined();
  act(() => callbacks.onResult({ state: 'ambiguous' }));
  expect(screen.getByText(/Ambiguous chord: try/)).toBeDefined();
  const chord = { name: 'C', root: 0, quality: 'major', similarity: 0.99, detectedAt: new Date().toISOString() };
  act(() => {
    callbacks.onResult({ state: 'detected', chord });
    callbacks.onResult({ state: 'detected', chord });
  });
  expect(onDetected).toHaveBeenCalledOnce();
  expect(screen.getByText(/Cosine similarity 0.990/)).toBeDefined();
  act(() => { callbacks.onResult({ state: 'no-signal' }); callbacks.onResult({ state: 'detected', chord }); });
  expect(onDetected).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole('button', { name: 'Stop chord microphone' }));
  expect(screen.queryByText(/Cosine similarity 0.990/)).toBeNull();
});

it('reports parent persistence failures without losing the manual chord', async () => {
  const { userEvent } = render(<ChordStudio onDetected={() => { throw new Error('failed'); }} />);
  await userEvent.click(screen.getByRole('button', { name: 'Add manual chord' }));
  expect(screen.getByText(/Parent chord persistence failed/)).toBeDefined();
  expect(screen.getByText(/manual selection; similarity not measured/)).toBeDefined();
});
