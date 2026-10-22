# Changelog

All notable changes to Blocklands are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-10-22

### Added
- **Farming.**
  - **Tall grass** grows on grass in every world (existing worlds too, wherever the land is still untouched). It sways in the wind, breaks instantly without wearing your tool, and has a 15% chance of dropping **wheat seeds**.
  - **Wooden Hoe and Stone Hoe** (two planks or cobblestone over two sticks). **Use** a hoe on dirt or grass to till it into **farmland**; a tuft of tall grass on top is cleared, and aiming at a tuft tills the soil under it. Each use costs one durability. Only dirt and grass with room above can be tilled.
  - **Moist farmland.** Farmland within **4 blocks of water** (a square around it, water up to 2 blocks below or 1 above) is darker and *moist*; any other farmland is dry. Moisture is rechecked while crops grow, so digging a channel soaks the field.
  - **Wheat.** **Use** wheat seeds on farmland to plant them. Wheat has four stages (seedling to ripe golden ears), 20-40 s per stage (random), only while you are within render distance. On moist farmland it grows at full speed, on dry farmland at 40% speed. Crops are saved with the world.
  - **Harvest:** an unripe plant gives its seed back; ripe wheat gives 1 wheat and 1-2 seeds. Breaking farmland gives dirt and pops the crop off it.
  - **Bread:** three wheat in a row. Eating it restores 5 drumsticks of hunger (10 points) and 12 saturation, more than an apple (2 drumsticks, 6 saturation), and works with the existing eat flow (refused when your hunger is full).
  - Blocks (and saplings) placed while aiming at a tuft of tall grass replace it.
- **Animation.** The top layer of water swells in slow waves, leaves sway, and plants (tall grass, saplings, wheat) bend in the wind, strongest at their tips. It runs in the vertex shader from a per-vertex weight, so there is no per-frame mesh work, neighbouring blocks and chunks move together (nothing tears), and plain terrain stays perfectly still.
- **Landscape on mobile.** Touch devices ask the browser to lock to landscape (Android honours it in fullscreen or when installed; the manifest already says landscape). Where that is not possible (iOS), a portrait screen shows a "Turn your device sideways" card and the game pauses behind it.

### Changed
- The mesher's vertex layout gained a seventh float (the sway weight).

## [0.5.0] - 2026-10-22

### Added
- **Wooden Hammer and Stone Hammer.** Breaking a block with a hammer also breaks the other eight blocks of the 3x3 square around it, in the plane of the face you are looking at (a vertical wall when you face a wall, a flat patch when you look down at the ground). Each block drops its own loot.
  - Recipe: a row of three planks (or cobblestone), then head - stick - head, then a stick centred below. 5 planks or cobblestone and 2 sticks.
  - A hammer harvests stone like a pickaxe of the same material, but mines at **half the speed** and has **twice the durability** (wood 118, stone 262 uses). Every block it breaks wears it by one use, and a hammer that wears out mid-swing stops there.
  - The extra blocks skip water, saplings, logs and planks (those are axe work); dirt, grass, sand, stone, cobblestone and leaves come along.
  - With the maths switch on, only the aimed block can ask a question: neighbours come along only if they are the currently unlocked type, so a hammer cannot get around the questions.
  - New hammer sprites and recipe-book entries; the help screen and README mention hammers.
- **The app updates itself.** It checks for a new version when it opens, when you come back to it after leaving, and once an hour, and reloads into the new version as soon as it takes over, instead of making you open it twice. It never reloads in the middle of a game: an update that arrives while you play waits until you are back on the title screen or leave the app (the world is saved first), and it also waits while the create-world form is open. A reload guard (never twice within 15 seconds) rules out reload loops, and being offline is simply ignored.
- The version number on the title screen is larger, bold and brighter.

## [0.4.0] - 2026-10-21

### Added
- **Grade-1 maths mode.** Mining a block whose type is not the currently *unlocked* type opens a question (addition or subtraction, answers 0 to 20, never negative, never the same sum twice in a row) with a tap number pad (0-9, delete, **OK**) and a **Cancel** button. The keyboard works too (digits, `Enter`, `Backspace`, `Esc`).
  - **Right answer:** that block type becomes the one unlocked type and can be mined without further questions. Only one type is unlocked at a time; asking about another type replaces it.
  - **Cancel:** closes the question, nothing changes (the unlocked type stays). Holding Attack asks only once; release and press again to be asked again.
  - **Wrong answer:** the block is replaced by a lit **TNT** (a flashing block that swells) that explodes after 3 seconds, removing every breakable block in a sphere of radius 3.5 with **no item drops**. Water and the bottom layer of the world are spared; trees whose logs are blown away topple. The explosion also hurts the player a little (up to 3 hearts at point blank, fading out by 5 blocks, never fatal) and pushes them back.
  - A **chip** at the top of the screen shows which block is unlocked ("answer a sum to start" before the first one).
  - Saplings are exempt (they pop off instantly). The unlocked type and burning TNT are saved with each world.
  - New sounds: a chime for a right answer, a buzz for a wrong one, a hissing fuse, and the explosion.
- **Maths switch** in the pause menu (on by default) for turning the questions off.
- TNT block with its own procedural textures.

### Changed
- Death-screen and inventory handling keep the world running while a question is open, so a lit TNT keeps burning.

## [0.3.0] - 2026-10-21

### Added
- **Health.** Ten hearts (20 half-hearts) above the hotbar, with a red flash when you are hurt. At zero you die: everything in your inventory, crafting grid and cursor drops where you fell (it stays for 15 minutes), a "You died!" screen appears, and **Respawn** brings you back at the spawn point with full health and hunger. Quitting while dead keeps you dead.
- **Hunger.** Ten drumsticks. Every 15 seconds of effort costs half a drumstick: mining and chopping, sprinting, swimming and jumping (a jump counts as about 0.75 s). Standing and walking are free. At zero hunger you starve: half a heart every 5 seconds, which can kill you.
- **Sprinting** (hold `Shift`, or push the touch joystick past its ring): 30% faster, wider field of view. It needs at least **three full drumsticks** (6 half-points); below that it is refused with a hint, and it stops by itself when hunger drops under that.
- **Saturation** (the thin amber bar under the drumsticks). While hurt, with hunger completely full and saturation left, you heal half a heart every 1.5 s and spend one saturation. When saturation runs out it costs half a drumstick, so healing stops until you eat. Saturation never drains at full health. New characters start with 5.
- **Apples**, eaten with the Use button / right click (+2 drumsticks, +6 saturation; refused when full).
- **Leaf loot:** leaves no longer drop leaf blocks. Each leaf block has a 10% chance of dropping its tree's sapling and, independently, a 15% chance of one apple or stick (50/50). This also applies to the leaves of a felled tree.
- **Three new tree species** next to the original (now called **spruce**): **oak** (broad crown), **maple** (round, red-orange leaves) and **darkwood** (tall, narrow, nearly black bark). Forests form groves of one species with some mixing. Each has its own log, leaves and sapling textures; every log crafts into the same planks (the recipe book uses whichever species you hold most of).
- **Saplings:** break leaves to find them. Plant one in **dirt** (grass, sand and stone are refused) and it grows into its species' tree after a random 4 to 150 seconds, but only while you are within render distance (the timer pauses when you wander off). If something is in the way it waits and retries instead of destroying blocks. Breaking the dirt under a sapling pops it off. Growing trees can be chopped like any other.
- **Fall damage** (not requested, but survival needed it): falls up to 3 blocks are free, then half a heart per extra block; water breaks any fall.
- New sounds for hurt, eating, death and a tree growing; help screen and README updated.

### Changed
- Wooden "Oak Planks" are now just **Planks**.
- Worlds created before this version keep their spruce-only forests (the save has no generator version, so the terrain generator treats it as the old one). New worlds get all four species. Saves from earlier versions load with full health and hunger.

## [0.2.0] - 2026-10-21

### Added
- **Attack and Use buttons** on the touch screen. Hold **Attack** to mine blocks (or swing your tool); slide the same thumb to aim while you hold it. Tap **Use** to place the held block (hold to repeat). The old hold-and-tap gestures on the right side of the screen still work.
- **World selection screen.** *Play* now opens a list of your worlds with the seed and when you last played. Create as many worlds as you like (optional name and seed: a number or any text), and delete a world with a two-tap confirmation. Each world keeps its own terrain edits, inventory, position and time of day. The pause menu shows which world you are in.
- An existing single save from v0.1.x is moved into "World 1" automatically on first launch.

### Fixed
- **Stuck in the water:** swimmers could not climb out onto a bank one block above the water surface, because the climb check was measured from where the feet float (below the surface) and fell inside the bank block; success depended on lucky bobbing. Climbing out now lifts you exactly as high as the ledge needs, works from any depth and when approaching diagonally, and swimming into a wall swims you up it so touch players do not have to hold jump. Walls two blocks above the surface still block you (no free super-jumps). Verified against every shore in the default world.
- Starting a different world could briefly show chunks of the previous world (stale meshes were not cleared).

## [0.1.1] - 2026-10-21

### Changed
- Shows an "Inventory full" message when a nearby drop cannot be picked up (previously the item silently stayed on the ground). The warning repeats at most every 3 seconds.

## [0.1.0] - 2026-10-21

First pilot release.

### World
- Procedurally generated, endless, chunked voxel world (seeded, deterministic, saved as per-chunk edits).
- Blocks: grass, dirt, stone, sand, water, oak log, oak leaves, oak planks, cobblestone.
- Rivers carved through valleys with sandy banks and beds; sea level water; stone on high ground.
- Oak forests placed on a jittered grid so trees never get cut off at chunk borders.
- Day/night cycle with sun, moon and stars.

### Gameplay
- First-person movement: walk, jump, auto-jump, swim; touch joystick + drag-to-look, or keyboard and mouse.
- Hold to mine (with crack animation and tool speed/durability), tap to place.
- Inventory (36 slots) with a 3x3 crafting grid and a tap-to-fill recipe book.
- Recipes: planks, sticks, wooden pickaxe, wooden axe, stone pickaxe, stone axe. Stone needs a pickaxe to drop cobblestone.
- **Falling trees:** break the bottom log and the whole tree (trunk and the leaves hanging from it) topples away from you, thuds to the ground and drops every block as a pickup.
- Dropped items hop, magnetise towards you and merge into stacks.
- Autosave to the browser (localStorage) every 15 s and when the page is hidden.

### Art and sound
- All textures, icons and the app icon are painted procedurally in code (no image assets).
- Procedural sound effects and generative ambient music (day and night moods) via WebAudio (no audio files).

### App and build
- Installable PWA: web manifest, maskable icon, offline service worker with a versioned precache.
- `npm run build` writes a flat `deploy/` folder; `npm run package` zips it as `dist/blocklands-v<version>.zip`.
- `npm run release [patch|minor|major|x.y.z]` bumps the version, tests, builds, packages and tags.
- Test suite on `node:test` (core rules, world generation, falling trees, crafting, mesher, build output, zip, versioning).
