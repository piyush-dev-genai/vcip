"""What the provider layer is allowed to depend on.

T29's constraint is not stylistic. The provider layer is the part of the AI
service that a vendor implementation replaces, and it is the part T30 wires to
LiveKit. If frame decoding, Redis, or an HTTP client leaks in here, the seam
stops being a seam: the mocks become untestable without infrastructure, and
"AI is off the video critical path" (D6) becomes something we assert rather
than something the code shape enforces.

An allowlist rather than a denylist, because the next forbidden dependency is
the one nobody thought to ban.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

PROVIDERS_DIR = Path(__file__).resolve().parent.parent / "app" / "providers"

ALLOWED_IMPORTS = {
    "__future__",
    "collections",
    "dataclasses",
    "enum",
    "hashlib",
    "os",
    "pathlib",
    "re",
    "typing",
}

FORBIDDEN = (
    "livekit",
    "numpy",
    "redis",
    "psycopg",
    "psycopg2",
    "asyncpg",
    "sqlalchemy",
    "httpx",
    "requests",
    "aiohttp",
    "urllib",
    "http",
    "fastapi",
    "starlette",
    "pydantic",
)


def modules() -> list[Path]:
    found = sorted(PROVIDERS_DIR.glob("*.py"))
    assert found, f"no provider modules under {PROVIDERS_DIR}"
    return found


def top_level_imports(source: Path) -> set[str]:
    """Every third-party or stdlib module the file imports, relative ones excluded."""
    names: set[str] = set()
    for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


@pytest.mark.parametrize("module", modules(), ids=lambda path: path.name)
def test_imports_only_the_standard_library_it_needs(module: Path) -> None:
    unexpected = top_level_imports(module) - ALLOWED_IMPORTS

    assert not unexpected, f"{module.name} imports {sorted(unexpected)}"


@pytest.mark.parametrize("module", modules(), ids=lambda path: path.name)
def test_imports_no_infrastructure(module: Path) -> None:
    banned = top_level_imports(module) & set(FORBIDDEN)

    assert not banned, f"{module.name} imports {sorted(banned)}"


def test_the_layer_does_not_import_the_web_application() -> None:
    """Dependency runs one way: main imports providers, never the reverse."""
    for source in modules():
        text = source.read_text(encoding="utf-8")
        assert "from app.main" not in text
        assert "import app.main" not in text


def test_the_providers_import_without_any_dependency_installed() -> None:
    """A vendor swapping in an implementation gets a package that stands alone."""
    import app.providers as layer

    assert layer.__all__
