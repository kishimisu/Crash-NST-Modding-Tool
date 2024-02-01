import { readFileSync, writeFileSync } from 'fs'
import { BufferView } from '../utils.js'
import Fixup from './fixup.js'
import igObject from '../pak/igObject.js'
import ChunkInfo from './chunkInfos.js'

class IGZ {
    constructor(igz_data, path) {
        this.path = path
        this.updated = false
        this.header = null
        this.chunk_infos = []
        this.fixups = {}
        this.objects = []

        this.objectList = null // objects[0]
        this.nameList = null   // objects[-1]

        this.initialize(igz_data)
    }

    /** Construct from .igz file path
     * @param {string} filePath path to the file
    */
    static fromFile(filePath) {
        const data = readFileSync(filePath)
        return new IGZ(data, filePath)
    }

    initialize(buffer) {
        const reader = new BufferView(buffer)

        /// Header ///

        const signature = reader.readInt()
        const version   = reader.readInt()

        if (signature != 0x49475a01) throw new Error('Invalid signature: ' + signature)
        if (version != 10) throw new Error('Invalid version: ' + version)

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
            const fixup = Fixup.fromBuffer(reader)
            if (fixup == null) break

            this.fixups[fixup.type] = fixup
        }
        
        if (this.fixups.TSTR == null) throw new Error('TSTR fixup not found')
        if (this.fixups.TMET == null) throw new Error('TMET fixup not found')
        if (this.fixups.ONAM == null) throw new Error('ONAM fixup not found')
        if (this.fixups.RVTB == null) throw new Error('RVTB fixup not found')
        if (this.fixups.ROFS == null) throw new Error('ROFS fixup not found')

        if (this.fixups.EXNM) {
            // Init EXNM fixup data
            this.fixups.EXNM.data = this.fixups.EXNM.data.map(([a, b]) => ([this.fixups.TSTR.data[a], this.fixups.TSTR.data[b]]))
        }

        /// Objects (Chunk 1) ///

        const rvtb = this.fixups.RVTB.data
        const sorted_offsets = rvtb.concat(this.chunk_infos[1].size).sort((a, b) => a - b)

        for (const [index, offset] of Object.entries(rvtb)) {
            const sortedID = sorted_offsets.indexOf(offset)
            const nextOffset = sorted_offsets[sortedID + 1]
            const size = nextOffset - offset

            const dataOffset = this.chunk_infos[1].offset + offset
            const data = reader.readBytes(size, dataOffset)

            const typeID = reader.readInt(dataOffset)
            const type = this.fixups.TMET.data[typeID]

            if (type == null) throw new Error('Type is null: ' + typeID)

            this.objects.push(new igObject({ index, offset, size, type, typeID, data }))
        }

        this.objectList = this.objects[0]
        this.nameList = this.objects[this.objects.length - 1]

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

        /// Add count to unnamed objects ///

        const types_count = {}
        this.objects.forEach(object => {
            if (object.nameID != -1) return
            const count = types_count[object.type] ?? 1
            types_count[object.type] = count + 1
            object.typeCount = count
        })


        /// Get children + references ///

        this.updateChildrenAndReferences = () => {
            for (const object of this.objects) {
                object.children = []
                object.references = []
            }

            for (const object of this.objects) {
                for (let k = 0; k < object.size; k += 4) {
                    const value = object.view.readInt(k)
                    if (value == 0) continue

                    const child = this.objects.find(e => e.offset == value)

                    if (child != null) {
                        // if (object.offset > 0) // Do not add igObjectList reference
                            child.references.push(object)

                        object.children.push({ object: child, offset: k })
                    }
                }
            }
        }
        this.updateChildrenAndReferences()
    }

    save(filePath) {
        // Update chunk infos
        this.chunk_infos[0].size = Object.values(this.fixups).reduce((a, b) => a + b.size, 0)
        this.chunk_infos[1].offset = this.chunk_infos[0].offset + this.chunk_infos[0].size
        this.chunk_infos[1].size = this.objects.reduce((a, b) => a + b.size, 0)

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
            if (writer.offset - objects_start != e.offset) throw new Error('Offset mismatch: ' + (writer.offset - objects_start) + ' != ' + e.offset)
            e.save(writer)
        })

        this.updated = false
        this.objects.forEach(e => e.updated = false)

        if (filePath) {
            writeFileSync(filePath, writer.view)
        }

        return writer.buffer
    }

    getRootObjects() {
        return this.objects.filter(e => e.references.length == 1 && e.references[0].type == 'igObjectList')
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
            named_objects: this.objectList.getList().length,
            root_objects: this.getRootObjects().length,
            chunk_infos: this.chunk_infos.map(e => e.toString()),
            fixups: Object.fromEntries(Object.values(this.fixups).map(e => [e.type, e.item_count]))
        }
    }
}

export default IGZ