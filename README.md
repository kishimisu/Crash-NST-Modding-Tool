## A work-in-progress tool for modding the Crash NST PC game

This tool lets you explore and edit .pak archives and .igz files for the PC version of Crash NST.

You can edit igz directly from within pak archives and rebuild new archives without having to leave the app.

This is a very early demo, bugs may appear. Feedback and contributions are welcome!

### PAK explorer

**Important Note**: No change will be applied until the file is saved. Moreover on the very first time saving a new archive, every file of the archive will be decompressed and cached (which can take some time). Subsequent saves should be way faster than the first one.

*Allows you to explore .pak archives*

- **Launch Level**: Run the game at the selected level. If `Use current pak` is checked, the original level archive will be overwritten with the current one.

- **Revert to Original**: Revert the original archive (in the game folder) to its default state. Does not reset the content of the current archive being explored.

- **Import**: Import either a single .igz file or a selection of files from another PAK archive into the current one.

*When clicking on a .igz file within the archive:*

- **Open**: Open the file to access and edit its content.

- **Replace**: Replace the content of a file with another one from the current PAK archive.

- **Clone**: Duplicate a file and its content.

- **Delete**: Remove a file.

- **Extract**: Uncompress & save a file from a PAK archive to the disk.

### IGZ explorer

*Allows you to explore .igz files within PAK archives or standalone IGZs*

- **Objects**: List of root objects referenced in the file, with children dependencies.

- **Unreferenced objects**: Contains objects that are not referenced by any other. Usually, it will have two entries that should not be updated (igObjectList & igNameList).

- **Fixups**: Fixups containing list of offsets are directly translated to the object they're pointing to in their child view. Other fixups contains their original data (strings or int list)

## Data editing

You have the possibility to edit any object's data in the IGZ explorer by clicking on a cell in the object's data view.

#### Calculations helpers

You can do relative computations when editing a value. For example writing `* 2` will multiply the current value by two.
It also works with `+ 2`, `/ 2` but it needs to be `-= 2` for subtraction to prevent confusing with the negative number `-2`.

#### Multi-editing
If you select an object that is the result of a search query, you will have the possibility to apply your changes to every selected object at the exact same offset.
Relative calculation works with multi-editing and will affect each object's relative to its original value.

#### Potential type casts
The potential type casts show you what the value might be corresponding to as int, uint and float, or if it can correspond to an index in the Names fixup (TSTR) or Types fixup (TMET). It can also detect if the value correspond to the offset of another objectm in which case a child entry is created for this object.

#### Color codes
- Green: Object header, should not update
- Blue : Pointer (reference) to another object


## Run the project
You can either [download the executable](https://github.com/kishimisu/Crash-NST-Modding-Tool/releases/tag/beta), or build the project yourself using `yarn`:

### Generate platform-specific distributable
```
yarn
yarn make
```

### Develop & contribute
```
yarn
yarn start
```

## Project Structure

### Classes & Objects

- src/pak: PAK-related classes
- src/igz: IGZ-related classes

### Application

- src/app/main.js: windows & app setup
- src/app/renderer.js: Actual app implementation (UI & state)

## TODO
- Add possibility to change installed game path (currently defaults to `C:\Program Files (x86)\Steam\steamapps\common\Crash Bandicoot - N Sane Trilogy`)
- Add file renaming
- Texture & Audio preview
- Automatically add new external dependencies
- Add possibility to rebuild the _pkg.igz file
- Add compressed mode to avoid having to uncompress every file

## Special Thanks
- Crash NST modding Discord: https://discord.gg/4JhhFNWk
- igArchiveLib repo: https://github.com/LG-RZ/igArchiveLib/tree/master
