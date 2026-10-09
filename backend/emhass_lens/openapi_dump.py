"""Write the API's OpenAPI schema (for the frontend's generated TypeScript types).

uv run python -m emhass_lens.openapi_dump ../frontend/src/api/openapi.json
"""

import json
import sys
from pathlib import Path

from emhass_lens.app import create_app
from emhass_lens.bootstrap import Bootstrap


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("openapi.json")
    app = create_app(Bootstrap(version="schema", data_dir=Path("/nonexistent"), static_dir=None))
    schema = app.openapi()
    schema["info"]["version"] = "schema"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(schema, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
