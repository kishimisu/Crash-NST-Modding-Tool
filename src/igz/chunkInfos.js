class ChunkInfo {
    constructor(offset, size, magic1, magic2) {
        this.offset = offset // Start position in file
        this.size = size     // Size in bytes
        this.magic1 = magic1
        this.magic2 = magic2
    }

    static fromBuffer(reader) {
        const magic1 = reader.readInt()
        const magic2 = reader.readInt()
        const offset = reader.readInt()
        const size   = reader.readInt()

        if (offset == 0) return null

        return new ChunkInfo(offset, size, magic1, magic2)
    }

    save(writer) {
        writer.setInt(this.magic1)
        writer.setInt(this.magic2)
        writer.setInt(this.offset)
        writer.setInt(this.size)
    }

    toString() {
        return {
            offset: this.offset,
            size: this.size
        }
    }
}

export default ChunkInfo