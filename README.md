# 3mfModelCut

3mfModelCut is an open-source, browser-based 3D printing editor for separating
3MF and STL models into validated, print-ready parts. It is designed for makers
who need to extract painted regions, add fitted connectors, or make precise
plane and sketch cuts without sending their model files to a server.

All model processing happens locally in a Web Worker inside the browser. Model
files are never uploaded or stored by the application.

## What it can do

- **Split by color:** Select an individual connected painted region and remove
  it from the original body as a separate, closed solid.
- **Patch and interlocking cuts:** Create either a recessed fitted interface or
  a stepped interlocking edge.
- **Automatic connectors:** Add triangular, cylindrical, or rectangular
  plugs and sockets with configurable side, count, area, depth, and tolerance.
- **Plane and sketch cuts:** Slice with an adjustable plane or draw a custom
  cut line.
- **Preserve model data:** Keep 3MF colors and supported slicer settings when
  exporting.
- **Validate before download:** Check both generated pieces for closed,
  printable geometry and block unsafe exports.
- **Work privately:** Parse, edit, validate, and export entirely on the user's
  device.

## Why this project is open source

3MF files and painted meshes vary widely between slicers and modeling tools.
This project is public so the 3D-printing community can test more models,
improve geometry handling, add new connector styles, support more 3MF
extensions, and explore better cutting workflows.

Ideas and pull requests are welcome.

## Run locally

Requirements:

- Node.js 22.13 or newer
- pnpm 11

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

## Validate a change

```bash
pnpm test
```

The test command runs TypeScript checks, geometry unit tests, a production
build, and server-rendered page checks.

## Project structure

- `app/` — React editor interface and Three.js viewport
- `lib/mesh-core.ts` — 3MF/STL parsing, mesh splitting, validation, and export
- `workers/model.worker.ts` — local background model processing
- `tests/` — parser, geometry, export, and rendered-page tests
- `worker/` and `build/` — production runtime integration

## Good areas for contributions

- More robust handling of damaged or non-manifold source meshes
- Additional 3MF production and slicer-extension compatibility
- Interactive connector placement and previews
- New joint and connector geometries
- Faster processing for very large models
- Improved cutting controls and keyboard accessibility
- More real-world fixture files and regression tests

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Safety limits

The editor currently limits input to 50 MB, expanded 3MF archives to 250 MB,
and models to 1.5 million triangles. These limits protect the browser from
malformed or unexpectedly large local files.

## License

3mfModelCut is available under the [MIT License](LICENSE).
