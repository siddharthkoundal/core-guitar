"""Input quality gates. Run before trusting any musical finding."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .audio import frame_rms_db
from .config import SR, Thresholds


@dataclass
class Quality:
    verdict: str = "ok"  # ok | degraded | rejected | unsupported
    issues: list[dict] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)

    @property
    def usable(self) -> bool:
        return self.verdict in ("ok", "degraded")

    def add(self, code: str, verdict: str, message: str, advice: str) -> None:
        rank = {"ok": 0, "degraded": 1, "unsupported": 2, "rejected": 3}
        if rank[verdict] > rank[self.verdict]:
            self.verdict = verdict
        self.issues.append({"code": code, "level": verdict, "message": message, "advice": advice})

    def confidence_factor(self, th: Thresholds) -> float:
        return th.degraded_confidence_factor if self.verdict == "degraded" else 1.0

    def to_dict(self) -> dict:
        return {"verdict": self.verdict, "issues": self.issues, "metrics": self.metrics}


def pre_checks(y: np.ndarray, raw: np.ndarray, yg: np.ndarray, th: Thresholds, quiet_until_s: float | None,
               input_profile: str = "mic") -> Quality:
    q = Quality()
    direct = input_profile == "direct"
    dur = len(y) / SR
    q.metrics["duration_s"] = round(dur, 2)
    if dur < th.min_duration_s:
        q.add("too_short", "rejected", f"Recording is {dur:.1f} s long.", f"Record at least {th.min_duration_s:.0f} s.")
        return q

    peak = float(np.max(np.abs(raw))) if len(raw) else 0.0
    clip_frac = float(np.mean(np.abs(raw) >= th.clip_level)) if len(raw) else 0.0
    q.metrics["peak_dbfs"] = round(20 * np.log10(max(peak, 1e-10)), 1)
    q.metrics["clipped_fraction"] = round(clip_frac, 5)

    rms = frame_rms_db(yg)
    level = float(np.percentile(rms, 95))
    q.metrics["signal_dbfs"] = round(level, 1)
    if level < th.silence_dbfs:
        q.add("silent", "rejected", "No guitar signal was detected.",
              "Check the processor is selected as the input device, the USB cable is connected and the patch volume is up."
              if direct else "Check the mic is facing the amp and the amp volume is up.")
        return q

    hop_s = 256 / SR
    if quiet_until_s and quiet_until_s > 0.8:
        a, b = int(0.2 / hop_s), int((quiet_until_s - 0.2) / hop_s)
        noise = float(np.median(rms[a:b])) if b > a else float(np.percentile(rms, 10))
        q.metrics["noise_source"] = "lead_in_silence"
    else:
        noise = float(np.percentile(rms, 10))
        q.metrics["noise_source"] = "10th_percentile"
    snr = level - noise
    q.metrics["noise_floor_dbfs"] = round(noise, 1)
    q.metrics["snr_db"] = round(snr, 1)

    if clip_frac > th.clip_fraction_reject:
        q.add(
            "clipping",
            "rejected",
            f"{clip_frac * 100:.2f}% of samples are clipped (peak {q.metrics['peak_dbfs']} dBFS).",
            "Lower the processor's output/USB level or the patch volume, then re-record."
            if direct else "Move the mic further from the amp or lower the amp master volume, then re-record.",
        )
    if snr < th.snr_reject_db:
        q.add(
            "noisy",
            "rejected",
            f"Background noise is high: signal-to-noise about {snr:.0f} dB.",
            "Raise the processor's output/USB level, lower the gain, or turn on the noise gate."
            if direct else "Turn off fans/TV, move the mic closer to the amp speaker (20-40 cm), or raise the amp volume.",
        )
    elif snr < th.snr_degraded_db:
        q.add(
            "noisy",
            "degraded",
            f"Some background noise: signal-to-noise about {snr:.0f} dB. Findings have reduced confidence.",
            "For clearer results, raise the USB level or use a lower-gain patch with the noise gate on."
            if direct else "For clearer results, reduce room noise or move the mic closer to the amp.",
        )
    return q


def post_checks(q: Quality, notes: list, th: Thresholds, input_profile: str = "mic") -> None:
    """Checks that need transcribed notes: monophony, distortion, pitch clarity."""
    direct = input_profile == "direct"
    attacks = [n for n in notes if n.source.startswith("attack")]
    q.metrics["notes_detected"] = len(notes)
    if len(attacks) < 2:
        q.add("no_notes", "rejected", "Fewer than two note attacks were detected.",
              "Play the exercise clearly with the processor's USB level up." if direct
              else "Play the exercise clearly, with the amp loud enough for the mic.")
        return
    pitched = [n for n in attacks if n.midi is not None]
    frac = len(pitched) / len(attacks)
    q.metrics["pitched_fraction"] = round(frac, 2)
    harm = [n.harmonicity for n in pitched if n.harmonicity is not None]
    if harm:
        q.metrics["median_harmonicity"] = round(float(np.median(harm)), 3)
    poly = [n.second_pitch_ratio for n in pitched if n.second_pitch_ratio is not None]
    if poly:
        q.metrics["median_second_pitch_ratio"] = round(float(np.median(poly)), 3)
    if (harm and np.median(harm) < th.polyphony_harmonicity_max) or (
        poly and np.median(poly) >= th.polyphony_second_pitch_min
    ):
        q.add(
            "polyphonic",
            "unsupported",
            "The recording appears to contain several notes sounding at once (chords or a backing track). "
            "This version only analyses single-note playing.",
            "Record a single-note passage without backing audio"
            + (", and turn off delay, reverb and pitch/harmony effects on the processor." if direct else "."),
        )
    elif frac < th.min_pitched_note_fraction:
        q.add(
            "unclear_pitch",
            "unsupported",
            f"Only {frac * 100:.0f}% of attacks had a clear pitch (speech, heavy noise, or muted playing?).",
            "Record clean, single notes on a low-gain patch." if direct else "Record clean, single notes on the clean channel.",
        )

    dec = [n.decay_db for n in pitched if n.decay_db is not None]
    hf = [n.hf_ratio_db for n in pitched if n.hf_ratio_db is not None]
    if len(dec) >= 3 and hf:
        md, mh = float(np.median(dec)), float(np.median(hf))
        q.metrics["median_decay_db_200ms"] = round(md, 1)
        q.metrics["median_hf_ratio_db"] = round(mh, 1)
        if md < th.distortion_decay_db_max and mh > th.distortion_hf_ratio_db_min:
            if direct:
                # Driven processor patches are expected; analyse them with reduced confidence instead of refusing.
                q.add(
                    "driven_tone",
                    "degraded",
                    "The tone is driven or heavily compressed. Pitch and timing are still analysed, "
                    "but dynamics and buzz/ringing findings are less reliable.",
                    "For the most precise feedback, switch to a clean or low-gain patch.",
                )
            else:
                q.add(
                    "distortion",
                    "unsupported",
                    "The tone looks distorted or heavily compressed (sustain barely decays and has strong high harmonics). "
                    "This version is tuned for the clean channel.",
                    "Switch the GA15II to the clean channel with overdrive off, or use Processor (USB) input mode, and re-record.",
                )
