# everydeck

The packages an app uses to connect to [everydeck](https://everydeck.ai). License: MIT.

| Package | Registry | Folder | Install |
|---|---|---|---|
| `@everydeck/sdk` 0.4.4 | npm | `packages/sdk` | `npm install @everydeck/sdk` |
| `@everydeck/check` 0.3.1 (program `everydeck-scaffold`) | npm | `packages/check` | `npx @everydeck/check@0.3.1 . --out everydeck/app-map.json` |
| `everydeck` 0.4.1 | PyPI | `packages/sdk-python` | `pip install everydeck` |
| `everydeck-check` 0.3.1 | PyPI | `packages/everydeck-check` | `pip install everydeck-check` |

The GitHub Action that keeps everydeck working after every push lives in [everydeck/check](https://github.com/everydeck/check) (`uses: everydeck/check@v1`).

## Releases

A tag `v*` runs `.github/workflows/release.yml`: it builds the four packages and publishes them with Trusted Publishing (OIDC, no tokens), npm with provenance, PyPI with attestations. Versions that are already published are skipped.

## Where the code comes from

This repository is generated from everydeck's main repository by `scripts/build-public.mjs` (commit c6bc6a2ce976). Change the code there, run the script, commit the result here.
