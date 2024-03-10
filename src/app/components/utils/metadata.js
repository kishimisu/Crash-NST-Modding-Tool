import types_metadata from '../../../../assets/crash/types.metadata'
import NST_FILE_INFOS from '../../../../assets/crash/files_infos.txt'
import { BufferView } from '../../../utils'

/**
 * Reads all types metadata, enums metadata and types hierarchy from the metadata file.
 */
const [TYPES_METADATA, ENUMS_METADATA, TYPES_HIERARCHY, TYPES_SIZES] = extract_metadata()

const { namespace_hashes, file_types } = JSON.parse(NST_FILE_INFOS)

function extract_metadata() {
    const start = performance.now()
    const view = new BufferView(new Uint8Array(types_metadata))
    const names = []

    const objects = {}
    const enums = {}
    const hierarchy = {}
    const typeSizes = {}

    const namesCount = view.readUInt16()

    // Read names
    for (let i = 0; i < namesCount; i++) {
        const name = view.readStr()
        names.push(name)
    }

    // Read enums
    const enumsCount = view.readUInt16()

    for (let i = 0; i < enumsCount; i++) {
        const name = names[view.readUInt16()]
        const count = view.readUInt16()

        enums[name] = []
        
        for (let j = 0; j < count; j++) {
            const enumName = view.readStr()
            const enumValue = view.readInt()
            enums[name].push({ name: enumName, value: enumValue })
        }
    }

    // Read types metadata
    while (view.offset < view.buffer.length) {
        const typeName = names[view.readUInt16()]
        const parent = names[view.readUInt16()]
        const size = view.readUInt16()
        const fieldCount = view.readUInt16()
        const fields = [{
            name: 'referenceCount',
            type: 'igUnsignedIntMetaField',
            offset: 8,
            size: 4,
            alignment: 4,
        }]

        // Add type to hierarchy data
        function addToHierarchy(type, children = null) {
            if (!hierarchy[type]) hierarchy[type] = { children: new Set() }
            if (children) children.forEach(e => hierarchy[type].children.add(e))
        }
        addToHierarchy(typeName)
        addToHierarchy(parent, [typeName])

        // Read fields
        for (let i = 0; i < fieldCount; i++) {
            // Read name and type
            const field = {
                name: names[view.readUInt16()],
                type: names[view.readUInt16()],
                offset: view.readUInt16(),
                size: view.readUInt16(),
                alignment: view.readUInt16(),
                static: view.readByte() === 1
            }
            
            // Read MetaObject (object reference type)
            if (field.type === 'igObjectRefMetaField' || field.type === 'igObjectRefArrayMetaField') {
                field.refType = names[view.readUInt16()]
            }
            // Read MemType (memory data type)
            if (['igMemoryRefMetaField', 'igVectorMetaField', 'igVectorArrayMetaField'].includes(field.type)) {
                field.memType = names[view.readUInt16()]
                if (field.memType == '<No Data>') field.memType = "void"
            }
            // Read ElementType (array data type)
            if (['igVectorMetaField', 'igVectorArrayMetaField'].includes(field.type)) {
                field.elmType = names[view.readUInt16()]
                if (field.elmType == '<No Data>') field.elmType = null
            }
            // Read bitfield data
            if (field.type === 'igBitFieldMetaField') {
                field.rootIndex = view.readUInt16()
                field.metaField = names[view.readUInt16()]
                field.shift = view.readByte()
                field.bits = view.readByte()
            }
            // Read enum data
            if (['igEnumMetaField', 'igBitFieldMetaField', 'igEnumArrayMetaField'].includes(field.type)) {
                field.enumType = names[view.readUInt16()]
            }
            
            fields.push(field)
        }

        // Update bitfield data
        fields.forEach(field => {
            if (field.type === 'igBitFieldMetaField') {
                field.parent = fields[field.rootIndex+1]
                field.parent.children ??= []
                field.parent.children.push(field)
                field.parent.bitfieldParent = true
                field.size = field.parent.size
                field.type = field.metaField
                field.bitfield = true

                if (field.type != 'igEnumMetaField') {
                    field.enumType = null
                }
            }

            // Add type size and alignment data
            if (!field.bitfield && !field.bitfieldParent &&  
                !field.type.includes('Array') && 
                 field.type != 'igStructMetaField') {

                if (typeSizes[field.type] == null) 
                    typeSizes[field.type] = {
                        size: field.size,
                        alignment: field.alignment
                    }
                // else if (typeSizes[field.type].alignment != field.alignment) console.warn('Alignment mismatch', field.name, field.type, field.alignment, typeSizes[field.type].alignment)
            }
        })

        // Remove 0-sized fields, sort by offset and save type metadata
        objects[typeName] = fields.filter(e => e.type !== 'igStaticMetaField' && e.type !== 'igPropertyFieldMetaField')
                                  .sort((a, b) => a.offset - b.offset)
        objects[typeName].size = size
    }

    console.log('Extracted metadata in ', (performance.now() - start).toFixed(3), 'ms')

    return [ objects, enums, hierarchy, typeSizes ]
}

/**
 * Returns all types that inherit from the provided type.
 */
function getAllInheritedChildren(type, all_children = new Set()) {
    if (type == null) return all_children
    const children = TYPES_HIERARCHY[type].children
    all_children.add(type)

    for (const child of children) {        
        if (!all_children.has(child))
            getAllInheritedChildren(child, all_children)
    }

    return children
}

export {
    TYPES_METADATA,
    TYPES_SIZES,
    ENUMS_METADATA,
    namespace_hashes,
    file_types,
    getAllInheritedChildren
}