"""Monophonic note transcription: onsets + pYIN pitch -> note events."""

from __future__ import annotations

from dataclasses import dataclass, asdict

import librosa
import numpy as np
from scipy import signal

from .config import (
    GUITAR_BAND_MAX_HZ,
    GUITAR_FMAX,
    GUITAR_FMIN,
    ONSET_HOP,
    PITCH_FRAME,
    PITCH_HOP,
    SR,
)
from .music import midi_to_name


@dataclass
class Note:
    index: int
    onset_s: float
    offset_s: float
    midi_float: float | None
    midi: int | None
    name: str | None
    cents: float | None
    pitch_confidence: float
    attack_db: float
    harmonicity: float | None
    decay_db: float | None
    hf_ratio_db: float | None
    source: str  # "attack", "attack_weak" or "pitch_change"
    confidence: float = 0.0
    second_pitch_ratio: float | None = None
    attack_rise_db: float | None = None

    @property
    def duration_s(self) -> float:
        return self.offset_s - self.onset_s

    def to_dict(self) -> dict:
        d = asdict(self)
        for k, v in list(d.items()):
            if isinstance(v, float):
                d[k] = round(v, 4)
        return d


@dataclass
class PitchTrack:
    times: np.ndarray
    f0: np.ndarray
    voiced: np.ndarray
    prob: np.ndarray


def pitch_track(yg: np.ndarray, sr: int = SR) -> PitchTrack:
    f0, voiced, prob = librosa.pyin(
        yg, fmin=GUITAR_FMIN, fmax=GUITAR_FMAX, sr=sr, frame_length=PITCH_FRAME, hop_length=PITCH_HOP
    )
    times = librosa.times_like(f0, sr=sr, hop_length=PITCH_HOP)
    return PitchTrack(times, f0, voiced.astype(bool), np.nan_to_num(prob))


def _attack_envelopes(yg: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """High-band energy envelopes (2 ms and 5 ms). Pick attacks are sharp here,
    while low-note ripple is not, which keeps onset refinement stable."""
    sos = signal.butter(4, [800, 3000], btype="bandpass", fs=sr, output="sos")
    x = signal.sosfiltfilt(sos, yg) ** 2
    w2, w5 = int(0.002 * sr), int(0.005 * sr)
    raw = np.sqrt(np.convolve(x, np.ones(w2) / w2, mode="same"))
    smooth = np.sqrt(np.convolve(x, np.ones(w5) / w5, mode="same"))
    return raw, smooth


def _level_envelope(yg: np.ndarray, sr: int) -> np.ndarray:
    w = int(0.01 * sr)
    return np.sqrt(np.convolve(yg.astype(np.float64) ** 2, np.ones(w) / w, mode="same"))


MIN_FLUX = 0.1


def attack_onsets(
    yg: np.ndarray, sr: int, noise_db: float, click_times: list[float] | None = None
) -> tuple[np.ndarray, list[str]]:
    """Return (onset_times, sources). Source is 'attack', or 'attack_weak' when the
    attack could not be refined (legato notes masked by the previous note's harmonics).
    Click residue left after the band-stop is measured on the first two (count-in)
    clicks, where the protocol says nobody is playing, and suppressed elsewhere."""
    strength = librosa.onset.onset_strength(
        y=yg, sr=sr, hop_length=ONSET_HOP, fmax=GUITAR_BAND_MAX_HZ, max_size=3, lag=2
    )
    # Spectral flux here is a mean of dB increases, so it is roughly level-independent.
    # Log-compress so one attack out of silence doesn't swamp the following legato attacks,
    # and ignore flux below an absolute floor (decay and reverb fluctuations).
    level = _level_envelope(yg, sr)
    lvl_frames = level[np.minimum(np.arange(len(strength)) * ONSET_HOP, len(level) - 1)]
    noise_frames = strength[lvl_frames < 10 ** ((noise_db + 3) / 20)]
    floor = MIN_FLUX
    if len(noise_frames) * ONSET_HOP / sr >= 0.3:
        floor = max(MIN_FLUX, 1.5 * float(np.percentile(noise_frames, 99)))
    env = np.log1p(np.maximum(strength - floor, 0.0) / floor)
    env /= env.max() if env.max() > 0 else 1.0
    frames = librosa.onset.onset_detect(
        onset_envelope=env,
        sr=sr,
        hop_length=ONSET_HOP,
        units="frames",
        wait=int(0.045 * sr / ONSET_HOP),
        delta=0.1,
        pre_max=3,
        post_max=3,
        normalize=False,
    )
    coarse = librosa.frames_to_time(frames, sr=sr, hop_length=ONSET_HOP)
    if click_times is not None and len(click_times) >= 2:
        clicks = np.asarray(click_times)

        def peak_near(t: float) -> float:
            i0, i1 = int((t - 0.01) * sr / ONSET_HOP), int((t + 0.05) * sr / ONSET_HOP) + 1
            return float(strength[max(0, i0) : i1].max(initial=0.0))

        residue = max(peak_near(t) for t in clicks[:2])
        keep = []
        for c in coarse:
            d = c - clicks
            near = np.any((d > -0.01) & (d < 0.05))
            if not near or peak_near(c - 0.02) > max(2.5 * residue, floor):
                keep.append(c)
        coarse = np.array(keep)
    raw, smooth = _attack_envelopes(yg, sr)
    refined = [_refine_onset(raw, smooth, t, sr) for t in coarse]
    lags = [c - r for c, r in zip(coarse, refined) if r is not None]
    lag = float(np.median(lags)) if len(lags) >= 3 else 0.025
    gate = 10 ** ((noise_db + 10) / 20)
    out: dict[float, str] = {}
    for c, r in zip(coarse, refined):
        t, src = (r, "attack") if r is not None else (max(0.0, c - lag), "attack_weak")
        if level[int(t * sr) : int((t + 0.06) * sr)].max(initial=0) >= gate:
            out.setdefault(round(float(t), 4), src)
    times = sorted(out)
    return np.array(times), [out[t] for t in times]


def _refine_onset(raw: np.ndarray, smooth: np.ndarray, t: float, sr: int, min_rise_db: float = 4.0) -> float | None:
    """Move a coarse spectral-flux peak (which lags ~20 ms) back to the attack start:
    find the attack peak, the valley before it, then the 30% rise crossing.
    Returns None when there is no real attack (e.g. a note being cut off)."""
    a, b = int(max(0.0, t - 0.04) * sr), int(min(len(raw), (t + 0.01) * sr))
    if b - a < 8:
        return None
    pk = a + int(np.argmax(smooth[a:b]))
    lo = max(0, pk - int(0.035 * sr))
    mn = lo + int(np.argmin(smooth[lo : pk + 1]))
    base = smooth[mn]
    if smooth[pk] < base * 10 ** (min_rise_db / 20):
        return None
    lvl = base + 0.3 * (raw[pk] - base)
    return (mn + int(np.argmax(raw[mn : pk + 1] >= lvl))) / sr


def pitch_change_onsets(
    pt: PitchTrack, existing: np.ndarray, level: np.ndarray, sr: int, noise_db: float, min_gap: float = 0.06
) -> np.ndarray:
    """Onsets from stable pitch changes with no attack (hammer-ons/pull-offs)."""
    midi = np.where(pt.voiced & (pt.f0 > 0), 69 + 12 * np.log2(np.nan_to_num(pt.f0, nan=1.0) / 440.0), np.nan)
    gate = 10 ** ((noise_db + 15) / 20)
    out = []
    hold = 3
    for i in range(hold, len(midi) - hold):
        if level[min(len(level) - 1, int(pt.times[i] * sr))] < gate:
            continue
        before, after = midi[i - hold : i], midi[i : i + hold]
        if np.isnan(before).any() or np.isnan(after).any():
            continue
        if abs(np.median(after) - np.median(before)) >= 0.8 and np.ptp(after) < 0.5 and np.ptp(before) < 0.5:
            t = float(pt.times[i])
            if (len(existing) == 0 or np.min(np.abs(existing - t)) > min_gap) and (
                not out or t - out[-1] > min_gap
            ):
                out.append(t)
    return np.array(out)


def _refine_midi(yg: np.ndarray, sr: int, a: float, b: float, midi_f: float) -> float:
    """pYIN bins pitch at 10 cents; refine by harmonic-sum search (1-cent steps)."""
    seg = yg[int(a * sr) : int(b * sr)]
    if len(seg) < 1024:
        return midi_f
    n_fft = 1 << 16
    mag = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n_fft))
    logmag = np.log(mag + 1e-9)
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    cands = midi_f + np.arange(-0.6, 0.601, 0.01)
    f0s = librosa.midi_to_hz(cands)
    scores = np.zeros_like(cands)
    for k in range(1, 6):
        fk = k * f0s
        ok = fk < GUITAR_BAND_MAX_HZ
        scores[ok] += np.interp(fk[ok], freqs, logmag) / k
    return float(cands[int(np.argmax(scores))])


def _harmonic_stats(yg: np.ndarray, sr: int, a: float, b: float, f0: float):
    seg = yg[int(a * sr) : int(b * sr)]
    if len(seg) < 512 or not f0 or not np.isfinite(f0):
        return None, None
    n_fft = 1 << int(np.ceil(np.log2(max(len(seg), 2048))))
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n_fft)) ** 2
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    band = (freqs >= 60) & (freqs <= GUITAR_BAND_MAX_HZ)
    harm = np.zeros_like(band)
    k = 1
    while k * f0 <= GUITAR_BAND_MAX_HZ:
        w = max(2.5 * sr / n_fft, 0.03 * k * f0)
        harm |= np.abs(freqs - k * f0) <= w
        k += 1
    total = spec[band].sum() + 1e-20
    harmonicity = float(spec[band & harm].sum() / total)
    hi = spec[(freqs >= 1500) & band].sum()
    hf_ratio_db = float(10 * np.log10(hi / total + 1e-12))
    return harmonicity, hf_ratio_db


def _salience(mag: np.ndarray, freqs: np.ndarray, f0s: np.ndarray, kmax: int = 8) -> np.ndarray:
    out = np.zeros(len(f0s))
    for k in range(1, kmax + 1):
        fk = k * f0s
        ok = fk < GUITAR_BAND_MAX_HZ
        out[ok] += np.interp(fk[ok], freqs, mag) / np.sqrt(k)
    return out


def _second_pitch_ratio(yg: np.ndarray, sr: int, a: float, b: float, f0: float) -> float | None:
    """Polyphony cue: cancel the detected note's harmonics, then measure the strongest
    remaining harmonic series (excluding octave relatives) relative to the note's own."""
    seg = yg[int(a * sr) : int(b * sr)]
    if b - a < 0.12 or not f0:
        return None
    lobe = 2.0 * sr / len(seg)  # Hann main-lobe half width in Hz
    n_fft = 1 << 14
    mag = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n_fft))
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    f0s = librosa.midi_to_hz(np.arange(36.0, 86.0, 0.1))
    main = float(_salience(mag, freqs, np.array([f0]))[0]) + 1e-12
    rest = mag.copy()
    k = 1
    while k * f0 < GUITAR_BAND_MAX_HZ:
        rest[np.abs(freqs - k * f0) < max(lobe, 0.03 * k * f0)] = 0
        k += 1
    s2 = _salience(rest, freqs, f0s)
    rel = f0s / f0
    s2[np.abs(rel - np.round(rel)) < 0.03 * rel] = 0
    s2[np.abs(rel * np.round(1 / rel) - 1) < 0.03] = 0
    return float(s2.max() / main)


def segment_notes(yg: np.ndarray, sr: int, pt: PitchTrack, onsets: np.ndarray, sources: list[str], noise_db: float):
    rms_hop = 128
    rms_db = librosa.amplitude_to_db(
        librosa.feature.rms(y=yg, frame_length=512, hop_length=rms_hop)[0], ref=1.0, amin=1e-10
    )
    rms_t = librosa.times_like(rms_db, sr=sr, hop_length=rms_hop)
    end_of_audio = len(yg) / sr
    notes: list[Note] = []
    for i, on in enumerate(onsets):
        nxt = onsets[i + 1] if i + 1 < len(onsets) else min(end_of_audio, on + 2.0)
        a = on + min(0.04, 0.3 * (nxt - on))
        b = min(nxt - 0.01, on + 0.4)
        sel = (pt.times >= a) & (pt.times <= b)
        voiced = sel & pt.voiced & np.isfinite(pt.f0)
        n_sel = max(int(sel.sum()), 1)
        voiced_ratio = voiced.sum() / n_sel
        midi_f = None
        stability = 0.0
        if voiced.sum() >= 2 and voiced_ratio >= 0.3:
            m = 69 + 12 * np.log2(pt.f0[voiced] / 440.0)
            stability = float(np.std(m))
            midi_f = _refine_midi(yg, sr, a, b, float(np.median(m)))
        pconf = float(voiced_ratio * (np.mean(pt.prob[voiced]) if voiced.any() else 0.0))
        if stability > 0.3:
            pconf *= 0.6

        att = (rms_t >= on) & (rms_t <= on + 0.06)
        attack_db = float(rms_db[att].max()) if att.any() else float("-inf")
        after = (rms_t > on) & (rms_t < nxt)
        floor = max(attack_db - 30.0, noise_db + 6.0)
        quiet = np.nonzero(after & (rms_db < floor))[0]
        offset = float(rms_t[quiet[0]]) if len(quiet) else float(nxt)

        dec = None
        win200 = (rms_t >= on + 0.18) & (rms_t <= on + 0.22)
        if nxt - on >= 0.25 and win200.any() and np.isfinite(attack_db):
            dec = float(attack_db - rms_db[win200].mean())

        f0 = librosa.midi_to_hz(midi_f) if midi_f is not None else None
        harm, hf = _harmonic_stats(yg, sr, a, b, f0) if f0 else (None, None)
        poly = _second_pitch_ratio(yg, sr, a, b, f0) if f0 else None
        midi = int(round(midi_f)) if midi_f is not None else None
        notes.append(
            Note(
                index=i,
                onset_s=float(on),
                offset_s=offset,
                midi_float=midi_f,
                midi=midi,
                name=midi_to_name(midi) if midi is not None else None,
                cents=None if midi_f is None else float((midi_f - midi) * 100),
                pitch_confidence=pconf,
                attack_db=attack_db,
                harmonicity=harm,
                decay_db=dec,
                hf_ratio_db=hf,
                source=sources[i],
                second_pitch_ratio=poly,
            )
        )
    return _merge_repeats(notes)


def _merge_repeats(notes: list[Note]) -> list[Note]:
    """Drop spurious re-triggers: same pitch, tiny gap, no new attack energy."""
    out: list[Note] = []
    for n in notes:
        if out:
            p = out[-1]
            if (
                n.midi is not None
                and n.midi == p.midi
                and n.onset_s - p.onset_s < 0.08
                and n.attack_db < p.attack_db + 1.0
            ):
                p.offset_s = max(p.offset_s, n.offset_s)
                continue
        out.append(n)
    for i, n in enumerate(out):
        n.index = i
    return out


def _is_damping(yg: np.ndarray, sr: int, n: Note, max_rise_db: float = 1.0, drop_db: float = 3.0) -> bool:
    """No attack transient and the level falls: the string is being damped, not picked."""
    if n.attack_rise_db is None or n.attack_rise_db >= max_rise_db:
        return False
    i = int(n.onset_s * sr)
    before = yg[max(0, i - int(0.1 * sr)) : max(0, i - int(0.02 * sr))]
    after = yg[i + int(0.02 * sr) : i + int(0.1 * sr)]
    if not len(before) or not len(after):
        return False
    return 10 * np.log10((np.mean(after**2) + 1e-12) / (np.mean(before**2) + 1e-12)) < -drop_db


def transcribe(
    yg: np.ndarray, sr: int, noise_db: float, click_times: list[float] | None = None
) -> tuple[list[Note], PitchTrack]:
    pt = pitch_track(yg, sr)
    att, att_src = attack_onsets(yg, sr, noise_db, click_times)
    pc = pitch_change_onsets(pt, att, _level_envelope(yg, sr), sr, noise_db)
    onsets = np.concatenate([att, pc])
    sources = att_src + ["pitch_change"] * len(pc)
    order = np.argsort(onsets)
    onsets, sources = onsets[order], [sources[i] for i in order]
    notes = segment_notes(yg, sr, pt, onsets, sources, noise_db)
    _, smooth = _attack_envelopes(yg, sr)
    for n in notes:
        i = int(n.onset_s * sr)
        pre = smooth[max(0, i - int(0.03 * sr)) : i]
        post = smooth[i : i + int(0.02 * sr)]
        if len(pre) and len(post):
            n.attack_rise_db = float(20 * np.log10((post.max() + 1e-12) / (pre.mean() + 1e-12)))
    # Unrefined attacks without a pitch, and damping noise (an unrefined attack, or a
    # repeat of the previous pitch) are mute/release noise rather than notes.
    kept: list[Note] = []
    for n in notes:
        if n.source == "attack_weak" and n.midi is None:
            continue
        repeat = bool(kept) and kept[-1].midi is not None and kept[-1].midi == n.midi
        if (n.source == "attack_weak" or repeat) and _is_damping(yg, sr, n):
            continue
        kept.append(n)
    notes = kept
    for i, n in enumerate(notes):
        n.index = i
        base = n.pitch_confidence if n.midi is not None else 0.2
        n.confidence = round(base * (1.0 if n.source == "attack" else 0.7), 3)
    return notes, pt
