# everydeck-check

The everydeck check for app repositories. It validates `everydeck/app-map.json` with everydeck's own rules, finds everydeck calls that went missing from the code, re-anchors places that moved and publishes the facts to everydeck. It never sends code.

```bash
pip install everydeck-check
everydeck-check validate everydeck/app-map.json --repo .
```

Commands:

- The app map is `everydeck/app-map.json`; without a path the commands read it there (an earlier setup's `everydeck/everydeck-befund.json` is still read).
- `validate <app_map> [--repo .]`: the check everydeck runs when an app map is submitted (shape, references, result signal, derived manifest), plus building blocks of the repository that must appear in `coverage[]`.
- `drift <app_map> --repo . [--freeze]`: is every everydeck call still in the code (against `everydeck-manifest.lock.json`); `--freeze` writes the lock file.
- `reanchor <app_map> --repo .`: moves every place of the app map from its commit to HEAD (git diff, text, symbol); nothing is guessed, unresolved places are listed.
- `reads <app_map>`: the cross-check of display locations.
- `footprint --base <commit before the setup> [--fix-lock]`: the files the setup added and changed, a lockfile rewritten beyond the new packages (`--fix-lock` restores it with only the new packages) and leftovers such as `.playwright-mcp/` or screenshots.
- `publish <app_map> --url <everydeck> --project <id>` and `change`: send the facts to everydeck.

everydeck's rules ship inside the package (`everydeck_check/rules/everydeck-rules.mjs`) and run with `node` (18 or newer). Python 3.11 or newer. License: MIT.
