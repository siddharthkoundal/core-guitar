"""Analysis thresholds.

Every number here is a starting value, NOT a validated accuracy figure.
M0 exists to replace these with values measured on real recordings
(`coreguitar evaluate`). Change them in one place.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class Thresholds:
    # --- input quality ---
    min_duration_s: float = 2.0
    silence_dbfs: float = -55.0
    clip_level: float = 0.99
    clip_fraction_reject: float = 0.0005
    snr_reject_db: float = 15.0
    snr_degraded_db: float = 25.0
    degraded_confidence_factor: float = 0.7

    # --- unsupported-input heuristics (placeholders; tune in M0) ---
    polyphony_harmonicity_max: float = 0.55
    polyphony_second_pitch_min: float = 0.35
    # Attacks rising less than this (800-3000 Hz band) had unreliable onset times on synthetic tests.
    reliable_attack_rise_db: float = 6.0
    distortion_decay_db_max: float = 1.5
    distortion_hf_ratio_db_min: float = -12.0
    min_pitched_note_fraction: float = 0.5

    # --- timing ---
    timing_tolerance_ms: float = 20.0
    # Measurement uncertainty of the onset/click pipeline itself. Placeholder
    # until M0 measures it; deviations within tolerance+uncertainty are low confidence.
    timing_uncertainty_ms: float = 10.0
    drift_min_r2: float = 0.5
    drift_min_notes: int = 6
    min_reliable_ioi_s: float = 0.09

    # --- pitch ---
    tuning_offset_report_cents: float = 15.0
    note_intonation_cents: float = 25.0

    # --- dynamics / articulation ---
    attack_weak_db: float = 6.0
    attack_spread_db: float = 3.0
    cut_short_fraction: float = 0.5

    # --- experimental detectors (always capped confidence) ---
    experimental_confidence_cap: float = 0.4
    ringing_rel_db: float = -10.0
    buzz_excess_db: float = 6.0

    # --- prioritisation ---
    max_priorities: int = 3
    min_priority_confidence: float = 0.5

    def to_dict(self) -> dict:
        return asdict(self)


DEFAULT = Thresholds()

# Analysis sample rate and hop sizes.
SR = 22050
ONSET_HOP = 128
PITCH_HOP = 256
PITCH_FRAME = 2048
GUITAR_FMIN = 65.0
GUITAR_FMAX = 1400.0
GUITAR_BAND_MAX_HZ = 3000.0

# Click track contract (shared by generator and detector).
CLICK_FREQ_HZ = 4000.0
CLICK_DUR_S = 0.025
CLICK_BAND = (3400.0, 4600.0)
LEAD_SILENCE_S = 2.0
TAIL_S = 1.5
