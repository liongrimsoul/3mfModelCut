# Contributing to 3mfModelCut

Thank you for helping improve 3mfModelCut.

## Before opening a pull request

1. Fork the repository and create a focused branch.
2. Keep model processing local to the browser. Do not add model uploads,
   analytics, or external storage without a clear opt-in design.
3. Add or update tests for parser, geometry, or export behavior.
4. Run the full validation suite:

   ```bash
   pnpm test
   ```

5. Explain what changed, why it is useful, and which model types you tested.

## Test models

Only commit model files that you created or have permission to redistribute.
Prefer small fixtures that reproduce one specific behavior. Remove personal
metadata before submitting a model.

## Geometry changes

Changes to splitting, caps, connectors, or export should verify that:

- selected and remaining pieces are both closed;
- the selected geometry is removed from the remaining body;
- material and color assignments remain correct;
- exports can be parsed again;
- the original input model is not mutated.

## Reporting a bug

Include the browser and operating system, the source application or slicer that
created the file, the expected result, and the exact error shown by the editor.
If the model cannot be shared publicly, provide a small substitute that
reproduces the same issue.
