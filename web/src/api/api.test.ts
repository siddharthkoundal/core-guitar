import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError, parseEnvelope } from './index';

afterEach(() => vi.unstubAllGlobals());

it('rejects invalid result contracts instead of rendering success-shaped defaults', () => {
  expect(() => parseEnvelope(null)).toThrow('Invalid analysis envelope');
  expect(() => parseEnvelope({ result: { mode: ['reference'] } })).toThrow();
});

it('rejects a shipped exercise with an unsupported tuning at the API boundary', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{
    id: 'test', name: 'test', description: '', tuning: 'unknown',
    default_duration: '8', notes_text: 'E2', bpm: 80, total_beats: 1, time_signature: [4, 4],
  }]))));
  await expect(api.exercises()).rejects.toThrow('invalid response');
});

it('preserves server validation errors and advice', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    code: 'too_short', message: 'Audio is too short.', advice: 'Record again.',
  }), { status: 422 })));
  await expect(api.exercises()).rejects.toEqual(new ApiError('too_short', 'Audio is too short.', 'Record again.'));
});

it('reports a readable HTTP error when an error reply is not JSON', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('proxy failure', { status: 502 })));
  await expect(api.exercises()).rejects.toThrow('Local server returned HTTP 502.');
});

it('accepts an absent, null or well-formed tone check and rejects a malformed one', () => {
  const result = {
    mode: 'free', quality: { verdict: 'accept', metrics: {}, issues: [] },
    re_record: { requested: false, reasons: [] }, summary: null, notes: [], note_table: [],
    findings: [], priorities: [], listening_points: [], uncertainty: [],
  };
  const envelope = (extra: object) => ({
    analysis_id: 'a', take_id: 't', source: 'upload', request: {}, track_settings: {}, lossy: false,
    result: { ...result, ...extra },
  });
  const tone = {
    experimental: true, input_profile: 'direct', metrics: { crest_db: 4 }, advice: [], caveat: 'Uncalibrated.',
    traits: [{ code: 'compressed', label: 'Dynamics', detail: 'Squashed', attention: false }],
  };
  expect(parseEnvelope(envelope({})).result.tone).toBeUndefined();
  expect(parseEnvelope(envelope({ tone: null })).result.tone).toBeNull();
  expect(parseEnvelope(envelope({ tone })).result.tone?.traits[0]?.code).toBe('compressed');
  expect(() => parseEnvelope(envelope({ tone: { ...tone, input_profile: 'usb' } }))).toThrow();
  expect(() => parseEnvelope(envelope({ tone: { ...tone, traits: [{ code: 1 }] } }))).toThrow();
});

it('posts Guitar Pro files as multipart and validates the converted riff', async () => {
  const body = {
    title: 'Riff', artist: '', source_bpm: 120, track: 0, measure_count: 4, start: 1, end: 4,
    tracks: [{ index: 0, name: 'Gtr', strings: 6, tuning: 'standard', percussion: false }],
    exercise: { notes: '5/0:4', bpm: 120, tuning: 'standard', time_signature: [4, 4], default_duration: '8' },
    warnings: [], total_beats: 4, note_count: 1,
  };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetchMock);
  const file = new File(['gp'], 'riff.gp5');
  await expect(api.importGuitarPro(file, { start: 2 })).resolves.toEqual(body);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const form = init.body as FormData;
  expect(url).toBe('/api/import/guitarpro');
  expect(form.get('options')).toBe('{"start":2}');
  expect((form.get('file') as File).name).toBe('riff.gp5');
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...body, exercise: { ...body.exercise, tuning: 'open_g' } })));
  await expect(api.importGuitarPro(file, {})).rejects.toThrow('invalid response');
});
