import { readFileSync, writeFileSync } from "fs"
import { BufferView, bytesToUInt, intToBytes } from "../utils"
import { decompress } from 'lzma'

class FileInfos {
    constructor({ id, offset, ordinal, size, compression, full_path, path, data, original = true, updated = false, include_in_pkg = true }) {
        this.id = id
        this.offset = offset
        this.ordinal = ordinal
        this.size = size
        this.compression = compression
        this.full_path = full_path
        this.path = path

        this.data = data

        this.include_in_pkg = include_in_pkg
        this.original = original
        this.updated = updated
    }

    isCompressed() {
        return this.compression != 0xFFFFFFFF
    }

    /**
     * Rename the file while keeping the same path
     * @param {string} new_name New file name. Must contain the extension
     */
    rename(new_name) {
        const path = this.path.slice(0, this.path.lastIndexOf('/') + 1)
        const full_path = this.full_path.slice(0, this.full_path.lastIndexOf('/') + 1)
        console.log(`Renamed ${this.path} to ${path + new_name}`)
        this.path = path + new_name
        this.full_path = full_path + new_name
        this.updated = true
        this.original = false
    }

    getUncompressedData() {
        let needs_caching = false

        // If it's an original and compressed file
        if (this.original && this.isCompressed()) {
            try {
                // Try to read cached decompressed data
                return readFileSync(`./data/${this.id}`)
            }
            catch {
                // If it failed, decompress and cache it
                needs_caching = true
            }
        }
        // Case where we're trying to read custom data from the import modal
        else if (!this.original && this.data == null) {
            return readFileSync(`./data/tmp/${this.id}`)
        }
        
        // Return raw data if not compressed
        if (!this.isCompressed()) return this.data.slice()

        const CHUNK_SIZE = 32768
        const CHUNK_ALIGN = 2048

        let data = new Uint8Array(this.size)

        const checkArraySize = (size) => {
            if (data_length + size > this.size) {
                // Resize data array
                let new_buffer = new Uint8Array(data_length + size)
                new_buffer.set(data)
                data = new_buffer
                console.warn('Decompressed size bigger than expected, increasing buffer length...')
            }
        }

        const reader = new BufferView(new Uint8Array(this.data))

        let data_length = 0
        while(data_length < this.size) {
            // Try to read lzma header
            const stream_size    = reader.readUInt16()
            const properties     = reader.readByte()
            const dictionarySize = reader.readBytes(4)

            if (properties != 93 || bytesToUInt(dictionarySize) != CHUNK_SIZE) {
                reader.seek(reader.offset - 7)

                checkArraySize(CHUNK_SIZE)
                data.set(this.data.slice(reader.offset, reader.offset + CHUNK_SIZE), data_length)
                data_length += CHUNK_SIZE

                reader.seek(reader.offset + CHUNK_SIZE)
            }
            else {
                // Compute uncompressed chunk size
                const chunk_size = Math.min(this.size - data_length, CHUNK_SIZE)
                const uncompressed_size = intToBytes(chunk_size, 8) // Int64 byte array representation
                const stream = this.data.slice(reader.offset, reader.offset + stream_size)

                // https://svn.python.org/projects/external/xz-5.0.3/doc/lzma-file-format.txt
                const lzma_data = [
                    /// Header
                    properties, ...dictionarySize, ...uncompressed_size,
                    // Compressed data
                    ...stream
                ]
                
                // Decompress chunk
                const chunk = decompress(lzma_data)

                checkArraySize(chunk.length)
                data.set(chunk, data_length)
                data_length += chunk.length

                // Advance to next chunk
                reader.seek(reader.offset + stream_size)
                const padding = CHUNK_ALIGN - reader.offset % CHUNK_ALIGN
                reader.seek(reader.offset + padding)
            }
        }

        if (needs_caching) {
            writeFileSync(`./data/${this.id}`, data)
        }

        return data
    }

    // https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
    computeID() {
        const name = this.path.toLowerCase()
        let b = 0x811c9dc5

        for (let i = 0; i < name.length; i++) {
            b ^= name.charCodeAt(i)
            b += (b << 1) + (b << 4) + (b << 7) + (b << 8) + (b << 24)
        }

        this.id = b >>> 0

        return this.id
    }

    toJSON() {
        return {
            id: this.id,
            offset: this.offset,
            ordinal: this.ordinal,
            size: this.size,
            compression: this.isCompressed() ? this.compression : 'none',
            full_path: this.full_path,
            path: this.path,
            original: this.original,
        }
    }
}

export default FileInfos