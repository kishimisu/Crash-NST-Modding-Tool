import { readFileSync, writeFileSync } from 'fs'
import { BufferView } from '../utils.js'
import Fixup from './fixup.js'
import igObject from './igObject.js'
import ChunkInfo from './chunkInfos.js'
import NSTPC from '../../assets/crash/NSTPC.txt'

const IGZ_VERSION      = 10
const IGZ_SIGNATURE    = 0x49475A01

class IGZ {
    constructor(igz_data, path) {
        this.path = path
        this.updated = false
        this.header = null
        this.chunk_infos = []
        this.fixups = {}
        this.objects = []

        this.objectList = null // igObjectList (this.objects[0])
        this.nameList = null   // igNameList
        this.initialize(new Uint8Array(igz_data))
    }

    /** Construct from .igz file path
     * @param {string} filePath path to the file
    */
    static fromFile(filePath) {
        const data = readFileSync(filePath)
        return new IGZ(data, filePath)
    }

    /**
     * Construct from FileInfos object
     * @param {FileInfos} file FileInfos object
     * @returns {IGZ} new IGZ object
     */
    static fromFileInfos(file) {
        const data = file.getUncompressedData()
        return new IGZ(data, file.path)
    }

    initialize(buffer) {
        const reader = new BufferView(buffer)

        /// Header ///

        const signature = reader.readInt()
        const version   = reader.readInt()

        if (signature != IGZ_SIGNATURE) throw new Error('Invalid signature: ' + signature)
        if (version != IGZ_VERSION) throw new Error('Invalid version: ' + version)

        this.header = reader.readBytes(2048, 0)

        /// Chunk infos ///

        reader.seek(16)

        while(true) {
            const info = ChunkInfo.fromBuffer(reader)
            if (info == null) break

            this.chunk_infos.push(info)
        }

        /// Fixups (Chunk 0) ///

        reader.seek(this.chunk_infos[0].offset)

        while (true) {
            const fixup = Fixup.fromBuffer(this, reader)
            if (fixup == null) break

            this.fixups[fixup.type] = fixup
        }
        
        if (this.fixups.TMET == null) throw new Error('TMET fixup not found')
        if (this.fixups.RVTB == null) throw new Error('RVTB fixup not found')
        if (this.fixups.TSTR == null) console.warn('TSTR fixup not found')
        if (this.fixups.ROFS == null) console.warn('ROFS fixup not found')
        if (this.fixups.ONAM == null) console.warn('ONAM fixup not found')
        if (this.fixups.TSTR == null || this.fixups.ROFS == null || this.fixups.ONAM == null) {
            return
        }
    
        if (this.fixups.EXNM) {
            // Init EXNM fixup data
            this.fixups.EXNM.data = this.fixups.EXNM.data.map(([a, b]) => ([this.fixups.TSTR.data[a], this.fixups.TSTR.data[b]]))
        }

        /// Objects (Chunk 1) ///

        const global_offsets = this.fixups.RVTB.data.map(offset => this.getGlobalOffset(offset))

        for (let i = 0; i < global_offsets.length; i++) {
            const global_offset = global_offsets[i]
            const size = (global_offsets[i + 1] ?? buffer.length) - global_offset

            const rvtb_offset = this.fixups.RVTB.data[i]
            const relative_offset = rvtb_offset & 0x7ffffff
            const chunk_info = this.chunk_infos[(rvtb_offset >> 0x1b) + 1]
            const data = reader.readBytes(size, global_offset)

            this.objects.push(new igObject({ 
                index: i, offset: relative_offset, 
                global_offset, chunk_info, size, data 
            }))
        }

        /// Read object types ///

        for (const object of this.objects) {
            const typeID = object.view.readInt(0)
            const type = this.fixups.TMET.data[typeID]

            if (type == null) throw new Error('Type is null: ' + typeID)

            object.type = type
            object.typeID = typeID
        }

        this.objectList = this.objects[0]
        this.nameList = this.objects.find(e => e.type == 'igNameList')

        /// Read root objects names ///

        const root_offsets = this.objectList.getList()
        const root_names   = this.nameList.getList()

        root_offsets.forEach((offset, i) => {
            const nameID = root_names[i]
            const name   = this.fixups.TSTR.data[nameID]
            const object = this.objects.find(e => e.offset == offset)

            if (name == null) throw new Error('Name is null: ' + nameID)
            if (object == null) console.warn(`Entry #${i} (offset: ${offset}, name: ${name}) is not present in RVTB`)

            object.name = name
            object.nameID = nameID
        })

        /// Add type count to unnamed objects ///

        const types_count = {}
        this.objects.forEach(object => {
            if (object.nameID != -1) return
            const count = types_count[object.type] ?? 1
            types_count[object.type] = count + 1
            object.typeCount = count
        })

        /// Get children + references ///

        const rofs = this.fixups.ROFS.data

        for (const offset of rofs) {
            const global_offset = this.getGlobalOffset(offset & 0xfbffffff)
            const object = this.objects.find(e => global_offset >= e.global_offset && global_offset < e.global_offset + e.size)
            
            const relative_offset = global_offset - object.global_offset
            const value = object.view.readInt(relative_offset)

            const child_global_offset = this.getGlobalOffset(value)
            const child = this.objects.find(e => child_global_offset >= e.global_offset && child_global_offset < e.global_offset + e.size)
            
            if (object !== child && child != null) {
                if (!object.children.some(e => e.object == child)) {
                    object.children.push({ object: child, offset: relative_offset })
                }
                if (!child.references.some(e => e == object)) {
                    child.references.push(object)
                }
            }
            else if (child == null) console.warn('No object found for offset', offset, global_offset, object.getName(), value)
        }
    }

    save(filePath) {
        // Calculate file size
        const fileSize = this.chunk_infos[0].offset + this.chunk_infos.reduce((a, b) => a + b.size, 0)

        // Write full header
        const buffer = new Uint8Array(this.header.concat(new Array(fileSize - this.header.length).fill(0)))
        const writer = new BufferView(buffer)

        // Re-write chunk infos
        writer.seek(16) // Skip header
        this.chunk_infos.forEach(e => e.save(writer))

        // Write fixups
        writer.seek(this.chunk_infos[0].offset)
        Object.values(this.fixups).forEach(e => e.save(writer))

        // Write objects
        const objects_start = this.chunk_infos[1].offset
        writer.seek(objects_start)
        this.objects.forEach(e => {
            if (writer.offset - objects_start != e.offset) console.warn('Offset mismatch: ' + (writer.offset - objects_start) + ' != ' + e.offset)
            e.save(writer, objects_start)
        })

        this.updated = false
        this.objects.forEach(e => e.updated = false)

        if (filePath) {
            writeFileSync(filePath, writer.view)
        }

        return writer.buffer
    }

    /**
     * Find all external files that are referenced in TDEP
     * @param {Pak} pak Parent PAK object
     * @returns {string[]} A list of unique file paths
     */
    getDependencies(pak) {
        // Get dependencies
        const tdep = this.fixups.TDEP?.data ?? []
        const exnm = this.fixups.EXNM?.data ?? []

        const getFileName = (str) => {
            str = str.toLowerCase().split('/').pop()
            str = str.slice(0, str.lastIndexOf('.'))
            return str
        }

        // Convert to names
        const deps = tdep.concat(exnm).map(([name, path]) => path.includes('.') ? getFileName(path) : null).filter(e => e != null)

        // Remove duplicates
        const all_names = Array.from(new Set(deps))

        // Get file paths
        const isDependencyFor = (file_path, name) => {
            file_path = getFileName(file_path)
            if (file_path == name) return true
            // Special case for L104_Boulders
            // TODO: Find other special cases
            if (file_path == name + '_behavior' || file_path == name + '_character') {
                console.log('Additional path:', file_path, 'for', name)
                return true
            }
            return false
        }

        // Get all file path dependencies for all names
        let all_paths = all_names.map(name => pak.files.filter(f => isDependencyFor(f.path, name))).flat().map(e => e.path)

        // Remove duplicates
        all_paths = Array.from(new Set(all_paths))

        // console.log({tstr, tdep, exnm, deps, all_names, all_paths})

        return all_paths
    }

    /**
     * Update the TSTR and chunk_info objects of this package file
     * Only call this function on *_pkg.igz files
     * @param {string[]} file_paths List containing all paths of the oarent .pak archive
     * @returns New igz file buffer
     */
    updatePKG(file_paths) {
        const nst_data = JSON.parse(NSTPC)

        const typesOrder = [
            'script', 'sound_sample', 'sound_bank', 'lang_file',
            'texture', 'material_instances', 'vsc', 'igx_file', 
            'havokrigidbody', 'model', 'asset_behavior', 
            'havokanimdb', 'hkb_behavior', 'hkc_character', 
            'behavior', 'sky_model', 'effect', 'actorskin', 
            'sound_stream', 'character_events', 'graphdata_behavior', 
            'navmesh', 'igx_entities', 'pkg'
        ]

        const filesByType = Object.fromEntries(typesOrder.map(e => [e, []]))
        const types = new Set()
        
        file_paths = file_paths.filter(e => nst_data[e] != null).sort((a, b) => a.localeCompare(b))

        // Group files by type
        for (let i = 0; i < file_paths.length; i++) {
            const path = file_paths[i]
            const type = nst_data[path].type

            if (filesByType[type] == null) throw new Error('Type not found: ' + type)
            else filesByType[type].push(path)

            types.add(type)
        }

        // Build new TSTR data
        const files = typesOrder.map(e => filesByType[e]).flat()
        const new_TSTR  = Array.from(types).sort((a, b) => a.localeCompare(b))
                         .concat(files)
                         .concat('chunk_info')

        // Update TSTR
        this.fixups.TSTR.updateData(new_TSTR)

        // Build new igStreamingChunkInfo data
        const chunk_info_data = []
        for (let i = 0; i < files.length; i++) {
            const file_path = files[i]
            const file_type = nst_data[file_path].type

            const file_path_id = new_TSTR.indexOf(file_path)
            const file_type_id = new_TSTR.indexOf(file_type)

            chunk_info_data.push([file_type_id, file_path_id])
        }

        // Update igStreamingChunkInfo object
        const chunk_info = this.objects[1]
        chunk_info.updatePKG(chunk_info_data)

        // Update objects offsets
        const sorted_objects = this.objects.sort((a, b) => a.offset - b.offset)
        for (let i = 1; i < sorted_objects.length; i++) {
            const object = sorted_objects[i]
            const prevEndOffset = sorted_objects[i - 1].offset + sorted_objects[i - 1].size

            if (object.offset != prevEndOffset) {
                console.log('Updated start offset for ' + object.getName() + ' from ' + object.offset + ' to ' + prevEndOffset + ' (' + (prevEndOffset - object.offset) + ')')
                object.offset = prevEndOffset
            }
        }

        // Update igObjectList + igNameList
        const namedObjects = this.objectList.getList().map(off => this.objects.find(e => e.offset == off)).filter(e => e != null)
        this.objectList.updateList(namedObjects.map(e => e.offset))
        this.nameList.updateList(namedObjects.map(e => this.fixups.TSTR.data.indexOf(e.name)))

        // Update fixups
        this.fixups.RVTB.updateData(this.buildRVTB())
        this.fixups.ONAM.updateData(this.buildONAM())
        this.fixups.ROFS.updateData(this.buildROFS())
        this.fixups.RSTT.updateData(this.buildRSTT())

        // Update chunk infos
        this.chunk_infos[0].size = Object.values(this.fixups).reduce((a, b) => a + b.size, 0)
        this.chunk_infos[1].offset = this.chunk_infos[0].offset + this.chunk_infos[0].size
        this.chunk_infos[1].size = this.objects.reduce((a, b) => a + b.size, 0)

        return this.save()
    }

    buildONAM() {
        return [ this.objects.find(e => e.type == 'igNameList').offset ]
    }

    buildRVTB() {
        return this.objects.map(e => e.offset)
    }

    buildROFS() {
        const mandatory_offsets = {
            'igObjectList': [0x20],
            'igNameList': [0x20],
            'igStreamingChunkInfo': [0x38],
        }
        const rofs = []

        for (const entry of this.objects) {
            const offsets = entry.children
                            .filter(e => entry.type == 'igObjectList')
                            .map(e => e.offset)

                            .concat(mandatory_offsets[entry.type] ?? [])
                            .map(e => e + entry.offset)
                            .sort((a, b) => a - b)

            rofs.push(...offsets)
        }

        return rofs
    }

    buildRSTT() {
        const rstt = []

        const chunk_info = this.objects.find(e => e.type == 'igStreamingChunkInfo')
        if (chunk_info) {
            const file_count = this.fixups.TSTR.data.filter(e => e.includes('.')).length
            for (let i = 0; i < file_count * 2; i++) {
                rstt.push(i * 8 + 112)
            }
        }

        for (let i = 0; i < this.nameList.getList().length; i++) {
            rstt.push(this.nameList.offset + 40 + i * this.nameList.element_size)
        }

        return rstt
    }

    /**
     * Find the object that contains the given offset
     * 
     * @param {int} offset - The offset to search for
     * @param {boolean} global_offset - If true, search against global offsets instead of relative offsets
     * @returns {igObject} The object that contains the given offset
     */
    findObject(offset, global_offset = true) {
        if (global_offset) {
            offset = this.getGlobalOffset(offset)
            return this.objects.find(e => offset >= e.global_offset && offset < e.global_offset + e.size)
        }
        return this.objects.find(e => offset >= e.offset && offset < e.offset + e.size)
    }

    /**
     * Converts an encoded offset into a global offset
     * 
     * @param {int} offset - The offset to convert
     * @returns {int} The offset relative to the start of the file
     */
    getGlobalOffset(offset) {
        return (offset & 0x7ffffff) + this.chunk_infos[(offset >> 0x1b) + 1].offset
    }

    /**
     * Get all objects that have a name (included in RVTB)
     * and no reference (except for the mandatory igObjectList)
     * @returns {igObject[]} List of all root objects
     */
    getRootObjects() {
        return this.objects.filter(e => e.nameID != -1 && e.references.length == 1)
    }

    toNodeTree() {
        return [{
            text: 'Fixups',
            children: Object.values(this.fixups).map(e => e.toNodeTree(this.objects)),
        }, {
            text: 'Unreferenced objects',
            children: this.objects.filter(e => e.references.length == 0).map(e => e.toNodeTree())
        }, {
            text: 'Root Objects',
            children: this.getRootObjects().map(e => e.toNodeTree()),
        }]
    }

    toString() {
        return {
            file_size: this.chunk_infos.reduce((a, b) => a + b.size, 0) + this.chunk_infos[0].offset,
            total_objects: this.objects.length,
            named_objects: this.objectList?.getList().length,
            root_objects: this.getRootObjects().length,
            chunk_infos: this.chunk_infos.map(e => e.toString()),
            fixups: Object.fromEntries(Object.values(this.fixups).map(e => [e.type, e.item_count]))
        }
    }
}

export default IGZ