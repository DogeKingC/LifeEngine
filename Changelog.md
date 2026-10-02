# Changelog

## 1.0.6 (ongoing)

### UI Enhancements:
- Added ability to change species name via UI

### Simulation Enhancements:
- Performance: roughly 1.5x faster simulation ticks (identical results for the same RNG sequence) by caching rotated
  body offsets, skipping passive cells, and replacing an O(n^2) organism-removal loop
- Performance: "MAX" speed now runs batches of ticks per timer callback instead of being capped at ~250 ticks/sec by
  browser timer clamping
- Performance: rendering is decoupled from simulation (once per display frame via requestAnimationFrame) and batched
  by cell color, cutting canvas fillStyle changes by ~100x
- Stats text panel refreshes 4x/sec instead of every frame
- Fixed stats chart intervals stacking when reopening the stats tab
- Added headless benchmark (`npm run bench`)

### Simulation Engine Rewrite:
- The simulation now runs in a Web Worker, so drawing and input never slow it down and the page stays at 60 fps even
  when the simulation is saturated. The worker is embedded in bundle.js (still a single script to deploy) and also
  runs when the page is opened from file://; if a worker can't start, the simulation falls back to the main thread
- New data-oriented core (`src/Sim`): typed-array grid and shared immutable genomes. 1.3-3.4x faster per tick than the
  previous version in Node; at MAX speed in the browser, roughly 5-11x more ticks/sec on the default and Food Chain
  worlds and ~1.7x on the 15k-organism battleground world
- Proven identical to the previous implementation: `npm test` runs both on the same seed and compares the final state
- Renderer draws only cells that changed between snapshots
- World saves are produced in the worker and downloaded as a Blob (large worlds no longer go through a data: URL)
- Fixed stats charts hanging (infinite loop) when the chart's last tick wasn't in the record, and crashing on an empty record

### Simulation Accuracy:
- Eyes/brains only act on what was seen this tick. Previously sightings piled up while the brain was being ignored
  (and forever on non-moving organisms with eyes) and stale ones could drive later decisions
- "Nothing seen" no longer counts as a sighting at max range that could mask a real one
- An organism can no longer die twice (with one touch kill, killer-vs-killer hits double-counted deaths and drove
  species populations negative)
- Species populations are recounted from the organisms when loading a world (fixes "fossilize non existing species")
- Numeric evolution controls are parsed as numbers (several were stored as strings, e.g. look range + 1 = "201")
- Clearing organisms resets the average mutation statistic
- Random organism generator: fixed missing cell on the right edge of each layer and early stop logic

### New Cell Types:
- Leaf: photosynthesis, chance each tick to feed its organism directly (no food on the grid, no mouth needed)
- Spike: killer cells that damage it take 1 damage back
- Booster: movers with a booster move 2 cells per tick
- Poison: organisms with poison leave no food when they die
- Healer: chance each tick to repair 1 damage (configurable)
- Camo: organism becomes invisible to other organisms' eyes
- Both can be disabled in Evolution Controls; old worlds load with them disabled

### New Content:
- Organisms: Ghost (camouflaged, self-healing predator), Cactus (leaf plant with spikes), Hornet (fast poisonous predator)
- Organisms: Thornbush, Coral (plants), Grazer (food-seeking herbivore), Shark (eyed predator)
- World: Food Chain (plants, grazers and sharks in three wall-separated regions)

## 1.0.5 (4/23/2023)

### UI Enhancements:
- Improved "Community Creations" list panel
- Added Mod list to Community Creations
- Added brush size slider
- Added unnatural organism warning

### Simulation Enhancements:
- Added links to community mods
- Added more worlds and organisms to community creations

## 1.0.4 (9/17/2022)

### UI Enhancements:
- Added "Community Creations" button
- Updated icons
- Standardized Colors

### Simulation Enhancements:
- Added ability to load premade organisms and worlds from backend
- Added SeeThroughSelf param that allows eyes to see through their own cells

### Bug Fixes:
- Mutation rate now properly saves and loads with world


## 1.0.3 (4/15/2022)

### UI Enhancements:
- Improved styling

### Simulation Enhancements:
- Added ability to save/load organisms
- Added ability to save/load worlds

### Bug Fixes:
- charste changed to charset
- Fixed species tracking


Thanks to contributors: @TerraMaster85

## 1.0.2 (12/21/2021)

### UI Enhancements:
- New tab "World Controls"
    - Relocated grid controls and auto reset to this tab
    - Button to generate random walls with perlin noise
    - Button to reset the environment with many randomly generated organisms
    - Option to not clear walls on reset
    - Option to pause on total extinction
- "Simulation controls" tab renamed to "Evolution Controls"
- Button to save/load Evolution Controls in a `.json` file
- Button to randomize the organism in the editor window
- Can now use drag view tool while rendering is off
- Reorganized "About" tab and left panel, embedded explanation video

### Simulation Enhancements:
- New evolution control `Extra Mover Reproduction Cost`, which adds additional food cost for movers to reproduce
- Combined `Movers can rotate` and `Offspring rotate` evolution controls into `Rotation enabled`
- Fully max out simulation speed when slider is all the way to the right

### Bug Fixes:
- Armor is no longer ignored when checking for clear reproduction space
- Chart data is now properly loaded/discarded when paused


Thanks to contributors: @Chrispykins @M4YX0R

## 1.0.1 (12/4/2021)

### UI Enhancements:
- Hotkeys/improved zoom controls: [#47](https://github.com/MaxRobinsonTheGreat/LifeEngine/pull/47)
  - `A` reset view
  - `S/middle mouse button` pan
  - `D` drop walls
  - `F` drop food
  - `G` click to kill
  - `H` headless rendering toggle
  - `Spacebar/J` pause/play toggle
  - `Z` select organism
  - `X` edit organism
  - `C` drop organism
  - `V` toggle hud
  - `B` destroy all walls
  - `Q` min/max control panel
- Improved mutation probability controls: [#43](https://github.com/MaxRobinsonTheGreat/LifeEngine/pull/43)
- Ability to edit individual organism's mutability: [#46](https://github.com/MaxRobinsonTheGreat/LifeEngine/pull/46)
- Added clear button and improved reset warnings: [#64](https://github.com/MaxRobinsonTheGreat/LifeEngine/pull/64)
- Control Panel is minimized by default: [#64](https://github.com/MaxRobinsonTheGreat/LifeEngine/pull/64)

### Simulation Enhancements:
- Default food prodcution probability increased from 4->5

### Bug Fixes:
- Fixed actual FPS display: [#45](https://github.com/MaxRobinsonTheGreat/LifeEngine/pull/45)
- Fixed slow down/crash on very long runs: [#63](https://github.com/MaxRobinsonTheGreat/LifeEngine/pull/63)
- Spelling Fix: [#31](https://github.com/MaxRobinsonTheGreat/LifeEngine/pull/31)


Thanks to contributors: @TrevorSayre @EvaisaGiac @Chrispykins

## 1.0.0
Initial release.
