"""Function-image validator pins from uv.lock; contract tests enforce parity.

Update with the transitive FastAPI/Pydantic dependency closure when refreshing
the lock. Python source is bundled alongside app.py in the receiver image.
"""

RECEIVER_VALIDATOR_REQUIREMENTS = (
    "annotated-doc==0.0.4",
    "annotated-types==0.7.0",
    "anyio==4.14.2",
    "fastapi==0.136.3",
    "idna==3.19",
    "pydantic==2.12.5",
    "pydantic-core==2.41.5",
    "starlette==1.3.1",
    "typing-extensions==4.15.0",
    "typing-inspection==0.4.2",
)
