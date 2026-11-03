"""Strict request models; analysis thresholds are never a client option."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

Bpm = Annotated[float, Field(ge=30, le=240, allow_inf_nan=False)]
Tuning = Literal["standard", "drop_d", "half_step_down"]
ExerciseId = Annotated[str, Field(pattern=r"^[a-z0-9_]+$", max_length=100)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CoachMessage(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(strict=True, min_length=1, max_length=12000, pattern=r"\S")


class CoachRequest(StrictModel):
    kind: Literal["plan", "progression"]
    prompt: str = Field(strict=True, min_length=1, max_length=4000, pattern=r"\S")
    level: Literal["beginner", "intermediate", "advanced"]
    context: str = Field(strict=True, max_length=8000)
    messages: list[CoachMessage] = Field(default_factory=list, max_length=12)


class CustomExercise(StrictModel):
    notes: str = Field(min_length=1, max_length=10000)
    bpm: Bpm = 80
    tuning: Tuning = "standard"
    time_signature: tuple[Annotated[int, Field(ge=1, le=16)], Literal[1, 2, 4, 8, 16]] = (4, 4)
    default_duration: str = Field(default="8", pattern=r"^(1|2|4|8|16|32)(\.|t)?$")

    def build(self):
        from ..reference import build_exercise

        return build_exercise(**self.model_dump())


class GuitarProImport(StrictModel):
    track: Annotated[int, Field(ge=0, le=255)] | None = None
    start: Annotated[int, Field(ge=1, le=10000)] = 1
    end: Annotated[int, Field(ge=1, le=10000)] | None = None
    tempo_percent: Annotated[int, Field(ge=25, le=200)] = 100


class ClickRequest(StrictModel):
    exercise_id: ExerciseId | None = None
    custom: CustomExercise | None = None
    bpm: Bpm | None = None

    @model_validator(mode="after")
    def one_exercise(self):
        if (self.exercise_id is None) == (self.custom is None):
            raise ValueError("Provide exactly one of exercise_id or custom.")
        return self


class TakeMeta(StrictModel):
    source: Literal["recording", "upload"]
    client_mime: str = Field(default="", max_length=200)
    original_name: str = Field(default="", max_length=1000)
    track_settings: dict[str, JsonValue] = Field(default_factory=dict)
    interrupted: bool = False


class AnalysisRequest(StrictModel):
    mode: Literal["reference", "free"]
    exercise_id: ExerciseId | None = None
    custom_exercise: CustomExercise | None = None
    bpm: Bpm | None = None
    tuning: Tuning | None = None
    input_profile: Literal["mic", "direct"] = "mic"
    # Seconds from the first recorded sample to the first click, measured on the browser audio clock.
    click_offset_s: Annotated[float, Field(ge=0, le=60, allow_inf_nan=False)] | None = None

    @model_validator(mode="after")
    def valid_mode(self):
        count = int(self.exercise_id is not None) + int(self.custom_exercise is not None)
        if self.mode == "reference" and count != 1:
            raise ValueError("Reference mode requires exactly one exercise.")
        if self.mode == "free" and count:
            raise ValueError("Free mode does not accept a reference exercise.")
        if self.click_offset_s is not None and self.mode == "free" and self.bpm is None:
            raise ValueError("A click offset needs a tempo.")
        return self
