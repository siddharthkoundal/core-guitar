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
```

**Deletion:** to remove a take, delete the audio file and its `.label.json`,
`.onsets.txt` and results JSON. Nothing else keeps a copy. The app has no
cache, upload or telemetry. When the UI and SQLite storage arrive (M2), its
delete action must remove the files and their database rows together.
