# everydeck-check

The everydeck check for app repositories. It validates `everydeck/everydeck-befund.json` with everydeck's own rules, finds everydeck calls that went missing from the code, re-anchors places that moved and publishes the facts to everydeck. It never sends code.

```bash
pip install everydeck-check
everydeck-check validate everydeck/everydeck-befund.json --repo .
```

Commands:

- `validate <befund> [--repo .]`: the check everydeck runs when a Befund is submitted (shape, references, result signal, derived manifest), plus building blocks of the repository that must appear in `coverage[]`.
- `drift <befund> --repo . [--freeze]`: is every everydeck call still in the code (against `everydeck-manifest.lock.json`); `--freeze` writes the lock file.
- `reanchor <befund> --repo .`: moves every place of the Befund from its commit to HEAD (git diff, text, symbol); nothing is guessed, unresolved places are listed.
- `reads <befund>`: the cross-check of display locations.
- `publish <befund> --url <everydeck> --project <id>` and `change`: send the facts to everydeck.

everydeck's rules ship inside the package (`everydeck_check/rules/everydeck-rules.mjs`) and run with `node` (18 or newer). Python 3.11 or newer. License: MIT.
