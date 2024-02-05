class BufferView {
    constructor(buffer, littleEndian = true) {
        this.buffer = buffer
        this.view = new DataView(buffer.buffer)
        this.littleEndian = littleEndian
        this.offset = 0
    }

    seek(offset) {
        this.offset = offset
    }

    getValue(method, size, offset) {
        this.offset = offset ?? this.offset

        if (this.offset + size > this.view.byteLength) {
            console.log(method, this.offset, size, this.view.byteLength)
            throw new Error('Reading past end of buffer')
        }

        const value = this.view[method](this.offset, this.littleEndian)
        this.offset += size

        return value
    }

    setValue(method, size, value, offset) {
        this.offset = offset ?? this.offset

        if (this.offset + size > this.view.byteLength) {
            console.log(method, this.offset, size, this.view.byteLength)
            throw new Error('Writing past end of buffer')
        }

        this.view[method](this.offset, value, this.littleEndian)
        this.offset += size
    }

    readInt    = (offset) => this.getValue('getInt32', 4, offset)
    readUInt   = (offset) => this.getValue('getUint32', 4, offset)
    readFloat  = (offset) => this.getValue('getFloat32', 4, offset)
    readUInt16 = (offset) => this.getValue('getUint16', 2, offset)
    readByte   = (offset) => this.getValue('getUint8', 1, offset)
    readBytes  = (size, offset) => new Array(size).fill(0).map((_, i) => this.readByte(i == 0 ? offset : null))
    readChars  = (size, offset) => String.fromCharCode(...this.readBytes(size, offset))
    readStr    = (offset) => {
        this.offset = offset ?? this.offset
        let str = ''
        while (true) {
            const char = this.readByte()
            if (char == 0) return str
            str += String.fromCharCode(char)
        }
    }

    setLong  = (value, offset) => this.setBytes('setBigInt64', 8, value, offset)
    setInt   = (value, offset) => this.setValue('setInt32', 4, value, offset)
    setUInt  = (value, offset) => this.setValue('setUint32', 4, value, offset)
    setInt16 = (value, offset) => this.setValue('setInt16', 2, value, offset)
    setFloat = (value, offset) => this.setValue('setFloat32', 4, value, offset)
    setChars = (value, offset) => this.setBytes([...value].map(e => e.charCodeAt(0)), offset)
    setByte  = (value, offset) => this.setValue('setUint8', 1, value, offset)
    setBytes = (values, offset) => {
        this.offset = offset ?? this.offset
        this.buffer.set(values, this.offset)
        this.offset += values.length
    }
}

function bytesToUInt(bytes, start = 0) {
    if (bytes.length < start + 4) throw new Error('Reading past end of buffer')
    const int = bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16) | (bytes[start + 3] << 24)
    return int >>> 0
}

function bytesToUInt16(bytes, start = 0) {
    if (bytes.length < start + 2) throw new Error('Reading past end of buffer')
    const int = bytes[start] | (bytes[start + 1] << 8)
    return int >>> 0
}

function intToBytes(int, byteCount = 4) {
    const bytes = []
    for (let i = 0; i < byteCount; i++) {
        bytes.push(int & 0xFF)
        int >>= 8
    }
    return bytes
}

function formatSize(number) {
    return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + ' bytes'
}

export {
    BufferView,
    bytesToUInt,
    bytesToUInt16,
    intToBytes,
    formatSize,
}