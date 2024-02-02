import { BufferView } from "../utils.js"

const igListHeaderSize = 40

class igObject {
    constructor({index, offset, size = -1, type = '', typeID = -1, name = '', nameID = -1, data = []}) {
        this.index = parseInt(index) // Order of appearance in RVTB fixup
        this.offset = offset    // Offset in chunk 1

        this.type = type        // Type (string)
        this.typeID = typeID    // Type ID in TMET fixup
        this.typeCount = 0      // Custom index to differentiate between unnamed objects of the same type

        this.name = name        // Name (string)
        this.nameID = nameID    // Name ID in TSTR fixup

        this.size = size        // Data size in bytes
        this.data = new Uint8Array(data) // Object data
        this.view = new BufferView(this.data)

        this.children = []
        this.references = []
        this.deleted = data.every((e, i) => e == 0 || i < 4)
    }

    isListType() {
        return this.type == 'igObjectList' || this.type == 'igNameList'
    }

    getList() {
        if (!this.isListType()) throw new Error('Invalid object list type: ' + this.type)

        this.view.seek(0)
        const type = this.view.readInt()
        const zero12 = this.view.readBytes(12)
        const count = this.view.readInt()
        const count2 = this.view.readInt()
        const data_size = this.view.readInt()
        const magic = this.view.readInt()
        const data_offset = this.view.readInt()
        const zero = this.view.readInt()

        const list = []
        const element_size = data_size / count

        for (let i = 0; i < count; i++) {
            const offset = this.view.readInt(igListHeaderSize + i * element_size)
            list.push(offset)
        }

        this.element_size = element_size

        return list
    }

    getName() {
        let str = this.type
        if (this.deleted) str = '<Deleted> ' + str
        else if (this.typeCount > 0) str += ' ' + this.typeCount
        if (this.name != '') str += ': ' + this.name
        return str
    }

    getDisplayName() {
        if (this.name != '') return this.name
        return this.getName()
    }

    save(writer) {
        if (this.data.length != this.size) throw new Error('Data size mismatch: ' + this.data.length + ' != ' + this.size)

        if (this.deleted) {
            writer.setBytes(this.data)
            return
        }

        // Update references count
        this.view.setInt(this.references.length, 8)

        for (let k = 0; k < this.size; k += 4) {
            const child = this.children.find(e => e.offset == k)
            // Update children pointers (not for list types as it's handled manually), or get next value
            const value = child && !this.isListType() ? child.object.offset : this.view.readInt(k)
            writer.setInt(value)
        }
    }

    toString() {
        return {
            name: this.name == '' ? this.getName() : this.name,
            type: this.type,
            index: this.index,
            offset: this.offset,
            size: this.size,
            children: this.children.map(e => e.object.getName()),
            referenced_by: this.references.map(e => e.getName()),
        }
    }

    toNodeTree(parentObjects = []) {
        if (parentObjects.includes(this.index)) {
            return { 
                text: '[Recursion] ' + this.getName(), 
            }
        }
        
        parentObjects.push(this.index)

        return {
            type: 'object',
            objectIndex: this.index,
            text: this.getName(),
            children: this.index > 0 && this.children.length > 0 ? this.children.map(e => e.object.toNodeTree(parentObjects.slice())) : null,
        }
    }
}

export default igObject