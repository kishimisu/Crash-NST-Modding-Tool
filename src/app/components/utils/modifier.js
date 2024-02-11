import IGZ from "../../../igz/igz"

class PakModifiers {
    constructor(pak, { spawnPoint, spawnCrate } = {}) {
        this.pak = pak
        this.spawnPoint = spawnPoint // Override player spawn point
        this.spawnCrate = spawnCrate // Add a crate to the level
    }

    apply() {
        this.applySpawnPoint()
        this.applySpawnCrate()
    }

    applySpawnPoint() {
        if (this.spawnPoint == null) return

        const level_name = this.pak.getOriginalArchiveName().replace('.pak', '.igz')
        const level_file_info = this.pak.files.find(e => e.path.split('/').pop() == level_name)
        const level_file = IGZ.fromFileInfos(level_file_info)
        const player_start_object = level_file.objects.find(e => e.name == 'PlayerStartAll')

        if (player_start_object == null) {
            console.warn('PlayerStartAll not found in level file, skipping modifier')
            return
        }

        player_start_object.view.setFloat(this.spawnPoint[0], 32)
        player_start_object.view.setFloat(this.spawnPoint[1], 36)
        player_start_object.view.setFloat(this.spawnPoint[2] + 200, 40)
        level_file_info.data = level_file.save()
        level_file_info.original = false
        level_file_info.compression = 0xFFFFFFFF

        console.log('[Modifier] Set new spawn point: ' + this.spawnPoint)
    }

    applySpawnCrate() {
        if (this.spawnCrate == null) return

        const crate_file_info = this.pak.files.find(e => e.path.endsWith('_Crates.igz'))
        const crate_file = IGZ.fromFileInfos(crate_file_info)
        const crate_object = crate_file.objects.find(e => e.name == 'Crate_Basic')

        if (crate_object == null) {
            console.warn('Crate_Basic not found in crate file, skipping modifier')
            return
        }

        crate_object.view.setFloat(this.spawnCrate[0], 32)
        crate_object.view.setFloat(this.spawnCrate[1], 36)
        crate_object.view.setFloat(this.spawnCrate[2], 40)
        crate_file_info.data = crate_file.save()

        console.log('[Modifier] Added new crate: ' + this.spawnCrate)
    }
}

export default PakModifiers