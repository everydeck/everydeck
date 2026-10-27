# everydeck

The packages an app uses to connect to [everydeck](https://everydeck.ai). License: MIT.

| Package | Registry | Folder | Install |
|---|---|---|---|
| `@everydeck/sdk` 0.5.4 | npm | `packages/sdk` | `npm install @everydeck/sdk` |
| `@everydeck/check` 0.3.10 (program `everydeck-scaffold`) | npm | `packages/check` | `npx @everydeck/check@0.3.10 . --out everydeck/app-map.json` |
| `everydeck` 0.5.2 | PyPI | `packages/sdk-python` | `pip install everydeck` |
| `everydeck-check` 0.3.10 | PyPI | `packages/everydeck-check` | `pip install everydeck-check` |

The GitHub Action that keeps everydeck working after every push lives in [everydeck/check](https://github.com/everydeck/check) (`uses: everydeck/check@v1`).

## Releases

Each package is published on its own, by publishing a GitHub release whose tag names the package and its version: `sdk-v<version>`, `check-v<version>`, `py-v<version>` or `py-check-v<version>` (for example `sdk-v0.5.4`). The release runs `.github/workflows/release.yml`: it stops when the tag and the version in the package differ or when the version is already published, runs the public guard on the package folder and on the built files, installs and uses the built package, and publishes it with Trusted Publishing (OIDC, no tokens): npm with provenance, PyPI with attestations. "Run workflow" in the Actions tab does the same as a trial and publishes nothing.

## Where the code comes from

This repository is generated from everydeck's main repository by `scripts/build-public.mjs` (commit 5dc0d5955a22). Change the code there, run the script, commit the result here.
