import { writeFileSync, readFileSync } from 'fs'
import { BufferView, formatSize } from "../utils"
import FileInfos from './fileInfos'

const PAK_VERSION   = 11
const PAK_SIGNATURE = 0x1A414749
const CUSTOM_SIGNATURE = 0xAABBCCDD
const HEADER_SIZE   = 56
const SECTOR_SIZE   = 2048

const FILE_COUNT_LOC   = 12
const NAMES_OFFSET_LOC = 40
const NAMES_SIZE_LOC   = 48

class Pak {    
    constructor({ files = [], path } = {}) {
        this.files = files.map(e => new FileInfos(e))
        this.path = path
        this.updated = false

        this.uncompressed = false
    }

    /** Construct from .pak file path
     * @param {string} filePath path to the file
    */
    static fromFile(filePath) {
        const data = readFileSync(filePath)
        const pak = new Pak({ path: filePath })
        
        pak.initialize(data)
        
        return pak
    }

    initialize(buffer) {
        const reader = new BufferView(buffer)

        /// Read Header ///

        const file_count   = reader.readUInt(FILE_COUNT_LOC)
        const names_offset = reader.readUInt(NAMES_OFFSET_LOC)

        /// Read Files ///

        reader.seek(HEADER_SIZE)
        
        for (let i = 0; i < file_count; i++) {
            // Read file ID
            const id = reader.readUInt(HEADER_SIZE + i * 4)

            // Read file infos
            reader.seek(HEADER_SIZE + file_count * 4 + i * 16)
            const offset      = reader.readUInt()
            const ordinal     = reader.readInt()
            const size        = reader.readUInt()
            const compression = reader.readUInt()

            // Read file data
            const data = buffer.slice(offset, offset + size)

            // Read file paths
            const file_name_offset = reader.readUInt(names_offset + i * 4)
            const full_path = reader.readStr(names_offset + file_name_offset)
            const path = reader.readStr()

            this.files.push(new FileInfos({ id, offset, ordinal, size, compression, full_path, path, data }))
        }

        /// Read custom data ///

        if (reader.offset + 8 < buffer.byteLength) {
            const signature = reader.readUInt(reader.offset + 4)
            if (signature == CUSTOM_SIGNATURE) {
                this.custom_file = true
                this.files.forEach(e => e.original = reader.readByte() == 1)
                console.log('Custom file detected !')
            }
        }

        if (!this.files.every((e, i) => i == 0 || e.id > this.files[i-1].id)) throw new Error('Files are not sorted by ID')
        if (this.files.some(e => e.id != e.computeID())) throw new Error('File ID mismatch')
    }

    async save(filePath, progressCallback) {
        const file_count = this.files.length
        const INFOS_START = HEADER_SIZE + file_count * 4
        const DATA_START  = HEADER_SIZE + file_count * 20

        // Calculate file IDs
        this.files.forEach(e => e.computeID())

        // Sort files by ID (important!)
        this.files = this.files.sort((a, b) => a.id - b.id)

        // Calculate hash search divider & slop
        const { hashSearchDivider, hashSearchSlop } = this.calculateSearchDividerAndSlope()
        
        // Approximate file size upper bound
        const size = DATA_START 
            + this.files.reduce((acc, e) => acc + e.size, 0) 
            + 2048 * file_count
            + file_count * 4
            + this.files.reduce((acc, e) => acc + e.full_path.length + e.path.length + 6, 0)
        
        const buffer = new Uint8Array(size)
        const writer = new BufferView(buffer)
        const alignOffset = () => writer.offset += -writer.offset & 0x7FF

        // Write header
        writer.setInt(PAK_SIGNATURE)
        writer.setInt(PAK_VERSION)
        writer.setInt(file_count * 20)
        writer.setInt(file_count)
        writer.setInt(SECTOR_SIZE)
        writer.setInt(hashSearchDivider)
        writer.setInt(hashSearchSlop)
        writer.setBytes(new Uint8Array(24))
        writer.setInt(1)

        // Write file IDs
        this.files.forEach(e => writer.setUInt(e.id))

        // Goto start of data
        writer.seek(DATA_START)
        alignOffset()

        // Write each file data
        for (let i = 0; i < file_count; i++) {
            const file = this.files[i]
            const ordinal = (i - 1) << 0x8
            const file_data = await file.getUncompressedData()

            file.offset  = writer.offset
            file.ordinal = ordinal
            file.size    = file_data.length

            writer.setBytes(file_data)
            alignOffset()

            if (progressCallback && (i%10 == 0 || i == file_count-1)) progressCallback(i, file_count)
        }

        alignOffset()

        const NAMES_START = writer.offset

        // Goto start of name strings (skip name offsets)
        writer.seek(NAMES_START + file_count * 4)

        for (let i = 0; i < file_count; i++) {
            const file = this.files[i]

            // Write name offset
            const name_offset = writer.offset - NAMES_START
            writer.setInt(name_offset, NAMES_START + i * 4)

            // Write name strings
            writer.seek(NAMES_START + name_offset)
            writer.setChars(file.full_path)
            writer.setByte(0)
            writer.setChars(file.path)
            writer.setBytes(new Uint8Array(5))
        }

        // Write custom data
        writer.setInt(CUSTOM_SIGNATURE)
        this.files.forEach(e => writer.setByte(e.original ? 1 : 0))

        const file_size = writer.offset
        const names_size = file_size - NAMES_START

        // Update header
        writer.setInt(NAMES_START, NAMES_OFFSET_LOC)
        writer.setInt(names_size, NAMES_SIZE_LOC)

        // Goto start of file infos
        writer.seek(INFOS_START)

        // Write file infos
        for (const file of this.files) {
            writer.setInt(file.offset)
            writer.setInt(file.ordinal)
            writer.setInt(file.size)
            writer.setInt(0xFFFFFFFF) // No compression
        }

        this.updated = false
        this.files.forEach(e => e.updated = false)

        writeFileSync(filePath, writer.buffer.slice(0, file_size))
    }

    calculateSearchDividerAndSlope() {
        const file_count = this.files.length
        const hashSearchDivider = Math.floor(0xFFFFFFFF / file_count)
        let hashSearchSlop = 0

        for (hashSearchSlop = 0; hashSearchSlop < file_count; hashSearchSlop++) {
            const matches = this.files.filter(e => this.hash_search(hashSearchDivider, hashSearchSlop, e.id) !== -1)

            if (matches.length == file_count) break
        }

        return { hashSearchDivider, hashSearchSlop }
    }

    hash_search(hashSearchDivider, hashSearchSlope, fileId) {
        let fileIdDivided = Math.floor(fileId / hashSearchDivider)
        let searchAt = 0
    
        if (hashSearchSlope < fileIdDivided)
            searchAt = (fileIdDivided - hashSearchSlope) >>> 0
    
        fileIdDivided += hashSearchSlope + 1
    
        let numFiles = Math.min(this.files.length, fileIdDivided)
    
        let index = searchAt
        searchAt = (numFiles - index) >>> 0
        let i = searchAt
    
        while (i > 0) {
            i = Math.floor(searchAt / 2)
    
            if (this.files[index + i].id < fileId) {
                index += i + 1
                i = (searchAt - 1 - i) >>> 0
            }
    
            searchAt = i
        }
    
        if (index < this.files.length && this.files[index].id === fileId) {
            return index
        }
    
        return -1
    }

    async cloneFile(index) {
        const file = this.files[index]
        
        const updatePath = (str) => str.slice(0, str.lastIndexOf('.')) + '_Copy' + str.slice(str.lastIndexOf('.'))

        const new_data = await file.getUncompressedData()

        const new_file = new FileInfos({ 
            ...this.files[index],
            size: new_data.length,
            data: new_data,
            full_path: updatePath(file.full_path),
            path: updatePath(file.path),
            original: false,
            updated: true
        })

        this.files.push(new_file)
        this.updated = true
    }

    deleteFile(index) {
        this.files.splice(index, 1)
        this.updated = true
    }

    replaceFileWithinPak(index1, index2) {
        this.files[index1].id = 'will recalculate'
        this.files[index1].offset = 'will recalculate'
        this.files[index1].ordinal = 'will recalculate'
        this.files[index1].size = this.files[index2].size
        this.files[index1].compression = this.files[index2].compression
        this.files[index1].data = this.files[index2].data.slice()

        this.files[index1].original = this.files[index2].original && this.files[index1].path == this.files[index2].path
        this.files[index1].updated = true
        this.updated = true
    }

    toNodeTree() {
        const total_size = this.files.reduce((acc, e) => acc + e.size, 0)
        const tree = []

        for (let i = 0; i < this.files.length; i++) {
            let folders = this.files[i].full_path.split('/')
            let fileName = folders.pop()
            
            let parent = null
            let folderPath = folders[0]
            for (let j = 0; j < folders.length; j++) {
                let node = tree.find(e => e.path == folderPath)

                if (node == null) {
                    node = { 
                        text: folders[j] + '/', 
                        path: folderPath,
                        type: 'folder',
                        file_count: 0,
                        size: 0,
                        children: []
                    }
                    tree.push(node)
                }

                if (parent != null) {
                    if (!parent.children.includes(node)) {
                        parent.children.push(node)
                    }

                    parent.file_count++
                    parent.size += this.files[i].size
                }


                folderPath += '/' + folders[j+1]
                parent = node
            }

            parent.children.push({
                text: fileName + (this.files[i].updated ? '*' : ''),
                type: 'file',
                fileIndex: i
            })
            parent.file_count++
            parent.size += this.files[i].size
        }

        tree.forEach(e => {
            e.size = formatSize(e.size) + ` (${(e.size / total_size * 100).toFixed(2)}%)`
            e.children = e.children.sort((a, b) => a.text.localeCompare(b.text))
        })

        let root = tree[0]

        while (root.children.length == 1) {
            root.children[0].text = root.text + root.children[0].text
            root = root.children[0]
        }

        return [ root ]
    }
}

export default Pak