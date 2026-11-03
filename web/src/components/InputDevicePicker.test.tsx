import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '../test-utils';
import { InputDevicePicker } from './InputDevicePicker';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const profile = { kind: 'mic' as const, deviceId: '', latencyOffsetMs: 0 };

it('lists audio inputs, keeps an unavailable saved choice and reports the change', async () => {
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: vi.fn(async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Default' },
    { kind: 'audioinput', deviceId: 'usb', label: 'Soran Dual Stomp' },
    { kind: 'audioinput', deviceId: 'mic', label: '' },
    { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
  ]) } });
  const change = vi.fn();
  const { userEvent } = render(<InputDevicePicker profile={{ ...profile, deviceId: 'gone' }} onChange={change} />);
  expect(await screen.findByRole('option', { name: 'Soran Dual Stomp' })).toBeDefined();
  expect(screen.getByRole('option', { name: 'Audio input 2' })).toBeDefined();
  expect(screen.getByRole('option', { name: /Saved input/ })).toBeDefined();
  expect(screen.queryByRole('option', { name: 'Speakers' })).toBeNull();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Audio input' }), 'usb');
  expect(change).toHaveBeenCalledWith({ deviceId: 'usb' });
  expect(screen.queryByText(/heavy drive/)).toBeNull();
});

it('falls back to the default input when devices cannot be listed and warns about direct effects', async () => {
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: vi.fn(async () => { throw new Error('denied'); }) } });
  render(<InputDevicePicker profile={{ ...profile, kind: 'direct' }} onChange={vi.fn()} />);
  expect(await screen.findByText(/could not be listed/)).toBeDefined();
  expect(screen.getByText(/bypass or a clean preset/)).toBeDefined();
  cleanup();
  vi.stubGlobal('navigator', {});
  render(<InputDevicePicker profile={profile} onChange={vi.fn()} />);
  expect(screen.getAllByRole('option')).toHaveLength(1);
});
