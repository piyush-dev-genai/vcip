"""Where the analysis package is allowed to touch the outside world.

T29 kept infrastructure out of `app/providers` entirely. `app/analysis` cannot
do that — ingesting frames is the job — so the rule here is narrower and just
as load-bearing: **each outside dependency lives in exactly one module.**

`livekit.rtc` in `livekit_source.py` alone is what makes D23 a decision about
ingest rather than a decision about the pipeline; the browser-side fallback
D23 describes would replace that one file. `httpx` in `http_publisher.py` alone
is what lets the loop, the schedule and the payload be tested without a network
stack — and it is why `test_analysis_run.py` can drive a whole call's analysis
in milliseconds.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ANALYSIS_DIR = Path(__file__).resolve().parent.parent / "app" / "analysis"

#: Modules permitted to import the LiveKit SDK, and the HTTP client.
LIVEKIT_OWNER = "livekit_source.py"
HTTP_OWNER = "http_publisher.py"

#: Never, anywhere in this service: it holds no business state (§5, D1/D2).
FORBIDDEN_EVERYWHERE = (
    "redis",
    "psycopg",
    "psycopg2",
    "asyncpg",
    "sqlalchemy",
    "boto3",
)


def modules() -> list[Path]:
    found = sorted(ANALYSIS_DIR.glob("*.py"))
    assert found, f"no analysis modules under {ANALYSIS_DIR}"
    return found


def top_level_imports(source: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


@pytest.mark.parametrize("module", modules(), ids=lambda path: path.name)
def test_only_one_module_knows_about_livekit(module: Path) -> None:
    if module.name == LIVEKIT_OWNER:
        assert "livekit" in top_level_imports(module), "the ingest adapter should import the SDK"
        return

    assert "livekit" not in top_level_imports(module), (
        f"{module.name} imports the LiveKit SDK; D23's ingest choice belongs in {LIVEKIT_OWNER}"
    )


@pytest.mark.parametrize("module", modules(), ids=lambda path: path.name)
def test_only_one_module_speaks_http(module: Path) -> None:
    if module.name == HTTP_OWNER:
        assert "httpx" in top_level_imports(module)
        return

    assert "httpx" not in top_level_imports(module), (
        f"{module.name} imports httpx; delivery belongs in {HTTP_OWNER}"
    )


@pytest.mark.parametrize("module", modules(), ids=lambda path: path.name)
def test_no_module_touches_business_state(module: Path) -> None:
    """The AI service holds no database and no Redis credentials (§5)."""
    banned = top_level_imports(module) & set(FORBIDDEN_EVERYWHERE)

    assert not banned, f"{module.name} imports {sorted(banned)}"


def test_the_analysis_package_imports_without_the_livekit_sdk() -> None:
    """`app.analysis` is importable for its logic alone.

    The package deliberately does not re-export `LiveKitFrameSource`: the
    wiring in `main.py` imports the adapter directly, so nothing that only
    needs the loop pays for the SDK.
    """
    import app.analysis as analysis

    assert "LiveKitFrameSource" not in analysis.__all__
    assert "livekit" not in top_level_imports(ANALYSIS_DIR / "__init__.py")


def test_the_providers_stay_free_of_all_of_it() -> None:
    """T29's rule is unchanged by T30: the provider layer imports none of this."""
    providers_dir = ANALYSIS_DIR.parent / "providers"

    for module in sorted(providers_dir.glob("*.py")):
        imports = top_level_imports(module)
        assert "livekit" not in imports
        assert "httpx" not in imports
