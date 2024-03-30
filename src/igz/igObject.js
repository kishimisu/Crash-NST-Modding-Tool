import { TYPES_METADATA, VSC_METADATA } from "../app/components/utils/metadata.js"
import { BufferView, computeHash } from "../utils.js"

const igListHeaderSize = 40

class igObject {
    constructor({index, offset, global_offset, chunk_info, size = -1, type = '', typeID = -1, name = '', nameID = -1, data = [], updated = false, custom = false}) {
        this.index = parseInt(index) // Order of appearance in RVTB fixup
        this.offset = offset               // Offset relative to chunk 1
        this.global_offset = global_offset // Offset relative to file start
        this.chunk_info = chunk_info       // Corresponding chunk info reference

        this.type = type        // Type (string)
        this.typeID = typeID    // Type ID in TMET fixup
        this.typeCount = 0      // Custom index to differentiate between unnamed objects of the same type

        this.name = name        // Name (string)
        this.nameID = nameID    // Name ID in TSTR fixup

        this.size = size        // Data size in bytes
        this.data = new Uint8Array(data) // Object data
        this.view = new BufferView(this.data)

        this.children = []
        this.references = []
        this.referenceCount = 0    // Reference count (using refCounted)
        this.dynamicObject = false // Dynamic object? (contains MetaObject)
        this.invalid = null        // null | string (reason)
        this.updated = updated
        this.custom = custom

        this.objectRefs = [] // igObjectRef references
        this.fixups = { RSTT: [], RHND: [], ROFS: [], RNEX: [], REXT: [], RPID: [] } // Fixups references
    }

    clone(igz, offset) {
        const fields = this.getFieldsMetadata(igz)
        const sizeMetadata = fields[fields.length - 1].offset + fields[fields.length - 1].size
        const sizeMTSZ = igz.fixups.MTSZ.data[this.typeID]
        const memories = fields.filter(e => e.type == 'igMemoryRefMetaField')
                               .map(field => ({field, mem_infos: this.extractMemoryData(igz, field.offset)}))
                               .filter(e => e.mem_infos.active)
        
        let size = this.dynamicObject ? sizeMetadata : sizeMTSZ                 
        let data = Array.from(this.data.slice(0, size))

        // Copy memory data
        for (const memory of memories) {
            const { parent, relative_offset, memory_size } = memory.mem_infos
            const bytes = parent.view.readBytes(memory_size, relative_offset)

            memory.memory_data_offset = offset + data.length
            data = data.concat(Array.from(bytes))
        }

        const object = new igObject({
            data: new Uint8Array(data),
            size: data.length,
            offset: offset,
            global_offset: igz.getGlobalOffset(offset),
            chunk_info: this.chunk_info,
            type: this.type,
            typeID: this.typeID,
            name: this.name,
            nameID: this.nameID,
            custom: true,
            updated: true
        })

        if (this.nameID != -1) object.name += '_cloned'
        
        object.original_name_hash = this.original_name_hash ?? computeHash(this.name)
        
        for (let i = igz.objects.length - 1; i >= 0; i--) {
            if (igz.objects[i].typeID == this.typeID) {
                object.typeCount = igz.objects[i].typeCount + 1
                break
            }
        }
        
        const fixups = {}
        Object.entries(this.fixups).forEach(([key, value]) => {
            fixups[key] = this.fixups[key].filter(e => e < size)
        })
        object.fixups = fixups
        object.children   = this.children.map(e => ({ ...e }))
        object.references = this.references.map(e => ({ ...e }))
        object.objectRefs = this.objectRefs.filter(e => e.offset < size).map(e => ({ ...e }))

        // Update objectRefs and fixups        
        for (const {field, memory_data_offset, mem_infos} of memories) {
            const { parent, relative_offset: relative_parent_offset , memory_size, data } = mem_infos
            const relative_offset = memory_data_offset - object.offset

            // Update memory ref children
            if (field.memType == 'igObjectRefMetaField') {
                for (let i = 0; i < data.length; i++) {
                    const inROFS = parent.fixups.ROFS.includes(relative_parent_offset + i * 4)
                    if (!inROFS) continue

                    const ref = data[i]
                    const child = igz.findObject(ref)
                    object.objectRefs.push({ child, offset: relative_offset + i * 4, relative_offset: ref - child.offset })
                    object.fixups.ROFS.push(relative_offset + i * 4)
                }
            }
            else if (field.memType == 'igStringMetaField') {
                for (let i = 0; i < data.length; i++) {
                    const inRSTT = parent.fixups.RSTT.includes(relative_parent_offset + i * 4)
                    if (!inRSTT) continue

                    object.fixups.RSTT.push(relative_offset + i * 4)
                }
            }

            // Update memory ref
            const objectRef = object.objectRefs.find(e => e.offset == field.offset + 8)
            objectRef.child = object
            objectRef.relative_offset = relative_offset
        }

        return object
    }

    isListType() {
        return this.type == 'igObjectList' || this.type == 'igNameList'
    }

    getList() {
        if (!this.isListType()) throw new Error('Invalid object list type: ' + this.type)

        this.view.seek(0)
        const type = this.view.readInt()
        const zero12 = this.view.readBytes(12)
        const count = this.view.readInt()
        const count2 = this.view.readInt()
        const data_size = this.view.readInt()
        const magic = this.view.readInt()
        const data_offset = this.view.readInt()
        const zero = this.view.readInt()

        const list = []
        const element_size = data_size / count

        for (let i = 0; i < count; i++) {
            const offset = this.view.readInt(igListHeaderSize + i * element_size)
            list.push(offset)
        }

        this.element_size = element_size

        return list
    }

    // Update object list data for igObjectList and igNameList
    updateList(list) {
        if (this.type != 'igObjectList' && this.type != 'igNameList') throw new Error('Invalid object list type: ' + this.type)
        
        const element_size = 8
        const count = this.type == 'igObjectList' ? list.length : list.length / 2
        const data_size = list.length * element_size
        // console.log('Updating list:', this.getName(), this.size, '->', igListHeaderSize + data_size, {old: this.getList(), new: list})

        this.size = igListHeaderSize + data_size
        this.data = new Uint8Array(this.size).map((e, i) => i < this.data.length ? this.data[i] : 0)
        this.view = new BufferView(this.data)

        this.view.setInt(count, 16)
        this.view.setInt(count, 20)
        this.view.setInt(data_size, 24)
        // this.view.setInt(offset, 32) // updated on save

        for (let i = 0; i < list.length; i++) {
            this.view.setInt(list[i], igListHeaderSize + i * element_size)
        }
    }

    // Update object list data for igStreamingChunkInfo
    updatePKG(files) {
        if (this.type !== 'igStreamingChunkInfo') throw new Error('Invalid object type: ' + this.type)

        this.fixups.RSTT = []

        const new_data = new Uint8Array(64 + files.length * 16)
        new_data.set(this.data.slice(0, 64))

        let view = new BufferView(new_data)
        view.setInt(files.length, 40)
        view.setInt(files.length * 16, 48)

        view.seek(64)
        for (let [id, id2] of files) {
            this.fixups.RSTT.push(view.offset)
            view.setInt(id)
            view.setInt(0)
            this.fixups.RSTT.push(view.offset)
            view.setInt(id2)
            view.setInt(0)
        }

        this.data = new_data
        this.size = new_data.length
        this.view = new BufferView(this.data)
    }

    /**
     * Activate or deactivate a fixup for a specific offset
     * 
     * @param {string} fixup - Fixup type
     * @param {integer} offset - Fixup offset relative to start of parent object
     * @param {boolean} active - Activate or deactivate the fixup
     * @param {igObject | number} child - Child object or value to set
     * @param {integer} relative_offset - Relative offset within child object
     * @returns {boolean} - True if the fixup was updated, false otherwise
     */
    activateFixup(fixup, offset, active, child, relative_offset = 0) {
        if (!['ROFS', 'RSTT'].includes(fixup)) 
            console.warn('activateFixup: Fixup not implemented:', fixup)

        if (active) {
            const exists = this.fixups[fixup].includes(offset)
            if (!exists) {
                this.fixups[fixup].push(offset)
                this.fixups[fixup].sort((a, b) => a - b)
            }
    
            if (fixup == 'ROFS') {
                if (!exists)
                    this.objectRefs.push({ child, relative_offset, offset})
                else {
                    const id = this.fixups[fixup].indexOf(offset)
                    this.objectRefs[id] = { child, relative_offset, offset}
                }
            }
            else if (fixup == 'RSTT')
                this.view.setUInt(child, offset)
    
            return true
        }
        else if (!active && this.fixups[fixup].includes(offset)) {
            const id = this.fixups[fixup].indexOf(offset)
            if (id == -1) {
                console.warn(`Fixup ${fixup} at offset ${offset} not found in ${this.getName()}`)
                return false
            }
            
            this.fixups[fixup].splice(id, 1)
    
            if (fixup == 'ROFS') {
                this.objectRefs.splice(id, 1)
            }
            else if (fixup == 'RSTT')
                this.view.setUInt(0, offset)
            
            return true
        }
    
        return false
    }

    getName() {
        let str = this.type
        if (this.typeCount > 0) str += ' ' + this.typeCount
        if (this.name != '') str += ': ' + this.name
        return str
    }

    getDisplayName() {
        if (this.name != '') return this.name
        return this.getName()
    }

    save(writer, chunk0_offset) {
        if (this.data.length != this.size) throw new Error('Data size mismatch: ' + this.data.length + ' != ' + this.size)
        if (this.offset != writer.offset - chunk0_offset) throw new Error('Invalid list offset: ' + this.offset + ' != ' + (writer.offset - chunk0_offset))

        if (this.isListType()) {
            const new_offset   = this.offset + igListHeaderSize
            this.view.setInt(new_offset, 32)
        }

        for (let k = 0; k < this.size; k += 4) {
            const value = this.view.readInt(k)
            writer.setInt(value)
        }
    }

    /**
     * Get the fields metadata for this object.
     * If the object is dynamic (contains an igMetaObject named _meta)
     * it will try to load the dynamic object's additional fields.
     * 
     * @param {IGZ} igz - The parent igz instance
     * @returns {Array} - An array of fields metadata
     */
    getFieldsMetadata(igz) {
        let fields = TYPES_METADATA[this.type]
        
        if (fields == null) {
            console.warn('No metadata data found for type:', this.type)
            return []
        }

        const metaObject = fields.find(e => e.refType == 'igMetaObject')

        if (metaObject?.name == '_meta') {
            const inRNEX = this.fixups.RNEX.includes(metaObject.offset)
            
            if (inRNEX) {
                const id = this.view.readUInt(metaObject.offset)
                const [name, file] = igz.named_externals[id]

                let metaFields = TYPES_METADATA[name] ?? TYPES_METADATA[file + '.' + name]
                
                if (metaFields == null && name.endsWith('Data')) {
                    metaFields = VSC_METADATA[computeHash(file)]
                    if (metaFields) {
                        metaFields = fields.concat(metaFields.map(e => ({ ...e, offset: e.offset + metaObject.offset + 8})))
                    }
                }

                // if (metaFields == null) console.warn('Dynamic object not found:', this.name, name, file)

                if (metaFields != null && metaFields.length > fields.length) {
                    fields = metaFields
                    this.dynamicObject = true
                }
            }
        }

        return fields
    }

    toString() {
        return {
            name: this.name == '' ? this.getName() : this.name,
            type: this.type,
            index: this.index,
            offset: this.offset,
            size: this.size,
            children: this.children.map(e => e.object.getName()),
            referenced_by: this.references.map(e => e.getName()),
        }
    }

    toNodeTree(recursive = true, parentObjects = [], parentName = null) {
        if (parentObjects.includes(this.index)) {
            return { 
                text: '[Recursion] ' + this.getName(), 
            }
        }
        parentObjects.push(this.index)

        let text = this.getName()
        let children = this.children.length > 0

        if (children && this.inNodeTree) { // Lazy load children
            children = true
        }
        else if (children && recursive) {  // Fully load children
            if (this.index == 0) children = null
            else  {
                children = this.children

                if (this.type == 'igVscMetaObject') // (vsc files) Always display igVscDataMetaObject as first child of igVscMetaObject
                    children = children.sort((a, b) => a.object.type == 'igVscDataMetaObject' ? -1 : 1)
                
                children = children.map(e => e.object.toNodeTree(true, parentObjects.slice(), this.name))
            }
        }

        // Shorten name if it starts with parent name
        if (parentName && parentName != '' && this.nameID != -1) {
            const type = text.slice(0, text.indexOf(':') + 2)
            const name = text.slice(text.indexOf(':') + 2)
            if (parentName.endsWith('_gen')) parentName = parentName.slice(0, -4)
            if (name.startsWith(parentName)) {
                text = type + name.slice(parentName.length)
                if (text.endsWith('_gen')) text = text.slice(0, -4)
            }
        }

        this.inNodeTree = true

        return {
            type: 'object',
            objectIndex: this.index,
            text,
            children
        }
    }
}

export default igObject
export { igListHeaderSize }