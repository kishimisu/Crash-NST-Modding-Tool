import { BufferView } from '../utils'
import havok_metadata from '../../assets/crash/havok.metadata'

const HAVOK_METADATA = parse_havok_metadata()

class hkObject {
    constructor(type, offset, root = false) {
        this.index = null    // index in hkx file
        this.type = type     // type (class name) 
        this.offset = offset // offset in hkx file
        this.name = ''       // name detected using metadata 
        this.typeCount = 0   // unique index for this class

        this.root = root     // referenced by virtual fixup?
        this.view = null     // object data view

        this.children = []   // children objects
        this.references = [] // parent objects
        
        // Extract metadata
        const metadata = HAVOK_METADATA.types[type]
        if (metadata) {
            this.size = metadata.size
            this.rootSize = metadata.size
            this.fields = metadata.fields.map(e => ({ ...e }))
            this.parentClass = metadata.parent
        }
    }

    initialize(hkx) {
        const { reader } = hkx

        // Get object data slice
        const objectData = reader.buffer.slice(this.offset, this.offset + this.rootSize)
        this.view = new BufferView(objectData)

        if (this.fields == null) {
            console.warn('No metadata for', this.type)
            this.invalid = 'No metadata'
            this.fields = []
            return
        }

        const addChild = (object) => {
            if (object == null) return
            this.children.push(object)
            object.references.push(this)
        }

        // Add children and references by looping through fields
        for (const field of this.fields) {
            const global_offset = this.offset + field.offset
            field.global_offset = global_offset // Field offset in hkx file

            // Get read/write method
            field.method = (HAVOK_METADATA.typeInfos[field.type] ?? HAVOK_METADATA.typeInfos[field.subtype])?.method 
            if (field.method == null) field.method = ['UInt8', 'UInt16'][field.size-1] ?? 'UInt'

            let current_offset = global_offset
            reader.seek(current_offset)

            
            if (field.type == 'TYPE_ARRAY') {
                let objectOffset = reader.readUInt()
                reader.skip(4)
                const elementCount = reader.readUInt()
                const signature = reader.readUInt()

                if ((signature & 0x80000000) == 0) continue // Inactive memory
                
                field.value = []
                field.element_count = elementCount
                field.memory_active = elementCount > 0
                field.memType = field.subtype

                for (let i = 0; i < elementCount; i++) {
                    if (field.memType == 'TYPE_STRUCT') {
                        const object = hkx.getObject(field.refType, objectOffset)
                        field.value.push(objectOffset)
                        addChild(object)
                        objectOffset += object.size
                    }
                    else if (field.refType != null) {
                        const ptr = reader.readUInt(objectOffset)
                        if (ptr == 0) console.warn('List pointer is null')
                        const object = hkx.getObject(field.refType, ptr)
                        field.value.push(ptr)
                        addChild(object)
                        objectOffset += 8
                    }
                    else {
                        const typeInfos = HAVOK_METADATA.typeInfos[field.memType]
                        field.value.push(reader['read' + typeInfos.method](objectOffset))
                        objectOffset += typeInfos.size
                    }
                }
            }
            else if (field.type == 'TYPE_RELARRAY') {
                const count  = reader.readUInt16()
                const offset = reader.readUInt16()

                field.value = []
                field.element_count = count
                field.ref_data_offset = offset
                field.memory_active = count > 0
                field.memType = field.subtype

                let objectOffset = field.global_offset + offset
                for (let i = 0; i < count; i++) {
                    if (field.memType == 'TYPE_STRUCT') {
                        const object = hkx.getObject(field.refType, objectOffset)
                        field.value.push(objectOffset)
                        addChild(object)
                        objectOffset += object.size
                    }
                    else if (field.refType != null) throw new Error('Not implemented')
                    else {
                        const typeInfos = HAVOK_METADATA.typeInfos[field.memType]
                        const value = reader['read' + typeInfos.method](objectOffset)
                        objectOffset += typeInfos.size
                    }
                }
            }
            else if (field.type == 'TYPE_POINTER' || field.type == 'TYPE_STRUCT') {
                const value  = reader.readUInt()
                const object = hkx.getObject(field.refType, value)
                field.value  = object?.offset
                addChild(object)
            }
            else if (field.type == 'hkBitField') {
                const offset = reader.readUInt()
                const value  = reader.readUInt(offset)
                field.value  = value
            }
            else if (field.type == 'TYPE_STRINGPTR') {
                const strPtr = reader.readUInt()
                if (strPtr == 0) field.value = 'null'
                else {
                    field.value = reader.readStr(strPtr)
                    if (field.name == '_name') this.name = field.value
                }
            }
            else {
                const value = reader['read' + field.method]()
                field.value = value
            }
        }
    }

    getName() {
        let str = this.type
        if (this.typeCount > 0) str += ' ' + this.typeCount
        if (this.name != '') str += ': ' + this.name
        return str
    }

    getDisplayName() {
        if (this.name != '') return this.name
        let str = this.type
        if (this.typeCount > 0) str += ' ' + this.typeCount
        return str
    }

    toNodeTree(parents = new Set()) {
        if (parents.has(this)) return null
        parents.add(this)

        let children = this.children.map(e => e.toNodeTree(parents)).filter(e => e != null)
        if (children.length == 0) children = null

        return {
            text: this.getName(),
            type: 'object',
            objectIndex: this.index, 
            children
        }
    }
}

function parse_havok_metadata() {
    const view = new BufferView(new Uint8Array(havok_metadata))
    const NAMES = []
    
    const readStr  = () => view.readStr()
    const readNum  = () => view.readUInt8()
    const readName = () => NAMES[readNum()]

    /// Read Names ///
    const nameCount = readNum()
    for (let i = 0; i < nameCount; i++) {
        NAMES.push(readStr())
    }

    /// Read Type Infos ///
    const TYPE_INFOS = {}
    const typeInfoCount = readNum()

    for (let i = 0; i < typeInfoCount; i++) {
        const name   = readName()
        const size   = readNum()
        const method = readStr()
        TYPE_INFOS[name] = { size, method }
    }
    
    /// Read Enums ///
    const ENUMS = {}
    const enumCount = readNum()

    for (let i = 0; i < enumCount; i++) {
        const enumName   = readName()
        const valueCount = readNum()
        ENUMS[enumName] = []

        for (let j = 0; j < valueCount; j++) {
            const name  = readStr()
            const value = view.readUInt()
            ENUMS[enumName].push({ name, value })
        }
    }

    /// Read Classes ///
    const TYPES = {}
    const classCount = readNum()

    for (let i = 0; i < classCount; i++) {
        const name   = readName()
        const parent = readName()
        const size   = readNum()
        const id = view.readUInt()

        const fieldCount = readNum()
        const fields = []

        for (let j = 0; j < fieldCount; j++) {
            const name     = readStr()
            const offset   = readNum()
            const size     = readNum()
            const type     = readName()
            const subtype  = readName()
            const enumType = readName()
            const refType  = readName()
            fields.push({ name: '_' + name, offset, size, type, subtype, enumType, refType })
        }

        TYPES[name] = { id, parent, size, fields }
    }

    return { 
        types: TYPES,
        enums: ENUMS,
        typeInfos: TYPE_INFOS,
    }
}

export default hkObject
export { HAVOK_METADATA }