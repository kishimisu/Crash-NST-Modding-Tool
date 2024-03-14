import { TYPES_METADATA, VSC_METADATA } from "../app/components/utils/metadata.js"
import { BufferView, computeHash } from "../utils.js"

const igListHeaderSize = 40

class igObject {
    constructor({index, offset, global_offset, chunk_info, size = -1, type = '', typeID = -1, name = '', nameID = -1, data = []}) {
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
        if (!this.isListType()) throw new Error('Invalid object list type: ' + this.type)
        
        const count = list.length
        const data_size = count * this.element_size

        this.view = new BufferView(this.data)
        this.size = igListHeaderSize + data_size

        this.view.setInt(count, 16)
        this.view.setInt(count, 20)
        this.view.setInt(data_size, 24)
        // this.view.setInt(offset, 32) // updated on save

        for (let i = 0; i < count; i++) {
            this.view.setInt(list[i], igListHeaderSize + i * this.element_size)
        }
    }

    // Update object list data for igStreamingChunkInfo
    updatePKG(files) {
        if (this.type !== 'igStreamingChunkInfo') throw new Error('Invalid object type: ' + this.type)

        const new_data = new Uint8Array(64 + files.length * 16)

        new_data.set(this.data.slice(0, 64))

        let view = new BufferView(new_data)
        view.setInt(files.length, 40)
        view.setInt(files.length * 16, 48)

        view.seek(64)
        for (let [id, id2] of files) {
            view.setInt(id)
            view.setInt(0)
            view.setInt(id2)
            view.setInt(0)
        }

        this.data = new_data
        this.size = new_data.length
        this.view = new BufferView(this.data)
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

        if (this.isListType()) {
            this.offset = writer.offset - chunk0_offset
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
            const inRNEX = igz.fixups.RNEX?.data.includes(this.offset + metaObject.offset)
            
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

                if (metaFields == null) console.warn('Dynamic object not found:', this.name, name, file)

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