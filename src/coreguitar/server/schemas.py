"""Strict request models; analysis thresholds are never a client option."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

Bpm = Annotated[float, Field(ge=30, le=240, allow_inf_nan=False)]
Tuning = Literal["standard", "drop_d", "half_step_down"]
ExerciseId = Annotated[str, Field(pattern=r"^[a-z0-9_]+$", max_length=100)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CustomExercise(StrictModel):
    notes: str = Field(min_length=1, max_length=10000)
    bpm: Bpm = 80
    tuning: Tuning = "standard"
    time_signature: tuple[Annotated[int, Field(ge=1, le=16)], Literal[1, 2, 4, 8, 16]] = (4, 4)
    default_duration: str = Field(default="8", pattern=r"^(1|2|4|8|16|32)(\.|t)?$")

    def build(self):
        from ..reference import build_exercise

        return build_exercise(**self.model_dump())


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

    @model_validator(mode="after")
    def valid_mode(self):
        count = int(self.exercise_id is not None) + int(self.custom_exercise is not None)
        if self.mode == "reference" and count != 1:
            raise ValueError("Reference mode requires exactly one exercise.")
        if self.mode == "free" and count:
            raise ValueError("Free mode does not accept a reference exercise.")
        return self
