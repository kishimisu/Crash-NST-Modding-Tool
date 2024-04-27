import { bytesToUInt, bytesToUInt16, intToBytes } from '../utils.js'

const stringFixups  = [ 'TDEP', 'TSTR', 'TMET' ]
const intPairFixups = [ 'EXID', 'EXNM' ]
const intFixups     = [ 'MTSZ', 'ROOT', 'ONAM', 'NSPC' ]
const bytesFixups   = [ 'RVTB', 'RSTT', 'ROFS', 'RPID', 'RHND', 'RNEX', 'REXT' ]
const allFixups     = [ ...stringFixups, ...intPairFixups, ...intFixups, ...bytesFixups ]

class Fixup {
    constructor(igz, type, size, header_size, item_count, data) {
        this.igz = igz
        this.type = type                   // Fixup type
        this.encoded = this.isEncoded()    // Is encoded ?
        this.size = size                   // Size of header + data
        this.header_size = header_size     // Size of header
        this.item_count = item_count       // Number of items
        this.rawData = data                // Header + data
        this.data = this.extractData(data) // Decoded data
    }

    isEncoded() {
        return this.type.startsWith('R') && this.type != 'ROOT'
    }

    // Whether to write the fixup when saving the file
    isActive() {
        return this.item_count > 0 || this.type == 'TSTR'
    }

    clone() {
        return new Fixup(this.igz, this.type, this.size, this.header_size, this.item_count, this.rawData.slice())
    }

    // Read fixup content from a BufferView
    static fromBuffer(igz, reader) {
        // Get fixup type
        const typeBytes  = reader.readBytes(4)
        const type = String.fromCharCode(...typeBytes)

        if (!allFixups.includes(type)) return null

        // Get fixup info
        const itemCount  = reader.readUInt()
        const fixupSize  = reader.readUInt()
        const headerSize = reader.readUInt()

        // Get data from beginning of header to end of fixup
        const data = reader.readBytes(fixupSize, reader.offset - 16)

        return new Fixup(igz, type, fixupSize, headerSize, itemCount, data)
    }

    // Extract data from fixup
    extractData() {
        const fixupData = this.rawData.slice(this.header_size)
        let data = []

        if (this.encoded) {
            data = decodeRVTB(fixupData, this.item_count)
        }
        else if (stringFixups.includes(this.type)) {
            const item_count = this.item_count * (this.type === 'TDEP' ? 2 : 1)

            // Strings
            let str = ''
            for (let i = 0; i < fixupData.length && data.length < item_count; i++) {
                const char = fixupData[i]

                if (char == 0) {
                    data.push(str)
                    str = ''
                    if (fixupData[i + 1] == 0) i++ // Skip double null bytes
                }
                else str += String.fromCharCode(char)
            }

            if (this.type === 'TDEP') {
                // Group by pairs of two
                data = data.reduce((acc, e, i) => {
                    if (i % 2 == 0) acc.push([e])
                    else acc[acc.length - 1].push(e)
                    return acc
                }, [])
            }
        }
        else if (intFixups.includes(this.type)) {
            // Int32
            for (let i = 0; i < this.item_count; i++) {
                const int = bytesToUInt(fixupData, i * 4)
                data.push(int)
            }
        }
        else if (intPairFixups.includes(this.type)) {
            // Int32 pairs
            for (let i = 0; i < this.item_count; i++) {
                const pair = [ bytesToUInt(fixupData, i * 8), bytesToUInt(fixupData, i * 8 + 4) ]
                data.push(pair)
            }
        }
        else {
            data = fixupData.slice()
        }

        return data
    }

    updateData(data) {
        if (data == null) throw new Error(`Cannot update fixup ${this.type}: no data provided`)

        let encoded = []
        
        if (stringFixups.includes(this.type)) {
            const strings = data.flat()
            let all_strings = ''

            for (let i = 0; i < strings.length; i++) {
                const str = strings[i] + '\0' + (this.type != 'TDEP' && strings[i].length % 2 == 0 ? '\0' : '')
                all_strings += str
            }

            const bytes = new TextEncoder().encode(all_strings)
            encoded = Array.from(bytes)
        }
        else if (intPairFixups.includes(this.type)) {
            const bytes = data.flatMap(e => intToBytes(e[0]).concat(intToBytes(e[1])))
            encoded = bytes
        }
        else if (this.isEncoded()) {
            encoded = encodeRVTB(data)
        }
        else if (intFixups.includes(this.type)) {
            encoded = data.map(e => intToBytes(e)).flat()
        }
        else {
            throw new Error ('Update not implemented: ' + this.type)
        }

        if (this.type != 'TDEP' && !intPairFixups.includes(this.type))
            this.data = data
        
        this.rawData = this.rawData.slice(0, this.header_size).concat(encoded)
        if (this.rawData.length % 16 != 0) this.rawData.push(...Array(16 - this.rawData.length % 16).fill(0))
        this.rawData.push(...Array(16).fill(0))
        this.size = this.rawData.length
        this.item_count = data.length
    }

    // Get the object corresponding to an offset
    getCorrespondingObject(offset, objects) {
        const global_offset = this.igz.getGlobalOffset(offset)
        const object = objects.find(e => global_offset >= e.global_offset && global_offset < e.global_offset + e.size)

        if (object == null) {
            console.log('No object found for offset', offset, global_offset, this.type, this.data.indexOf(offset))
            return { object: null, offset: NaN }
        }

        return {
            object,
            offset: global_offset - object.global_offset // relative offset
        }
    }

    toNodeTree(objects, childrenOnly = false) {
        if (childrenOnly) {
            return this.data.map((e, i) => {
                let text = i + ': '

                if (this.encoded || this.type == 'ONAM' || this.type == 'ROOT' || this.type == 'NSPC') {
                    const object = this.getCorrespondingObject(e, objects)
                    if (object.object == null) text += '<ERROR>'
                    else {
                        text += `${object.object.getName()}`
                        if (object.offset > 0) text += ` [+ 0x${object.offset.toString(16).toUpperCase()}]`
                    }
                }
                else if (this.type == 'EXNM') {
                    const isHandle = this.igz.named_handles.find(handle => handle[0] == e[0] && handle[1] == e[1])
                    text += `${isHandle ? 'Handle' : 'External'} | ${e[1]}: ${e[0]}`
                }
                else if (this.type == 'MTSZ') {
                    const type = this.igz.fixups.TMET.data[i]
                    text += `${e} bytes (${type})`
                }
                else text += typeof(e) == 'object' ? `${e[1]}: ${e[0]}` : e

                return { 
                    text, 
                    type: 'offset', 
                    fixup: this.type,
                    index: i,
                    offset: e 
                }
            })
        }

        return {
            text: `${this.type} (${this.item_count})`,
            type: 'fixup',
            fixup: this.type,
            children: this.data.length > 0
        }
    }

    save(writer) {
        writer.setChars(this.type)
        writer.setInt(this.item_count)
        writer.setInt(this.size)
        writer.setInt(this.header_size)
        writer.setBytes(this.rawData.slice(16))
    }

    toString() {
        return {
            ...this,
            igz: undefined,
            rawData: undefined
        }
    }
}

function decodeRVTB(bytes, count) {
    const list = []
    let currentInt = 0
    let currentShift = 0

    const halfBytes = Array.from(bytes).map(e => [e & 0xF, (e >> 4) & 0xF]).flat()

    for (let i = 0; i < halfBytes.length; i++) {
        const byte = halfBytes[i]
        const stopReading = !(byte & 0b1000)

        currentInt |= (byte & 0b0111) << currentShift
        currentShift += 3

        if (stopReading) {
            const lastInt = list[list.length - 1] ?? 0
            list.push(lastInt + currentInt * 4)

            if (list.length == count) break

            currentInt = 0
            currentShift = 0
        }
    }

    return list
}

function encodeRVTB(data) {
    const bytes = []

    data = data.sort((a, b) => a - b)

    for (let i = 0; i < data.length; i++) {
        const lastInt = data[i - 1] ?? 0
        let currentInt = (data[i] - lastInt) / 4

        do {
            let byte = currentInt & 0b0111
            currentInt = currentInt >> 3

            if (currentInt != 0) byte |= 0b1000 // Continue reading ?
            bytes.push(byte)
        } while (currentInt > 0)
    }

    while (bytes.length % 8 != 0) bytes.push(0)

    const final = []
    for (let i = 0; i < bytes.length; i += 2) {
        final.push( bytes[i] | (bytes[i + 1] << 4) )
    }

    return final
}

export default Fixup
export { decodeRVTB, encodeRVTB }