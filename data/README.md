# data/ — private recordings (git-ignored)

Everything in this folder except this README is ignored by git. Recordings
and analysis output stay on this machine.

Suggested layout:

```
data/
  clicks/   click-track WAVs made with `coreguitar click`
  m0/       labelled calibration takes (*.wav/*.m4a + *.label.json + optional *.onsets.txt)
  takes/    everyday practice takes
  results/  JSON written by `coreguitar analyze --json`
  app/
    tmp/                      temporary streamed uploads and normalized work files
    takes/
      <uuid4>/
        original.<ext>        original uploaded audio (safe extension, or .bin)
        take.wav              float32 PCM at native rate; analysis and evidence playback
        meta.json             source, codec, track settings and interrupted flag
        analysis-<uuid4>.json  unchanged analyzer result inside its app envelope
```

**App retention:** valid takes remain until you explicitly delete them. Cancelling
an analysis kills its subprocess but keeps the take. **Delete this take** removes
its original audio, normalized WAV, metadata and all analyses; **Delete all saved
takes** removes all app takes. Related queued/running analyses are cancelled first.
There is no SQLite database, telemetry, remote upload, or hidden history copy.
Completed JSON analyses survive restarting the app; queue statuses are in memory.

Rejected uploads are deleted immediately. Temporary uploads older than one hour
are swept at startup and hourly; fresh work is preserved. Multipart staging also
uses the operating system's temporary directory and is closed after the request.

**CLI deletion:** delete the audio file and its `.label.json`, `.onsets.txt` and
results JSON. To manually delete an app take, stop the server and remove just
that take's UUID directory. No other take directory needs to be changed.
