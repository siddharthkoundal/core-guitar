"""Curated mapping: finding type -> possible causes (hypotheses) and a short drill.

Causes are NOT measured. Audio can show *what* happened, not *why*; these are
common explanations for a player about one year in, offered for the player to
check. Keep entries short and concrete.
"""

from __future__ import annotations

KNOWLEDGE: dict[str, dict] = {
    "transposition": {
        "title": "Everything is shifted by the same interval",
        "causes": [
            "The guitar's tuning doesn't match the selected tuning (e.g. tuned half-step down but 'standard' selected).",
            "Playing the pattern in a different fret position than the reference.",
        ],
        "drill": "Check the tuning with a tuner, select the matching tuning in the exercise, and re-record.",
    },
    "tuning_offset": {
        "title": "Guitar is out of tune",
        "causes": ["Strings have drifted since the last tuning (common with new strings or temperature changes)."],
        "drill": "Tune every string with a tuner (A = 440 Hz) right before recording, then re-check the low E after tuning the others.",
    },
    "wrong_note": {
        "title": "Wrong notes",
        "causes": [
            "Finger landing one fret off during a position or string change.",
            "Pick hitting the neighbouring string.",
        ],
        "drill": "Isolate the two notes around the error. Play the change slowly 5 times: look, place the finger, then pick. Then 5 times without looking.",
    },
    "missed_note": {
        "title": "Notes that didn't sound",
        "causes": [
            "Pick passed over the string without catching it.",
            "Fretting finger not pressing fully, or muting the string.",
        ],
        "drill": "Loop the 3-4 notes around the gap at 60% tempo. Aim for every note to be clearly heard before speeding up.",
    },
    "extra_note": {
        "title": "Extra notes",
        "causes": [
            "Accidentally catching an adjacent string.",
            "Double-picking (pick bouncing on the string).",
        ],
        "drill": "Play the passage slowly with small pick movements, resting the pick hand lightly on the bridge to steady it.",
    },
    "muted_note": {
        "title": "Notes with no clear pitch (muted or dead)",
        "causes": [
            "Fretting finger too far from the fret or not pressing hard enough.",
            "Finger underside touching the string so it's muted.",
        ],
        "drill": "Fret the note just behind the fret wire on your fingertip, pick it 4 times, and check that every repetition rings clearly.",
    },
    "timing_late": {
        "title": "Notes landing behind the beat",
        "causes": [
            "The next fretting finger isn't ready, so the pick waits for it (common at string or position changes).",
            "Hesitating on a stretch.",
        ],
        "drill": "Loop from one beat before the late spot at 70% of target tempo, saying the count out loud. After 5 clean reps, add 5 BPM.",
    },
    "timing_early": {
        "title": "Notes landing ahead of the beat",
        "causes": ["Anticipating the next note, often from tension in the picking hand."],
        "drill": "At 70% tempo, try to make the note cover the click so you can't hear it. Relax the picking hand between notes.",
    },
    "timing_offset": {
        "title": "Consistently ahead of or behind the click",
        "causes": [
            "Reacting to the click instead of anticipating it (late), or rushing into each beat (early).",
            "If every note is off by the same amount, check that the click isn't coming through Bluetooth headphones (they add delay).",
        ],
        "drill": "Play only the first note of each beat with the click at 60 BPM for one minute, aiming to make the click disappear under the note.",
    },
    "timing_drift_rushing": {
        "title": "Speeding up through the take",
        "causes": ["Tension building through the passage, or not feeling the subdivisions."],
        "drill": "Set the click 10 BPM slower and play the exercise twice without stopping. Count the subdivisions ('1-and-2-and') quietly.",
    },
    "timing_drift_dragging": {
        "title": "Slowing down through the take",
        "causes": ["The passage gets harder towards the end (stretches, string changes), so each note takes slightly longer."],
        "drill": "Practise the second half on its own at 70% tempo, then join it to the first half.",
    },
    "intonation": {
        "title": "Notes sharp or flat within the note",
        "causes": [
            "Pressing too hard or pushing the string sideways (sharp).",
            "Guitar intonation or tuning (if the same strings are always off).",
        ],
        "drill": "Play the note while watching a tuner and use just enough pressure for a clean sound, keeping the finger straight down.",
    },
    "uneven_attacks": {
        "title": "Uneven note volume",
        "causes": [
            "Upstrokes weaker than downstrokes.",
            "Pick depth into the string changing from note to note.",
        ],
        "drill": "Alternate pick a single open string as eighth notes at 60 BPM for 1 minute, listening for identical volume on every note. Then repeat on the exercise.",
    },
    "weak_attack": {
        "title": "Some notes much quieter than the rest",
        "causes": ["Pick barely catching the string, often on upstrokes or string changes."],
        "drill": "Loop the quiet notes slowly with a consistent pick depth (just the tip of the pick into the string).",
    },
    "cut_short": {
        "title": "Notes cut short",
        "causes": ["Lifting the fretting finger before the next note is played."],
        "drill": "At 60% tempo, keep each finger down until the next note sounds, letting each note ring for its full length.",
    },
    "possible_ringing": {
        "title": "Possible unwanted ringing (experimental)",
        "causes": [
            "The previous note or an open string keeps sounding.",
            "Fretting-hand fingers not lightly touching unused strings.",
        ],
        "drill": "After each note, release finger pressure (keep the finger touching the string) to stop it. Rest the pick-hand palm lightly on the lower strings.",
    },
    "possible_buzz": {
        "title": "Possible fret buzz (experimental)",
        "causes": [
            "Fretting finger too far behind the fret, or too little pressure.",
            "Guitar setup (low action) if it happens on the same fret every time.",
        ],
        "drill": "Place the fingertip just behind the fret and slowly increase pressure until the buzz stops. Remember that minimum clean pressure.",
    },
}


def advice_for(finding_type: str) -> dict:
    return KNOWLEDGE.get(finding_type, {"title": finding_type, "causes": [], "drill": ""})
