import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BufferView, computeHash, extractName } from '../utils.js'
import Fixup from './fixup.js'
import igObject, { igListHeaderSize } from './igObject.js'
import ChunkInfo from './chunkInfos.js'
import Pak from '../pak/pak.js'
import { namespace_hashes, file_types, TYPES_METADATA } from '../app/components/utils/metadata.js'

const IGZ_VERSION      = 10
const IGZ_SIGNATURE    = 0x49475A01
const CUSTOM_SIGNATURE = 0xAABBCCDD

const FIXUP_ORDER = [
    'TDEP', 'TSTR', 'TMET', 'MTSZ', 'EXID', 'EXNM', 
    'RVTB', 'RSTT', 'ROFS', 'RPID', 'REXT', 'RHND', 'RNEX', 
    'ROOT', 'ONAM', 'NSPC'
]

const FILE_TYPE_ORDER = [
    'script', 'sound_sample', 'sound_bank', 'lang_file', 'loose', 'shader',
    'texture', 'material_instances', 'font', 'vsc', 'igx_file', 
    'havokrigidbody', 'model', 'asset_behavior', 
    'havokanimdb', 'hkb_behavior', 'hkc_character', 
    'behavior', 'sky_model', 'effect', 'actorskin', 
    'sound_stream', 'character_events', 'graphdata_behavior', 
    'character_data', 'gui_project',
    'navmesh', 'igx_entities', 'pkg'
]

class IGZ {
    constructor(igz_data, path) {
        this.path = path
        this.updated = false
        this.header = null
        this.type = null
        this.chunk_infos = []
        this.fixups = {}
        this.objects = []

        this.named_handles   = [] // EXNM handles
        this.named_externals = [] // EXNM externals

        this.objectList = null // igObjectList (this.objects[0])
        this.nameList = null   // igNameList
        this.initialize(new Uint8Array(igz_data))
    }

    /** Construct from .igz file path
     * @param {string} filePath path to the file
     * @returns {IGZ} new IGZ object
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
        if (this.fixups.TSTR == null || this.fixups.ROFS == null || this.fixups.ONAM == null) {
            return
        }
    
        if (this.fixups.EXNM) {
            // Init EXNM fixup data
            this.fixups.EXNM.data.forEach(([a, b], i) => {
                const object    = this.fixups.TSTR.data[a]
                const namespace = this.fixups.TSTR.data[b & 0x7FFFFFFF]
                const isHandle = (b & 0x80000000) != 0

                if (isHandle) 
                    this.named_handles.push([object, namespace])
                else 
                    this.named_externals.push([object, namespace])

                this.fixups.EXNM.data[i] = [ object, (isHandle ? 'Handle | ' : 'External | ') + namespace ]
            })
        }

        /// Objects (Chunk 1) ///

        const global_offsets = this.fixups.RVTB.data.map(offset => this.getGlobalOffset(offset))
        const last_chunk = this.chunk_infos[this.chunk_infos.length - 1]
        const last_offset = last_chunk.offset + last_chunk.size

        for (let i = 0; i < global_offsets.length; i++) {
            const global_offset = global_offsets[i]
            const size = (global_offsets[i + 1] ?? last_offset) - global_offset

            const rvtb_offset = this.fixups.RVTB.data[i]
            const relative_offset = rvtb_offset & 0x7ffffff
            const chunk_info = this.chunk_infos[(rvtb_offset >> 0x1b) + 1]
            const data = reader.readBytes(size, global_offset)

            this.objects.push(new igObject({ 
                index: i, offset: relative_offset, 
                global_offset, chunk_info, size, data, original: true
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

            if (name == null) throw new Error(`Could not find name for object ${i} at offset ${offset} (id: ${nameID})`)
            if (object == null) return console.warn(`Entry #${i} (offset: ${offset}, name: ${name}) is not present in RVTB`)

            object.name = name
            object.nameID = nameID
            object.original_name_hash = computeHash(name)
        })

        /// Add type count to unnamed objects ///

        const types_count = {}
        this.objects.forEach(object => {
            if (object.nameID != -1) return
            const count = types_count[object.type] ?? 1
            types_count[object.type] = count + 1
            object.typeCount = count
        })

        /// Read custom data ///

        const lastChunk = this.chunk_infos[this.chunk_infos.length - 1]
        reader.seek(lastChunk.offset + lastChunk.size)

        this.type = file_types[computeHash(this.path)]

        if (reader.offset < buffer.byteLength) {
            const signature = reader.readUInt(reader.offset)
            if (signature == CUSTOM_SIGNATURE) {
                console.log('Custom .igz file detected !')

                this.custom_file = true
                this.objects.forEach(e => {
                    const value = reader.readByte()
                    const is_custom = (value & 1) != 0
                    const has_name_hash = (value & 2) != 0
                    const is_updated = (value & 4) != 0
                    e.custom = is_custom
                    e.original = !is_updated && !is_custom
                    if (has_name_hash) e.original_name_hash = reader.readUInt()
                })

                if (reader.offset == buffer.byteLength - 4) {
                    let tmp = this.type
                    const index = reader.readUInt()
                    this.type = FILE_TYPE_ORDER[index]
                    console.log('File type:', tmp, '->', this.type)
                }
            }
        }
        
        if (this.type == null) {
            console.warn('File type not found for', this.path)
            this.type = 'igx_entities'
        }

        this.setupFixups()
    }

    /**
     * Create a new object and add it to the igz file
     * 
     * @param {string} type - Object type
     * @param {string | null} name - Object name (optional)
     * @returns {igObject} The new object
     */
    createObject(type, name) {
        const lastObject = this.objects[this.objects.length - 2]
        const offset = lastObject.offset + 4

        this.objects[this.objects.length - 1].offset += 4

        const size = TYPES_METADATA[type].size
        const data = new Array(size).fill(0)

        const typeID = this.addTMET(type)
        const nameID = name == null ? -1 : this.addTSTR(name)

        const object = new igObject({ 
            type, typeID,
            name, nameID,
            offset, size, data, 
            chunk_info: this.chunk_infos[1],
            global_offset: this.getGlobalOffset(offset),
            custom: true, updated: true
        })
        object.view.setInt(typeID, 0)

        this.addObject(object)
        if (name != null) 
            this.addNamedHandle(name)
        this.updated = true

        console.log('Created object:', object.getName())

        return object
    }

    /**
     * Clone an existing object and add it to the igz file
     * 
     * @param {igObject} object - The object to clone
     */
    cloneObject(object, name) {
        const createClone = (object, name) => {
            const lastObject = this.objects[this.objects.length - 2]
            this.objects[this.objects.length - 1].offset += 4

            const clone = object.clone(this, lastObject.offset + 4, name)
            this.addObject(clone)
            if (name != null)
                this.addNamedHandle(object.name)

            console.log('Created object (clone):', clone.getName())
            return clone
        }

        const findSuitableName = (name) => {
            const reg = new RegExp('(.*)_([0-9]+)?$')
            const match = reg.exec(name)
            let i = 1

            if (match) {
                name = match[1]
                i = parseInt(match[2]) + 1
            }

            while (this.objects.some(e => e.name == name + '_' + i)) i++

            return name + '_' + i
        }

        if (name == null && object.nameID != -1) {
            name = findSuitableName(object.name)
        }
        const clone = createClone(object, name)

        const objects = [ clone ]
        const igComponentList = clone.tryGetChild('igComponentList')
        const igEntityTransform = clone.tryGetChild('igEntityTransform')

        if (igComponentList != null) {
            const igClone = createClone(igComponentList)
            const offset = clone.objectRefs.find(e => e.child == igComponentList).offset
            clone.activateFixup('ROFS', offset, true, igClone)
            objects.push(igClone)
        }
        if (igEntityTransform != null) {
            const igClone = createClone(igEntityTransform)
            const offset = clone.objectRefs.find(e => e.child == igEntityTransform).offset
            clone.activateFixup('ROFS', offset, true, igClone)
            objects.push(igClone)
        }

        this.updated = true
        return objects
    }

    /**
     * Add an object to the end of the file, before the igNameList
     * Also adds a handle to the EXNM fixup if the object has a name
     */
    addObject(object) {
        const index = this.objects.length - 2
        this.objects = this.objects.slice(0, index + 1).concat(object, this.objects.slice(index + 1))

        if (object.name != '') {
            object.nameID = this.addTSTR(object.name)
        }
    }

    /**
     * Rename an object (update TSTR)
     * 
     * @param {igObject} object 
     * @param {string} name 
     */
    renameObject(object, name) {
        const tstr = this.fixups.TSTR
        const nameID = tstr.data.findIndex(name => name == object.name)
        if (nameID == -1) return console.warn('No TSTR entry found for', object.name)

        // Update TSTR
        const newTSTR = tstr.data.slice()
        newTSTR[nameID] = name
        tstr.updateData(newTSTR)
        
        // Update object
        object.name = name
        object.nameID = nameID
        object.updated = true

        this.updated = true
        this.updateObjects()
    }

    /**
     * Delete an object from the igz file
     * 
     * @param {igObject} object - The object to delete
     * @param {boolean} recursive - Delete all (unreferenced) children recursively
     */
    deleteObject(object, recursive = false) {
        const index = this.objects.indexOf(object)
        if (index == -1) return console.warn('Object not found, skip delete:', object.name, this.path)

        object.deleted = true

        this.updated = true
        this.objects.splice(index, 1)
        console.log('Deleted object:', object.getName())

        if (recursive) {
            object.children.forEach(e => {
                if (e.object.references.some(e => e != this.objectList && !e.deleted)) return
                this.deleteObject(e.object, true)
            })
        }
    }

    /**
     * Update every fixup and igObjectRef after adding a new object
     * 
     * @param {igObject} newObject - The new object
     */
    updateObjects(newObjects = []) {
        let namedObjects = this.objectList.getList().map((e) => this.findObject(e))
                               .concat(newObjects.filter(e => e.nameID != -1))
                               .filter(e => e != null)
        
        // Update igObjectList + igNameList fixups
        this.objectList.clearFixups()
        this.objectList.updateList(namedObjects.map(_ => 0))
        this.objectList.activateFixup('ROFS', 0x20, true, this.objectList, igListHeaderSize)

        this.nameList.clearFixups()
        this.nameList.updateList(namedObjects.map(e => [this.fixups.TSTR.data.indexOf(e.name), computeHash(e.name)]).flat())
        this.nameList.activateFixup('ROFS', 0x20, true, this.nameList, igListHeaderSize)

        for (let i = 0; i < namedObjects.length; i++) {
            const newID = this.fixups.TSTR.data.indexOf(namedObjects[i].name)
            if (newID == -1) console.warn('Name not found:', namedObjects[i].name)
            namedObjects[i].nameID = newID
            this.nameList.activateFixup('RSTT', 0x28 + 16 * i, true, newID)
            this.objectList.activateFixup('ROFS', 0x28 + 8 * i, true, namedObjects[i])
        }

        // Update objects offsets
        const sorted_objects = this.objects.sort((a, b) => a.offset - b.offset)
        for (let i = 1; i < sorted_objects.length; i++) {
            const object = sorted_objects[i]
            const offset = sorted_objects[i - 1].offset + sorted_objects[i - 1].size

            // Align to 16 bytes
            object.offset = offset % 16 == 0 ? offset : offset + 16 - (offset % 16)
        }

        // Update igObjectRefs
        for (const object of this.objects) {
            for (const {child, relative_offset, offset} of object.objectRefs) {
                object.view.setUInt(child.offset + relative_offset, offset)
            }
        }

        // Update igObjectList data
        this.objectList.updateList(namedObjects.map(e => e.offset))

        // Update fixups
        Object.keys(this.fixups).forEach(fixup => {
            const updateMethod = this['build' + fixup]
            if (updateMethod == null) return
            
            const data = updateMethod.bind(this)()
            this.fixups[fixup].updateData(data)
        })

        // Update chunk infos
        const lastObject = this.objects[this.objects.length - 1]
        this.chunk_infos[0].size = Object.values(this.fixups).filter(e => e.isActive()).reduce((a, b) => a + b.size, 0)
        this.chunk_infos[1].offset = this.chunk_infos[0].offset + this.chunk_infos[0].size
        this.chunk_infos[1].size = lastObject.offset + lastObject.size

        // Update objects types, IDs and global offsets
        this.objects.forEach((object, i) => {
            const typeID = this.fixups.TMET.data.indexOf(object.type)
            object.view.setUInt(typeID, 0)
            object.typeID = typeID

            object.index = i
            object.global_offset = this.getGlobalOffset(object.offset)
        })

        // Update objects references
        this.setupChildrenAndReferences('root', true)
    }

    save(filePath) {
        this.setupChildrenAndReferences('root', true)

        // Calculate file size
        const fileSize = this.chunk_infos[0].offset 
                         + this.chunk_infos.reduce((a, b) => a + b.size, 0)
                         + this.objects.length 
                         + this.objects.filter(e => e.custom).length * 4 
                         + 4
                         + 4

        // Write full header
        const buffer = new Uint8Array(this.header.concat(new Array(fileSize - this.header.length).fill(0)))
        const writer = new BufferView(buffer)

        // Re-write chunk infos
        writer.seek(16) // Skip header
        this.chunk_infos.forEach(e => e.save(writer))

        // Write fixups
        writer.seek(this.chunk_infos[0].offset)
        FIXUP_ORDER.forEach(e => {
            if (this.fixups[e]?.isActive()) 
                this.fixups[e].save(writer)
        })

        // Write objects
        const objects_start = this.chunk_infos[1].offset
        writer.seek(objects_start)
        this.objects.forEach(e => {
            if (e.offset % 4 != 0) throw new Error('Unaligned offset: ' + e.offset)
            writer.seek(objects_start + e.offset)
            e.save(writer, objects_start)
        })

        // Write custom data
        writer.setInt(CUSTOM_SIGNATURE)
        this.objects.forEach(e => {
            let val = e.custom ? 0b11 : 0
            if (!e.original || e.updated) val |= 0b100
            writer.setByte(val)
            if (e.custom) writer.setUInt(e.original_name_hash)
        })
        writer.setInt(FILE_TYPE_ORDER.indexOf(this.type))

        this.updated = false
        this.objects.forEach(e => e.updated = false)

        if (filePath) {
            writeFileSync(filePath, writer)
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

        return all_paths
    }

    /**
     * Update the TSTR and chunk_info objects of this package file
     * Only call this function on *_pkg.igz files
     * @param {string[]} file_paths List containing all paths of the parent .pak archive
     * @returns New igz file buffer
     */
    updatePKG(file_paths) 
    {
        const filesByType = Object.fromEntries(FILE_TYPE_ORDER.map(e => [e, []]))
        const types = new Set()

        this.setupChildrenAndReferences()
        
        file_paths = file_paths.sort((a, b) => a.path.localeCompare(b.path))

        // Group files by type
        for (let i = 0; i < file_paths.length; i++) {
            const { path, type } = file_paths[i]

            if (type == 'unknown') throw new Error('Type unknown for ' + path)
            if (type == null) console.warn('Type not found for ' + path)
            if (filesByType[type] == null) throw new Error(`Type not found: ${type} for ${path}`)

            types.add(type)
            filesByType[type].push({path, type})
        }

        // Build new TSTR data
        const files = FILE_TYPE_ORDER.map(e => filesByType[e]).flat()
        const new_TSTR  = Array.from(types).sort((a, b) => a.localeCompare(b))
                         .concat(files.map(e => e.path))
                         .concat('chunk_info')

        // Update TSTR
        this.fixups.TSTR.data = new_TSTR

        // Build new igStreamingChunkInfo data
        const chunk_info_data = []
        for (let i = 0; i < files.length; i++) {
            const { path, type } = files[i]
            const file_path_id = new_TSTR.indexOf(path)
            const file_type_id = new_TSTR.indexOf(type)

            if (file_path_id == -1) throw new Error('File path not found: ' + path)
            if (file_type_id == -1) throw new Error('File type not found: ' + type)

            chunk_info_data.push([file_type_id, file_path_id])
        }

        // Update igStreamingChunkInfo object
        const chunk_info = this.objects[1]
        chunk_info.updatePKG(chunk_info_data)

        this.updateObjects()

        return this.save()
    }

    /**
     * Find children and references for all objects using fields of type
     * igObjectRef, igMemoryRef and igVector that appear in ROFS
     */
    setupChildrenAndReferences(mode = 'root', updateReferenceCount = false) {
        for (const object of this.objects) {
            object.children = []
            object.references = []
            object.objectRefs = []
            object.referenceCount = 0 // Reference count (as per refCounted)
            object.invalid = null
        }

        for (const object of this.objects) 
        {
            const addChild = (child, refCounted = false) => 
            {
                if (child != null && child != object) {
                    if (!object.children.some(e => e.object == child)) {
                        object.children.push({ object: child, offset: 1e7 })
                        child.references.push(object)
                    }
                    if (refCounted) 
                        child.referenceCount++
                }
            }

            const addObjectRef = (offset, parentObject, relativeParentOffset, refCounted = true) => {
                if (offset == 0 || !parentObject.fixups.ROFS.includes(relativeParentOffset)) return

                const child = this.findObject(offset)
                addChild(child, refCounted)

                if (child.offset != offset) console.warn('Invalid object ref', object.getName(), + child.offset + ' != ' + offset)

                parentObject.objectRefs.push({ child, relative_offset: offset - child.offset, offset: relativeParentOffset })
            }

            const addHandle = (handle, parentObject, relativeParentOffset) => {
                const isHandle = handle & 0x80000000
                if (!isHandle) return

                const isActive = parentObject.fixups.RHND.includes(relativeParentOffset)
                if (!isActive) return
                const [name, file] = this.named_handles[handle & 0x3FFFFFFF]

                const child = this.objects.find(e => e.name == name)
                addChild(child)
            }

            const metadata = object.getFieldsMetadata(this)

            metadata.forEach(field => 
            {
                if (field.type == 'igObjectRefMetaField') {
                    const offset = object.view.readUInt(field.offset)
                    addObjectRef(offset, object, field.offset, field.refCounted)
                }
                else if (field.type == 'igHandleMetaField') {
                    if (mode == 'alchemist') return
                    const handle = object.view.readUInt(field.offset)
                    addHandle(handle, object, field.offset)
                }
                else if (field.type == 'igRawRefMetaField') {
                    if (object.fixups.ROFS.includes(field.offset)) {
                        const offset = object.view.readUInt(field.offset)
                        object.objectRefs.push({ child: object, relative_offset: offset - object.offset, offset: field.offset })
                    }
                }
                else if (field.type == 'igObjectRefArrayMetaField') {
                    const count = field.size / 8
                    for (let i = 0; i < count; i++) {
                        const offset = object.view.readUInt(field.offset + i * 8)
                        addObjectRef(offset, object, field.offset + i * 8, field.refCounted)
                    }
                }
                else if (field.type == 'igMemoryRefMetaField' || field.type == 'igVectorMetaField') {
                    const memoryStart = field.type == 'igMemoryRefMetaField' ? 0 : 8
                    const {data, relative_offset, parent, active} = object.extractMemoryData(this, field.offset + memoryStart, 8)

                    if (active) {
                        object.objectRefs.push({ child: parent, relative_offset, offset: field.offset + memoryStart + 8, type: 'memory' })

                        if (field.memType == 'igObjectRefMetaField' || 
                            field.memType == 'DotNetDataMetaField'  || 
                            field.memType == 'igHandleMetaField') {

                            data.forEach((value, i) => {
                                if (field.memType == 'igHandleMetaField') {
                                    if (mode == 'alchemist') return
                                    addHandle(value, parent, relative_offset + i * 8)
                                }
                                else {
                                    addObjectRef(value, parent, relative_offset + i * 8, field.refCounted)
                                }
                            })
                        }
                    }
                }
            })
        }

        // Update reference count
        this.objects.forEach(object => {
            const ref = object.view.readUInt(8)

            if (ref != object.referenceCount) {
                if (updateReferenceCount) {
                    console.log('Updated reference count for ' + object.getName() + ' from ' + ref + ' to ' + object.referenceCount)
                    object.view.setUInt(object.referenceCount, 8)
                }
                else {
                    object.invalid = 'Invalid reference count'
                    console.warn('Invalid reference count for ' + object.getName() + ': ' + ref + ' != ' + object.referenceCount)
                }
            }
        })
    }

    /**
     * Finds the references to the external objects defined in the EXID fixup
     * 
     * @param {string} archives_folder - The path to the archives/ folder of the game
     * @param {Pak} pak - The parent PAK object, if already loaded (optional, avoid loading the same PAK multiple times)
     */
    setupEXID(archives_folder, pak) 
    {
        if (!this.fixups.EXID) return

        const findFileInPAK   = (pak, file_hash)   => pak.files.find(e => computeHash(extractName(e.path)) == file_hash)
        const findObjectInIGZ = (igz, object_hash) => igz.objects.find(e => computeHash(e.name) == object_hash)

        const internal_files = {}
        const external_paks  = {}
        const new_exid = []

        // Group objects by file, and by pak
        for (const [index, [object_hash, file_hash]] of Object.entries(this.fixups.EXID.data)) {
            const file_info = pak != null ? findFileInPAK(pak, file_hash) : null

            if (file_info != null) {
                internal_files[file_info.path] ??= []
                internal_files[file_info.path].push({ id: Number(index), object_hash })
            }
            else {
                const file_data = namespace_hashes[file_hash]

                if (file_data == null) {
                    console.warn(`File not found: ${index}, ${file_hash}, ${object_hash}`)
                    new_exid[index] = [object_hash, file_hash]
                    continue
                }
                if (file_data.pak == null) {
                    const name_data = namespace_hashes[object_hash]
                    new_exid[index] = [ name_data?.namespace ?? '<ERROR>', file_data.namespace ]
                    continue
                }

                external_paks[file_data.pak] ??= {}
                external_paks[file_data.pak][file_data.path] ??= []
                external_paks[file_data.pak][file_data.path].push({ id: Number(index), object_hash })
            }
        }

        const addObjectsFromPak = (pak, files) => {
            for (const file in files) {
                const file_infos = pak.files.find(e => e.path == file)
                const igz = IGZ.fromFileInfos(file_infos)

                for (const {id, object_hash} of files[file]) {
                    const object = findObjectInIGZ(igz, object_hash)
                    if (object == null) console.warn('Object not found: ' + file)
                    new_exid[id] = [object?.name ?? '<ERROR>', file]
                }
            }
        }

        // Add objects from current pak
        if (pak != null) 
            addObjectsFromPak(pak, internal_files)

        // Add objects from external paks
        for (const pak_path in external_paks) {
            const external_pak = Pak.fromFile(join(archives_folder, pak_path))
            addObjectsFromPak(external_pak, external_paks[pak_path])
        }

        this.fixups.EXID.data = new_exid
    }
    
    setupFixups() {
        let last_offsets = {
            RSTT: 0,
            RHND: 0,
            ROFS: 0,
            RNEX: 0,
            REXT: 0,
            RPID: 0
        }

        for (const object of this.objects) {
            const addFixup = (name) => {
                if (this.fixups[name] == null) return
                let index = last_offsets[name]
                let nextOffset = this.fixups[name].data[index]
                while (nextOffset < object.offset + object.size) {
                    index++
                    last_offsets[name]++
                    object.fixups[name].push(nextOffset - object.offset)
                    nextOffset = this.fixups[name].data[index]
                }
            }
            ['RSTT', 'RHND', 'ROFS', 'RNEX', 'REXT', 'RPID'].forEach(addFixup)
        }
    }

    /**
     * Get the index of a string in the TSTR fixup.
     * Create a new entry if it does not exist.
     * 
     * @param {string} name - Entry Name
     */
    addTSTR(name) {
        if (name == null) throw new Error('Name is null')

        const index = this.fixups.TSTR.data.indexOf(name)
        if (index != -1) return index

        console.log('Add TSTR:', name)

        this.fixups.TSTR.data.push(name)

        this.updated = true
        return this.fixups.TSTR.data.length - 1
    }

    /**
     * Get the index of a type in the TMET fixup.
     * Create a new entry in TMET and MTSZ if it does not exist.
     * 
     * @param {string} type - Type name
     */
    addTMET(type) {
        if (type == null) throw new Error('Type is null')

        const index = this.fixups.TMET.data.indexOf(type)
        if (index != -1) return index

        const size = TYPES_METADATA[type].size

        console.log('Add TMET:', type, size)

        const lastTMET = this.fixups.TMET.data.pop()
        const lastSize = this.fixups.MTSZ.data.pop()
        this.fixups.TMET.updateData(this.fixups.TMET.data.concat(type, lastTMET)) // Add type name
        this.fixups.MTSZ.updateData(this.fixups.MTSZ.data.concat(size, lastSize)) // Add type size

        this.updated = true
        return this.fixups.TMET.data.length - 1
    }

    /**
     * Remove a type from the TMET and MTSZ fixups.
     * 
     * @param {string} type - Type name
     */
    removeTMET(type) {
        const id = this.fixups.TMET.data.indexOf(type)
        if (id == -1) return console.warn('Type not found:', type)

        this.fixups.TMET.data.splice(id, 1)
        this.fixups.MTSZ.data.splice(id, 1)

        this.fixups.TMET.updateData(this.fixups.TMET.data)
        this.fixups.MTSZ.updateData(this.fixups.MTSZ.data)

        this.objects.forEach(e => {
            const typeID = this.fixups.TMET.data.indexOf(e.type)
            e.view.setInt(typeID, 0)
            e.typeID = typeID
        })
    }

    /**
     * Get the index of an entry in the EXID fixup.
     * Creates a new entry if it does not exist
     * 
     * @param {string} name - Object name hash
     * @param {string} path - File path hash
     */
    addEXID(name, path) {
        if (this.fixups.EXID == null) return console.warn('No EXID fixup found')

        const exidData = this.fixups.EXID.extractData()
        for (const [i, [n, p]] of exidData.entries()) {
            if (n == name && p == path) return parseInt(i)
        }

        this.fixups.EXID.updateData(exidData.concat([[name, path]]))
        this.fixups.EXID.data.push([name, path])
        
        console.log('Add EXID:', name, path)

        this.updated = true
        return this.fixups.EXID.data.length - 1
    }

    /**
     * Adds a handle to the EXNM fixup and named_handles list if it does not exist
     * 
     * @param {string} name - Object name
     * @param {string} path - File path
     */
    addEXNM(name, path, isHandle = true) {
        if (this.fixups.EXNM == null) return console.warn('No EXNM fixup found')

        const file = extractName(path)
        let fileID = this.addTSTR(file)
        const objectID = this.addTSTR(name)

        if (isHandle) fileID |= 0x80000000

        const exnmData = this.fixups.EXNM.extractData()

        for (const [i, [n, f]] of exnmData.entries()) {
            if (n == objectID && f == fileID) return
        }

        this.fixups.EXNM.updateData(exnmData.concat([[objectID, fileID >>> 0]]))
        this.fixups.EXNM.data.push([name, '(New) | ' + file])
        this.updated = true

        console.log(`Add EXNM (${isHandle ? 'named_handles' : 'named_externals'}): ${name} ${file}`)
    }

    /**
     * Get the index of a handle in the named_handles list.
     * Create a new entry in the EXNM fixup if it does not exist.
     * 
     * @param {string} name - Object name
     * @param {string} file - File path
     */
    addNamedHandle(name, file) {
        file ??= extractName(this.path)

        for (const [i, [n, f]] of this.named_handles.entries()) {
            if (n == name && f == file) return parseInt(i)
        }

        this.named_handles.push([name, file])
        this.addEXNM(name, file, true)

        return this.named_handles.length - 1
    }

    /**
     * Get the index of a handle in the named_externals list.
     * Create a new entry in the EXNM fixup if it does not exist.
     * 
     * @param {string} name - Object name
     * @param {string} file - File path
     */
    addNamedExternal(name, file) {
        for (const [i, [n, f]] of this.named_externals.entries()) {
            if (n == name && f == file) return parseInt(i)
        }

        this.named_externals.push([name, file])
        this.addEXNM(name, file, false)

        return this.named_externals.length - 1
    }

    buildTDEP() {
        return this.fixups.TDEP.data
    }
    
    buildTSTR() {
        return this.fixups.TSTR.data
    }
    
    buildEXID() {
        return this.fixups.EXID.data.map(([a, b]) => [ typeof(a) == 'string' ? computeHash(a) : a, typeof(b) == 'string' ? computeHash(extractName(b)) : b ])
    }

    buildONAM() {
        return [ this.nameList.offset ]
    }

    buildNSPC() {
        return [ this.objects.filter(e => e.type == 'igNameList').pop().offset ]
    }

    buildRVTB() {
        return this.objects.map(e => e.offset)
    }

    buildRSTT() {
        return this.objects.map(e => e.fixups.RSTT.map(offset => e.offset + offset)).flat()
    }

    buildRHND() {
        return this.objects.map(e => e.fixups.RHND.map(offset => e.offset + offset)).flat()
    }

    buildROFS() {
        return this.objects.map(e => e.fixups.ROFS.map(offset => e.offset + offset)).flat()
    }

    buildRNEX() {
        return this.objects.map(e => e.fixups.RNEX.map(offset => e.offset + offset)).flat()
    }

    buildREXT() {
        return this.objects.map(e => e.fixups.REXT.map(offset => e.offset + offset)).flat()
    }

    buildRPID() {
        return this.objects.map(e => e.fixups.RPID.map(offset => e.offset + offset)).flat()
    }

    /**
     * Find the object that contains the given offset
     * 
     * @param {int} offset - The offset to search for
     * @param {boolean} global_offset - If true, search against global offsets instead of relative offsets
     * @returns {igObject} The object that contains the given offset
     */
    findObject(offset, global_offset = true) {
        offset = this.getGlobalOffset(offset)
        if (offset == -1) return null

        const maxIterations = Math.log2(this.objects.length) * 2
        let index = Math.floor(this.objects.length / 2)
        let step  = Math.floor(index / 2)
        let iterations = 0

        while(iterations++ < maxIterations) {
            const object = this.objects[index]
            const object_offset = global_offset ? object.global_offset : object.offset
            const above_start = offset >= object_offset
            const below_end = offset < object_offset + object.size

            if (above_start && below_end) return object

            if (above_start) index += step
            else index -= step

            step = Math.max(1, Math.floor(step / 2))
        }

        console.warn(`Object not found for offset ${offset} after ${iterations} iterations, falling back to full search`)
        
        return this.objects.find(e => offset >= e.global_offset && offset < e.global_offset + e.size)
    }

    /**
     * Converts an encoded offset into a global offset
     * 
     * @param {int} offset - The offset to convert
     * @returns {int} The offset relative to the start of the file
     */
    getGlobalOffset(offset) {
        const chunk_infos = this.chunk_infos[(offset >> 0x1b) + 1]
        if (chunk_infos == null) {
            // console.warn('Chunk info not found for offset: ' + offset, (offset >> 0x1b) + 1)
            return -1
        }
        return (offset & 0x7ffffff) + chunk_infos.offset
    }

    /**
     * Get all objects that have a name (included in RVTB)
     * and no reference (except for the mandatory igObjectList)
     * @returns {igObject[]} List of all root objects
     */
    getRootObjects() {
        const root = []

        for (const object of this.objects) {
            if (object.nameID != -1 && object.references.length == 1 && object.references[0] == this.objectList) {
                root.push(object)
            }
            else if (object.type == 'CEntity') {
                const [x, y, z] = object.view.readVector(3, 0x20)
                if (x == 0 && y == 0 && z == 0) continue
                root.push(object)
            }
        }

        return root
    }

    /**
     * Convert the IGZ file to a tree structure for UI display
     */
    toNodeTree(recursive = true, mode = 'root') {
        let rootText = 'Root Objects'
        let root = this.objects
        
        if (mode == 'root' || mode == 'alchemist') root = this.getRootObjects()
        else if (mode == 'named') root = this.objects.filter(e => e.nameID != -1)

        const custom_objects = this.objects.filter(e => e.custom && !e.references.some(r => r.custom))
        const unreferenced = this.objects.filter(e => e.references.length == 0)
        const vscRoot = this.objects.find(e => e.type == 'igVscMetaObject')

        this.objects.forEach(e => e.inNodeTree = false)

        if (this.objects.length > 0 && root.length == 0 && !vscRoot) {
            root = this.objects.filter(e => !unreferenced.includes(e))
            rootText = 'All Objects'
        }

        // Special display for VSC objects
        if (vscRoot) {
            root = root.filter(e => e != vscRoot)
            rootText = 'Other Objects'
        }

        // Group objects by type
        if (root.length > 0) {
            const uniqueTypes    = Array.from(new Set(root.map(e => e.type)))
            const objectsPerType = Object.fromEntries(uniqueTypes.map(e => ([e, []])))
            root.forEach(e => objectsPerType[e.type].push(e))

            const singleChildren = []
            const new_root = []
            
            uniqueTypes.forEach(type => {
                const objects = objectsPerType[type]

                if (objects.length == 1) {
                    if (!objects[0].custom) singleChildren.push(objects[0])
                    return null
                }

                new_root.push({
                    text: `${type} (${objects.length})`,
                    type: 'type-group',
                    children: objects.map(e => e.toNodeTree(recursive)).sort((a, b) => a.text.localeCompare(b.text))
                })
            })

            root = new_root
            if (singleChildren.length > 0)
                root.push({
                    text: (new_root.length > 0 ? 'Other Objects' : rootText) + ` (${singleChildren.length})`,
                    children: singleChildren.map(e => e.toNodeTree(recursive)).sort((a, b) => a.text.localeCompare(b.text))
                })
        }
        else if (unreferenced.length == 0) {
            root = [{text: 'No Objects'}]
        }

        root = root.sort((a, b) => a.text.localeCompare(b.text))
        
        if (vscRoot) {
            root = [
                vscRoot.toNodeTree(recursive),
                ...root
            ]
        }

        const tree = [{
            text: '[Fixups]',
            children: Object.values(this.fixups).map(e => e.toNodeTree(this.objects)),
        }]

        if (custom_objects.length > 0) {
            tree.push({
                text: `Custom Objects (${custom_objects.length})`,
                children: custom_objects.map(e => e.toNodeTree())
            })
        }

        tree.push(...root)

        if (unreferenced.length > 0) {
            tree.push({
                text: `Unreferenced Objects (${unreferenced.length})`,
                children: unreferenced.map(e => e.toNodeTree())
            })
        }

        return tree
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

    toFile(path) {
        const computeID = (object) => {
            const children = object.children.map(e => e.object.type + e.object.name).join('')
            const refs = object.references.map(e => e.type + e.name).join('')
            return computeHash(children + refs)
        }
        const shortName = (obj) => {
            if (obj == null) return '<ERROR>'
            let name = obj.type 
            if (obj.nameID != -1) {
                if (obj.name.length > 15) name += ': ' + obj.name.slice(0, 15) + '...'
                else name += ': ' + obj.name
            }
            name += ` (0x${computeID(obj).toString(16)})`
            return name
        }

        let str = `############    FIXUPS    ############\n`

        for (const fixupName in this.fixups) {
            const fixup = this.fixups[fixupName]
            str += `${fixupName}: ${fixup.item_count}\n`

            if (fixupName.startsWith('R') || fixupName == 'ONAM') {
                for (const offset of fixup.data) {
                    const object = this.findObject(offset)
                    str += `  => ${offset == object.offset ? ' ' : '(+' + (offset - object.offset) + ') '}${shortName(object)}\n`
                }
                str += '\n'
            }
        }

        str += `\n############    OBJECTS    ############\n`

        for (const object of this.objects) {
            if (object.size != object.data.length) throw new Error('Size mismatch: ' + object.size + ' != ' + object.data.length)
            
            str += `[${shortName(object)} (size: ${object.size})]\n`
            
            if (object.children.length > 0) {
                str += `  Children:\n`
                for (const child of object.children) {
                    str += `    => ${shortName(child.object)}\n`
                }
            }

            if (object.references.length > 0) {
                str += `  References:\n`
                for (const ref of object.references) {
                    str += `    => ${shortName(ref)}\n`
                }
            }

            if (Object.values(object.fixups).some(e => e.length > 0)) {
                str += `  Fixups:\n`
                for (const fixupName in object.fixups) {
                    const fixup = object.fixups[fixupName]
                    if (fixup.length == 0) continue
                    str += `    ${fixupName}:\n`
                    
                    if (fixupName == 'ROFS') {
                        for (const elm of fixup) {
                            const value = object.view.readUInt(elm)
                            const child = this.findObject(value)
                            const offset = value - child.offset
                            str += `      => ${offset > 0 ? offset : ' '} ${shortName(child)}\n`
                        }
                    }
                    else {
                        str += `      => ` + fixup.map(e => object.view.readUInt(e)).join(', ') + '\n'
                    }
                }
            }

            str += '\n'
        }

        writeFileSync(path, str)
    }
}

export default IGZ