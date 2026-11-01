import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '../../test-utils';
import { Uploader } from './Uploader';

afterEach(cleanup);
it('accepts files by content on the server rather than filtering the extension', () => {
  const onRecorded = vi.fn();
  render(<Uploader onRecorded={onRecorded} />);
  const file = new File(['audio'], 'recording.unknown', { type: 'application/octet-stream' });
  fireEvent.change(screen.getByLabelText('Audio file'), { target: { files: [file] } });
  expect(onRecorded).toHaveBeenCalledWith({
    blob: file, name: file.name, source: 'upload', partial: false, settings: {},
  });
});
