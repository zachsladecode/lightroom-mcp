# Lightroom MCP + RAW Culling & Color Grading Skill v2

This fork combines Lightroom MCP with the complete `raw-photo-lightroom-preset` v2 skill in a single repository, covering:

- RAW/JPG pairing and culling;
- Grouping by lighting scenario;
- Reading the actual settings of past Lightroom presets;
- Small, incremental adjustments with preview output and comparison;
- Creating preset checkpoints that never overwrite older versions;
- Exporting Lightroom-generated preset files;
- A safe XMP fallback for when MCP is unavailable.

The upstream project remains [`Automaat/lightroom-mcp`](https://github.com/Automaat/lightroom-mcp). Using a fork instead of an unrelated repository preserves the original commit history, the MIT license, and the ability to sync with upstream in the future; locally, it's recommended to keep `origin` pointing at this fork and `upstream` pointing at the original author.

## Repository contents

```text
plugin/LightroomMCP.lrplugin/       Lightroom Classic Lua plugin
server/                             MCP server and tool contracts
skills/raw-photo-lightroom-preset/ Complete v2 Codex skill
tests/e2e/                          Real-Lightroom verification flow
```

The skill directory contains `SKILL.md`, UI metadata, reference docs for culling/grading/MCP, style data, an XMP generator and its tests; it does not contain user photos, catalogs, tokens, or local absolute paths.

## v2 culling workflow

### 1. Establish source relationships first

Record, for each RAW/preview pair, at minimum the relative path, filename stem, capture time, camera, dimensions, and how the preview was generated. Different folders may share the same filename, so pairing cannot rely on basename alone; items that are missing or conflicting are marked `unclassified` and do not inherit the color conclusions of other JPGs.

Ordinary camera JPGs can be used to judge composition, focus, and expression first; final exposure, white balance, color, and preset direction must be judged from the RAW render in Lightroom/Camera Raw.

### 2. Track three states separately

| Field | Allowed values | Purpose |
|---|---|---|
| `selection_status` | `delivery candidate`, `keep`, `reject`, `pending review` | Composition, focus, expression, and delivery value |
| `edit_status` | `RAW pending review`, `light global adjustment`, `needs local adjustment`, `unknown` | Post-processing workload |
| `style_status` | `classified`, `unclassified` | Whether a reliable color direction has been found |
| `confidence` | `high`, `medium`, `low` | Confidence in the judgment |

Do not map these states to Lightroom star ratings or color labels on your own. If a mapping is needed, have the user define it explicitly first, then treat the mapping as a separate field.

### 3. Group by lighting and purpose

Do not force a single preset onto an entire event. Common groupings include outdoor shade, indoor warm/mixed light, stage lighting, backlight, and high ISO. Pick one representative RAW per group first, and keep difficult outliers separate.

Recommended fields for a culling deliverable:

```text
relative_raw_path, relative_preview_path, selection_status, edit_status,
style_status, lighting_cluster, confidence, notes
```

## Historical color-grading iteration workflow

1. Pick a representative RAW or virtual copy that won't damage the master edit.
2. Read the current metadata/Develop settings and output a baseline JPEG.
3. Use `get_develop_preset` to read an approved historical preset; disambiguate same-named presets by UUID or folder/scope.
4. Make only one small change at a time: technical correction, tonal shape, color correction, creative style, or detail/noise reduction.
5. After each step, export a new preview from Lightroom and actually compare it — don't guess a batch of slider values at once.
6. Use `create_develop_preset` to create a unique, versioned plugin checkpoint.
7. Use `compare_develop_presets` to diff the historical version against the candidate version and keep a record of the setting differences.
8. Only after the representative photo is confirmed, copy the settings to the rest of the same lighting group using an explicit field list.
9. Use `export_develop_preset` to export the accepted checkpoint; if the destination file already exists, the tool refuses to overwrite it.
10. Only claim the preset is compatible and the visual result is correct after importing and checking it in the target Lightroom version.

## New MCP tools added in v0.10.0

| Tool | Function |
|---|---|
| `get_develop_preset` | Reads the UUID, source file, and complete serializable settings of one exact preset |
| `compare_develop_presets` | Produces a setting-by-setting diff between a base and a candidate |
| `create_develop_preset` | Creates a versioned checkpoint from selected fields on a representative photo |
| `export_develop_preset` | Copies a Lightroom preset's backing file, never overwriting an existing one |

The existing `list_develop_presets` and `apply_develop_preset` also support UUID, folder, and scope; `set_develop_settings`, `copy_develop_settings`, and checkpoint creation support the main tone curve as well as RGB point-curve arrays.

Plugin-managed checkpoints created via the Adobe SDK do not appear in the Develop panel. They can still be listed, applied, and exported via MCP; if you need a formal preset that's visible in the panel, export it and import it through the Lightroom UI, or use Create Preset inside Lightroom.

## Windows installation

### 1. Build this fork

```powershell
git clone https://github.com/John-owo/lightroom-mcp.git
Set-Location .\lightroom-mcp
git switch feat/preset-roundtrip
Set-Location .\server
npm ci
npm run build
Set-Location ..
```

### 2. Install the Lightroom plugin

```powershell
node .\server\dist\index.js install-plugin
```

Fully quit and reopen Lightroom Classic, then start the server from **File → Plug-in Manager → Lightroom MCP**.

### 3. Configure Codex MCP

Add the locally built `server/dist/index.js` to your Codex configuration; replace the path below with your actual clone location:

```toml
[mcp_servers.lightroom]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\path\to\lightroom-mcp\server\dist\index.js']
startup_timeout_sec = 60
```

Restart Codex so new tasks load the 18 tools.

### 4. Install the v2 skill

If you already have a skill with the same name, back it up first. Then, from the repository root:

```powershell
$skillSource = Resolve-Path '.\skills\raw-photo-lightroom-preset'
$skillTarget = Join-Path $env:USERPROFILE '.codex\skills\raw-photo-lightroom-preset'
New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
Copy-Item -Path "$skillSource\*" -Destination $skillTarget -Recurse -Force
```

After restarting Codex, you can use:

```text
Use $raw-photo-lightroom-preset to help me cull this batch of RAWs, first splitting
delivery candidates from pending review, then grouping by lighting. Read my approved
historical presets, make only small adjustments on representative photos, output a
comparison each round, and create versioned checkpoints that never overwrite.
```

## Safety boundaries

- Never move, rename, delete, or overwrite original photos.
- Never test on an unapproved master edit.
- Never declare color or a preset "done" based on camera JPGs alone.
- Never silently copy crop, white balance, profile, lens, or detail settings across a whole batch.
- MCP has no virtual copies, snapshots, undo, or full local tools; when masking, healing, AI Denoise, Calibration, Color Grading, or Point Color is needed, hand it back to Lightroom to finish manually.
- The backing format of an MCP checkpoint is determined by Lightroom; a built-in preset with no backing file cannot be exported.

## Verified scope

- TypeScript: 13 suites, 160 tests passing.
- Lua `HandlerDevelop`: 28 behavior tests passing; Selene reports 0 errors / 0 warnings / 0 parse errors.
- Real Lightroom Classic: creating a checkpoint, reading it back exactly, exporting a `.lrtemplate`, and rejecting a duplicate export while leaving the original file's hash unchanged — 5/5 passing.
- XMP fallback generator: 14 tests passing, with extension, sidecar, overwrite, atomic-write, schema, and range protections.

Real-machine testing did not re-import an exported `.lrtemplate` through the Lightroom UI, so "target-Lightroom import compatibility" and "visual style correctness" are not listed as passed — those must be confirmed with real photos and user sign-off.

## Further documentation

- [v2 skill main flow](skills/raw-photo-lightroom-preset/SKILL.md)
- [Culling, grouping, and the five-stage grading process](skills/raw-photo-lightroom-preset/references/workflow.md)
- [Style library](skills/raw-photo-lightroom-preset/references/style-library.md)
- [Lightroom MCP boundaries and closed loop](skills/raw-photo-lightroom-preset/references/lightroom-mcp.md)
- [Traditional Chinese README](README.md)

Licensed under the repository's [MIT License](LICENSE).
