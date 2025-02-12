import { readFileSync, writeFileSync } from "fs"
import { bytesToUInt16, computeHash, intToBytes } from "../utils"
import { decompress } from 'lzma'
import { getCacheFolder, getTempFolder } from "../app/components/utils/utils"
import { InflateRaw } from "minizlib"

class FileInfos {
    constructor({ pak, id, offset, ordinal, size, compression, full_path, path, data, original = true, updated = false, include_in_pkg = true }) {
        this.pak = pak
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

        // Case where we're trying to read updated data from the import modal
        if (this.data == null) {
            this.data = readFileSync(getTempFolder(this.id))
        }

        // Return raw data if not compressed
        if (!this.isCompressed()) {
            return this.data.slice()
        }
        // If it's an original and compressed file
        else if (this.original) {
            try {
                // Try to read cached decompressed data
                return readFileSync(getCacheFolder(this.id))
            }
            catch {
                // If it failed, decompress and cache it
                needs_caching = true
            }
        }

        const buffer = new Uint8Array(this.size)
        const numOfBlocks = ((this.size + 0x7FFF) >> 0xF)

        const getBlockInfos = (tableType, blockIndex, mask, shift) => {
            const table       = this.pak.block_tables[tableType]
            const block       = table[blockIndex]
            const blockOffset = (block & mask) * this.pak.sector_size
            const compressed  = (block >> shift) == 1
            const blockSize   = (table[blockIndex + 1] & mask) * this.pak.sector_size - blockOffset

            return { blockOffset, compressed, blockSize }
        }

        for (let blockReadIndex = 0; blockReadIndex < numOfBlocks; blockReadIndex++) {
            const blockIndex = (this.compression & 0xfffffff) + blockReadIndex
            let blockInfos

            if (this.size <= 0x7f * this.pak.sector_size) {
                blockInfos = getBlockInfos('small', blockIndex, 0x7f, 0x7)
            }
            else if (this.size <= 0x7fff * this.pak.sector_size) {
                blockInfos = getBlockInfos('medium', blockIndex, 0x7fff, 0xf)
            }
            else {
                blockInfos = getBlockInfos('large', blockIndex, 0x7fffffff, 0x1f)
            }

            const { blockOffset, compressed } = blockInfos

            const decompressedSize = (this.size < (blockReadIndex + 1) * 0x8000) ? this.size & 0x7fff : 0x8000
            const compressionType = compressed ? (this.compression >> 0x1c) : 0

            this.decompressBlock(blockReadIndex * 0x8000, decompressedSize, compressionType, blockOffset, buffer)
        }

        if (needs_caching) {
            // Cache decompressed data
            writeFileSync(getCacheFolder(this.id), buffer)
        }
        
        return buffer
    }

    decompressBlock(offset, decompressedSize, compression, sourceOffset, destination) {
        if (compression == 0) {
            destination.set(this.data.slice(sourceOffset, sourceOffset + decompressedSize), offset)
        }
        else if (compression == 1) {
            const compressedSize = bytesToUInt16(this.data, sourceOffset)
            const compressed = this.data.slice(sourceOffset + 2, sourceOffset + 2 + compressedSize)
            const uncompressed = new InflateRaw().end(compressed).read()

            destination.set(uncompressed.subarray(0, decompressedSize), offset)
        }
        else if (compression == 2) {
            const compressedSize = bytesToUInt16(this.data, sourceOffset)
            const properties     = this.data.slice(sourceOffset + 2, sourceOffset + 7)
            const stream         = this.data.slice(sourceOffset + 7, sourceOffset + 7 + compressedSize)

            const lzma_data = new Uint8Array(13 + compressedSize)
            lzma_data.set(properties, 0)
            lzma_data.set(intToBytes(decompressedSize, 8), 5)
            lzma_data.set(stream, 13)
            
            // Decompress chunk
            const chunk = decompress(lzma_data).slice(0, decompressedSize)
            destination.set(chunk, offset)
        }
        else throw new Error('decompressBlock: Unknown compression type: ' + compression)
    }

    computeHash() {
        this.id = computeHash(this.path)
        return this.id
    }

    toJSON() {
        return {
            id: this.id,
            offset: this.offset,
            ordinal: this.ordinal,
            size: this.size,
            compression: this.compression,
            full_path: this.full_path,
            path: this.path,
            original: this.original,
        }
    }
}

export default FileInfos