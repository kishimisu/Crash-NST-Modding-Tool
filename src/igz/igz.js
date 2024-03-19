import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BufferView, computeHash, extractName } from '../utils.js'
import Fixup from './fixup.js'
import igObject from './igObject.js'
import ChunkInfo from './chunkInfos.js'
import Pak from '../pak/pak.js'

import { namespace_hashes, file_types } from '../app/components/utils/metadata.js'


const IGZ_VERSION      = 10
const IGZ_SIGNATURE    = 0x49475A01
const CUSTOM_SIGNATURE = 0xAABBCCDD

class IGZ {
    constructor(igz_data, path) {
        this.path = path
        this.updated = false
        this.header = null
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
            if (object == null) return console.warn(`Entry #${i} (offset: ${offset}, name: ${name}) is not present in RVTB`)

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

        /// Read custom data ///

        const lastChunk = this.chunk_infos[this.chunk_infos.length - 1]
        reader.seek(lastChunk.offset + lastChunk.size)

        if (reader.offset < buffer.byteLength) {
            const signature = reader.readUInt(reader.offset)
            if (signature == CUSTOM_SIGNATURE) {
                this.custom_file = true
                this.objects.forEach(e => e.custom = reader.readByte() == 1)
                console.log('Custom .igz file detected !')
            }
        }

        this.setupFixups()
    }

    /**
     * Clone an object and update every fixup and igObjectRef accordingly
     * 
     * @param {igObject} object - The object to clone
     */
    cloneObject(object) {
        const createClone = (object) => {
            const index = this.objects.length - 2
            const lastObject = this.objects[index]
            const clone = object.clone(this, lastObject.offset + 4)
            this.objects = this.objects.slice(0, index + 1).concat(clone, this.objects.slice(index + 1))

            if (clone.nameID != -1) {
                const length = this.objectList.getList().length
                this.fixups.TSTR.updateData(this.fixups.TSTR.data.concat(clone.name))
                this.objectList.fixups.ROFS.push(0x28 + 8 * (length))
                this.nameList.fixups.RSTT.push(0x28 + 16 * (length))
                this.addHandle(clone.name)
            }

            return clone
        }

        const clone = createClone(object)

        const igComponentList = clone.tryGetChild('igComponentList')
        if (igComponentList != null) {
            const igClone = createClone(igComponentList)
            const childIndex = clone.children.findIndex(e => e.object == igComponentList)
            clone.children[childIndex].object = igClone

            const objectRefIndex = clone.objectRefs.findIndex(e => e.child == igComponentList)
            clone.objectRefs[objectRefIndex].child = igClone

            const parentIndex = igClone.references.findIndex(e => e == igComponentList)
            igClone.references[parentIndex] = clone

            this.updateObjects([clone, igClone])
        }
        else 
            this.updateObjects([clone])

        this.updated = true
    }

    /**
     * Rename an object (update in TSTR)
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
     * Adds a handle to the EXNM fixup and named_handles list
     * 
     * @param {string} name - Handle name. Must exist in TSTR
     */
    addHandle(name) {
        const file = extractName(this.path)
        if (!this.fixups.TSTR.data.includes(file)) this.fixups.TSTR.updateData(this.fixups.TSTR.data.concat(file))
        const fileID = this.fixups.TSTR.data.indexOf(file)
        const objectID = this.fixups.TSTR.data.indexOf(name)

        const exnmData = this.fixups.EXNM.extractData().concat([[objectID, (fileID | 0x80000000) >>> 0]])
        this.fixups.EXNM.updateData(exnmData)
        this.fixups.EXNM.data.push([name, 'Handle | ' + file])
        this.named_handles.push([name, file])
    }

    /**
     * Update every fixup and igObjectRef after adding a new object
     * 
     * @param {igObject} newObject - The new object
     */
    updateObjects(newObjects = []) {
        let namedObjects = this.objectList.getList().map((e) => this.findObject(e))
                               .concat(newObjects.filter(e => e.nameID != -1))

        this.objectList.size += newObjects.length * 8
        
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
            // child: referenced igObject
            // relative_offset: offset from referenced igObject start
            // offset: igObjectRef offset
            for (const {child, relative_offset, offset} of object.objectRefs) {
                object.view.setUInt(child.offset + relative_offset, offset)
            }
        }

        // Update igObjectList + igNameList
        this.objectList.updateList(namedObjects.map(e => e.offset))
        this.nameList.updateList(namedObjects.map(e => [this.fixups.TSTR.data.indexOf(e.name), computeHash(e.name)]).flat())

        // Update fixups
        Object.keys(this.fixups).forEach(fixup => {
            const updateMethod = this['build' + fixup]
            if (updateMethod == null) return
            const data = updateMethod.bind(this)()
            if (data.length != this.fixups[fixup].data.length) console.log('Updated fixup size for ' + fixup + ' from ' + this.fixups[fixup].data.length + ' to ' + data.length)
            this.fixups[fixup].updateData(data)
        })

        // Update chunk infos
        this.chunk_infos[0].size = Object.values(this.fixups).reduce((a, b) => a + b.size, 0)
        this.chunk_infos[1].offset = this.chunk_infos[0].offset + this.chunk_infos[0].size
        this.chunk_infos[1].size = this.nameList.offset + this.nameList.size

        // Update global offsets
        this.objects.forEach((object, i) => {
            object.global_offset = this.getGlobalOffset(object.offset)
            object.index = i
        })

        // Update references
        this.setupChildrenAndReferences('root', true)
    }

    save(filePath) {
        this.setupChildrenAndReferences('root', true)

        // Calculate file size
        const fileSize = this.chunk_infos[0].offset + this.chunk_infos.reduce((a, b) => a + b.size, 0) + this.objects.length + 4

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
            writer.seek(objects_start + e.offset)
            if (e.offset % 4 != 0) throw new Error('Unaligned offset: ' + e.offset)
            e.save(writer, objects_start)
        })

        // Write custom data
        writer.setInt(CUSTOM_SIGNATURE)
        this.objects.forEach(e => writer.setByte(e.custom ? 1 : 0))

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
        const typesOrder = [
            'script', 'sound_sample', 'sound_bank', 'lang_file', 'loose', 'shader',
            'texture', 'material_instances', 'font', 'vsc', 'igx_file', 
            'havokrigidbody', 'model', 'asset_behavior', 
            'havokanimdb', 'hkb_behavior', 'hkc_character', 
            'behavior', 'sky_model', 'effect', 'actorskin', 
            'sound_stream', 'character_events', 'graphdata_behavior', 
            'character_data', 'gui_project',
            'navmesh', 'igx_entities', 'pkg'
        ]

        const filesByType = Object.fromEntries(typesOrder.map(e => [e, []]))
        const types = new Set()

        this.setupChildrenAndReferences()
        
        file_paths = file_paths.sort((a, b) => a.localeCompare(b))

        // Group files by type
        for (let i = 0; i < file_paths.length; i++) {
            const path = file_paths[i]
            const type = file_types[computeHash(path)]

            if (type == 'unknown') throw new Error('Type unknown for ' + path)
            if (type == null) console.warn('Type not found for ' + path)
            if (filesByType[type] == null) throw new Error('Type not implemented: ' + type)

            types.add(type)
            filesByType[type].push({path, type})
        }

        // Build new TSTR data
        const files = typesOrder.map(e => filesByType[e]).flat()
        const new_TSTR  = Array.from(types).sort((a, b) => a.localeCompare(b))
                         .concat(files.map(e => e.path))
                         .concat('chunk_info')

        // Update TSTR
        this.fixups.TSTR.updateData(new_TSTR)

        // Build new igStreamingChunkInfo data
        const chunk_info_data = []
        for (let i = 0; i < files.length; i++) {
            const { path, type } = files[i]
            const file_path_id = new_TSTR.indexOf(path)
            const file_type_id = new_TSTR.indexOf(type)

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
                    new_exid[index] = [object_hash.toString(), file_hash.toString()]
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
        for (const object of this.objects) {
            object.fixups = {}
            const addFixup = (name) => {
                object.fixups[name] = []
                if (this.fixups[name] == null) return
                for (let offset of this.fixups[name].data) {
                    offset = this.getGlobalOffset(offset)
                    if (offset >= object.global_offset + object.size) break
                    if (offset >= object.global_offset) {
                        object.fixups[name].push(offset - object.global_offset)
                    }
                }
            }
            ['RSTT', 'RHND', 'ROFS', 'RNEX', 'REXT', 'RPID'].forEach(addFixup)
        }
    }
    
    buildONAM() {
        return [ this.nameList.offset ]
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
        if (global_offset) {
            offset = this.getGlobalOffset(offset)
            if (offset == -1) return null
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

        const custom_objects = this.objects.filter(e => e.custom && e.references.some(r => !r.custom))
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
        },
            ...root
        ]

        if (custom_objects.length > 0) {
            tree.push({
                text: `Custom Objects (${custom_objects.length})`,
                children: custom_objects.map(e => e.toNodeTree())
            })
        }

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
}

export default IGZ