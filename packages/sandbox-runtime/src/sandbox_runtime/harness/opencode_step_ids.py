"""Correlate OpenCode step parts across replays within one prompt."""

import uuid
from dataclasses import dataclass, field


@dataclass
class StepIdTracker:
    active: dict[str, str] = field(default_factory=dict)
    finished: dict[str, str] = field(default_factory=dict)
    completed: set[str] = field(default_factory=set)

    def start(self, message_id: str, part_id: str | None) -> str:
        step_id = part_id or str(uuid.uuid4())
        if step_id not in self.completed:
            self.active[message_id] = step_id
        return step_id

    def finish(self, message_id: str, part_id: str | None) -> str:
        cached = self.finished.get(part_id) if part_id else None
        if cached:
            if self.active.get(message_id) == cached:
                self.active.pop(message_id)
            return cached

        step_id = self.active.pop(message_id, None) or part_id or str(uuid.uuid4())
        if part_id:
            self.finished[part_id] = step_id
        self.completed.add(step_id)
        return step_id
