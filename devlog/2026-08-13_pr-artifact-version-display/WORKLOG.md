# WORKLOG — PR Artifact Version Display

## Changes
- `.github/workflows/pr-artifact.yml`: Added `id: npm-publish` + `GITHUB_OUTPUT` outputs (`version`, `npm_tag`). Comment step reads `${{ steps.npm-publish.outputs.version }}` and displays it.
