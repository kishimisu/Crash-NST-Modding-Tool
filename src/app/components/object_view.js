import types_metadata from '../../../assets/crash/types.metadata'
import { BufferView, bitRead, bitReplace } from '../../utils'
import { saveTemporaryAndLaunch } from '../renderer'
import ObjectField from './object_field'
import { elm } from "./utils/utils"

// Process types metadata and hierarchy from file
const TYPES_HIERARCHY = {}
const TYPES_METADATA = read_all_types_metadata()

// Keep track of updated fields within objects
const updated_data = {}

// Save interesting fields on IGZ load (fields that have 
// different values between objects of the same type)
const interesting_fields = {
    igz: null,
    fields: {}
}

class ObjectView {
    constructor(object) {
        const fields = TYPES_METADATA[object.type].slice() // Retrieve type metadata

        this.container = elm('#object-view') // Field list container
        this.object = object                 // parent igObject reference

        this.fields = fields                 // Array of fields from the object's type
        this.hexCells = []                   // Array of cells from the hex data view

        this.selected = null                 // { field, cell }, Currently selected field and cell 

        // Update object display name
        elm('#object-name').innerText = object.getDisplayName()
                
        this.findInterestingFields()
        this.createFieldList()
        this.createHexDataCells()
    }

    // Create the table containing the object's data in hexadecimal format
    createHexDataCells() {
        const bytesPerRow = 4 * 6
        const table = elm('#data-table')
        table.onmouseleave = () => this.onMouseLeave()
        
        let row = document.createElement('tr')
        this.hexCells = []

        Main.showObjectDataView(true)

        // Iterate over every 4 bytes of the object's data
        for (let i = 0; i < this.object.data.length; i += 4) {
            const value = this.object.view.readInt(i)

            // Create offset column
            if (i % bytesPerRow == 0) {
                const offsetCell = document.createElement('td')
                offsetCell.innerText = '0x' + i.toString(16).toUpperCase().padStart(4, '0')
                offsetCell.classList.add('hex-offset')
                row.appendChild(offsetCell)
            }

            // Create hex cell DOM element
            const cell = document.createElement('td')
            cell.innerText = (value >>> 0).toString(16).toUpperCase().padStart(8, '0').replace(/(.{2})/g, '$1 ')

            if (value === 0 || i < 16) cell.classList.add('hex-zero')
            
            // Create hex cell object
            const hexCell = { element: cell, offset: i }
            this.hexCells.push(hexCell)

            // Add mouse events
            cell.onclick = () => {
                this.setSelected(hexCell.fields[0], hexCell)
                this.onCellHover(hexCell)
            }
            cell.onmouseover = () => {
                if (this.selected == null) 
                    this.onCellHover(hexCell)
            }

            // Add to row
            row.appendChild(cell)

            if (i % bytesPerRow == bytesPerRow - 4) {
                table.appendChild(row)
                row = document.createElement('tr')
            }
            if (i == this.object.data.length - 4) {
                table.appendChild(row)
            }
        }

        this.setupCellsAndFields()
        this.styleHexDataCells()
    }

    // Colorize data cells based on their type
    styleHexDataCells() {
        for (let i = 0; i < this.fields.length; i++) {
            const field = this.fields[i]
            if (field.bitfield != null) continue

            const colorType = field.bitfieldRoot ? 'hex-bool' : field.getColorClass()
            const childrenUpdated = field.bitfieldRoot && field.children.some(e => this.isFieldUpdated(e))

            // Colorize corresponding data cells
            for (let j = 0; j < Math.ceil(field.size / 4); j++) {
                const cell = this.hexCells[Math.floor(field.offset / 4) + j].element

                if (field.type === 'igEnumMetaField' && cell.innerText.replaceAll(' ', '') == 'FFFFFFFF') 
                    cell.classList.add('hex-zero')

                const zero = cell.classList.contains('hex-zero')
                const updated = childrenUpdated || this.isFieldUpdated(field, j)
                
                if (updated) cell.classList.add('hex-updated')
                if (colorType && (!zero || updated)) cell.classList.add(colorType)
            }
        }
    }

    // Create the table containing all fields
    createFieldList() {
        this.container.innerHTML = ''
        this.container.onmouseleave = () => this.onMouseLeave()

        this.createAdditionalFields()
        
        // Create new rows for each field
        for (const field of this.fields) {
            this.createField(this.object, field)
        }

        // Add object's references to the bottom of the field list
        const refs = this.object.references.filter(e => e.index !== 0).map(e => '<p>&nbsp;&nbsp;' + e.getDisplayName())
        const div = document.createElement('div')
        div.className = 'ref-list'
        div.innerHTML = `References: (${refs.length}) ` + refs.join('</p>') + '</p>'
        this.container.appendChild(div)
    }

    // Create fields for elements of array-typed objects
    createAdditionalFields() {
        // igComponentDataTable, CEntityTagSet
        if (this.fields.length >= 2 && this.fields[0].type == 'igMemoryRefMetaField' && this.fields[1].type == 'igMemoryRefMetaField') {
            // Get array infos
            const valuesElmSize = this.object.view.readUInt(this.fields[0].offset)
            const valuesOffset  = this.object.view.readUInt(this.fields[0].offset + 8)
            const keysElmSize   = this.object.view.readUInt(this.fields[1].offset)
            const keysOffset    = this.object.view.readUInt(this.fields[1].offset + 8)
            const itemCount     = this.object.view.readUInt(this.fields[2].offset)
            const valuesType    = this.fields[0].memType
            const keysType      = this.fields[1].memType

            // Find objects containing keys and values
            const valuesObject  = Main.igz.findObject(valuesOffset)
            const keysObject    = Main.igz.findObject(keysOffset)

            const relativeKeysOffset   = Main.igz.getGlobalOffset(keysOffset) - keysObject.global_offset
            const relativeValuesOffset = Main.igz.getGlobalOffset(valuesOffset) - valuesObject.global_offset
            const valueElmSize = Math.min(valuesElmSize, 8)
            const keyElmSize   = 8 // keysElmSize

            // console.log( { valuesElmSize, valuesOffset, keysElmSize, keysOffset, itemCount, valuesType, keysType })

            this.fields[0].elementSize = valueElmSize
            this.fields[1].elementSize = keyElmSize

            let i = 0, additionalFields = 0

            while(additionalFields < itemCount) {
                const key   = keysObject.view.readUInt(relativeKeysOffset + i * keyElmSize)
                const value = valuesObject.view.readUInt(relativeValuesOffset + i * valueElmSize)

                if (key == 0 && value == 0) {
                    i++
                    continue
                }

                const string = Main.igz.fixups.TSTR.data[key]
                
                const field = new ObjectField({
                    name: `#${additionalFields} ${keysType == 'igStringMetaField' || keysType == 'igNameMetaField' ? string : keysType}`,
                    type: valuesType,
                    offset: relativeValuesOffset + i * valueElmSize,
                    size: valueElmSize,
                })

                i++
                additionalFields++
                this.fields.push(field)
            }
        }
        // igNameList, igObjectList, CAudioArchiveHandleList
        else if (this.fields.length >= 3 && this.fields[0].name == '_count' && this.fields[1].name == '_capacity' && this.fields[2].type == 'igMemoryRefMetaField') {
            const count         = this.object.view.readUInt(this.fields[0].offset)
            const capacity      = this.object.view.readUInt(this.fields[1].offset)
            const size          = this.object.view.readUInt(this.fields[2].offset)
            const valuesOffset  = this.object.view.readUInt(this.fields[2].offset + 8)
            const valuesType    = this.fields[2].memType
            const valuesElmSize = count == 0 ? 0 : size / count

            if (count != capacity) console.warn('MemoryRefMetaField count and capacity are different:', count, capacity)
            if (!Number.isInteger(valuesElmSize)) console.warn('MemoryRefMetaField size is not a multiple of count:', size, count, valuesElmSize)

            const valuesObject = Main.igz.findObject(valuesOffset)
            const relativeValuesOffset = Main.igz.getGlobalOffset(valuesOffset) - valuesObject.global_offset

            // console.log({ count, capacity, size, valuesElmSize, valuesOffset, valuesType })

            this.fields[2].elementSize = valuesElmSize

            for (let i = 0; i < count; i++) {
                const field = new ObjectField({
                    name: `Item #${i}`,
                    type: valuesType,
                    offset: relativeValuesOffset + i * valuesElmSize,
                    size: valuesElmSize,
                })

                this.fields.push(field)
            }
        }
    }

    // Create a row containing info about a field
    createField(object, field) {
        // Create new row
        const tr = document.createElement('tr')
        tr.className = 'field-view'

        const setupNameStyle = () => {
            const updated = this.isFieldUpdated(field)
            name.title = `${field.name} | Offset: 0x${field.offset.toString(16).toUpperCase()} | Size: ${field.bits ?? field.size} ${field.bitfield ? 'bit' : 'byte'}${(field.bits ?? field.size) > 1 ? 's' : ''}`
            name.style.fontWeight = updated ? 400 : 100
            name.style.color = updated ? 'orange' : field.interesting ? '#ff7271' : ''
            name.style.fontStyle = field.bitfieldRoot ? 'italic' : ''
            name.innerHTML = (field.bitfield != null ? '&nbsp;&nbsp;' : '') + field.name + (updated ? '*' : '')
        }

        // Field name
        const name = document.createElement('td')
        name.onclick = () => this.setSelected(field, field.hexCells[0])
        setupNameStyle()

        // Field type
        const type = document.createElement('td')
        type.title = `Type: ${field.type}${field.metaObject ? ' | ' + field.metaObject : ''} ` + (field.bitfield ? `| Bits: ${field.bits}, Shift: ${field.shift}` : '')
        type.style.fontStyle = field.bitfieldRoot ? 'italic' : ''
        type.innerText = field.getPrettyType()
        type.classList.add(field.getColorClass())
        type.onclick = () => this.setSelected(field, field.hexCells[0])

        // Field data (input field)
        const data = this.createInputFieldValue(object, field)

        // Focus the start of the data when clicking on a Memory field
        if (field.type === 'igMemoryRefMetaField' || field.type === 'igRawRefMetaField') {
            tr.addEventListener('click', () => {
                const offset = Main.igz.getGlobalOffset(object.view.readUInt(field.offset + 8))
                const refOjbect = Main.igz.objects.find(e => offset >= e.global_offset && offset < e.global_offset + e.size)

                // Focus in hex view
                const view = new ObjectView(refOjbect)
                const refCell = view.hexCells.find(e => e.offset === offset - refOjbect.global_offset)
                view.setSelected(refCell.fields[0], refCell)
                view.onCellHover(refCell, true)

                // Focus in tree view
                const refNode = Main.tree.available().find(e => e.objectIndex == refOjbect.index)
                refNode?.expandParents()
                refNode?.select()
            })
        }

        // Add new row to table
        tr.addEventListener('mouseover', () => this.onFieldHover(field))
        tr.addEventListener('contextmenu', (e) => {
            this.createContextMenu(field, e.clientX, e.clientY)
            e.preventDefault()
        })
        tr.appendChild(name)
        tr.appendChild(type)
        tr.appendChild(data)
        this.container.appendChild(tr)

        field.element = tr // Save a reference to the DOM element
        field.refreshNameStyle = setupNameStyle // Save name update function
    }

    // Create the input field corresponding to a specific type
    createInputFieldValue(object, field) {
        const val = document.createElement('td')
        val.style.textAlign = '-webkit-center'

        if (field.bitfieldRoot) return val

        const type = field.type
        let input = null

        const createNumberInput = (methodType, offset = 0, value) => {
            value ??= object.view[methodType](field.offset + offset)
            const float = methodType === 'readFloat'
            const input = document.createElement('input')
            input.value = float ? value.toFixed(3) : value
            return input
        }

        const createCheckboxInput = (value) => {
            const input = document.createElement('input')
            input.type = 'checkbox'
            input.checked = value == 1
            input.onchange = () => this.onFieldUpdate(field, input.checked)
            return input
        }

        if (['igIntMetaField', 'igEnumMetaField'].includes(type)) {
            input = createNumberInput('readInt')
        }
        else if (type == 'igUnsignedIntMetaField') {
            input = createNumberInput('readUInt')
        } 
        else if (type == 'igShortMetaField') {
            input = createNumberInput('readInt16')
        }
        else if (type == 'igUnsignedShortMetaField') {
            input = createNumberInput('readUInt16')
        }
        else if (type == 'igFloatMetaField') {
            input = createNumberInput('readFloat')
        }
        else if (type == 'igBoolMetaField') {
            const value = object.view.readByte(field.offset)
            input = createCheckboxInput(value)
        }
        else if (field.isArrayType()) {
            const elements = field.size / 4
            const div = document.createElement('div')
            div.className = 'vec-input'

            if (field.type == 'igVectorMetaField' || field.type == 'igFloatArrayMetaField') div.style.flexDirection = 'column'
            if (field.type == 'igMatrix44fMetaField') div.style.flexWrap = 'wrap'
            
            const isFloat = type !== 'igVectorMetaField'
            field.inputs = []

            for (let i = 0; i < elements; i++) {
                const input = createNumberInput(isFloat ? 'readFloat' : 'readInt', i * 4)
                input.style.borderRight = i < elements - 1 ? '1px solid #5c5c5c' : ''
                input.onchange = () => this.onFieldUpdate(field, input.value, i)
                if (field.type == 'igMatrix44fMetaField' || field.type == 'igQuaternionfMetaField') input.style.width = '24%'
                div.appendChild(input)
                field.inputs.push(input)
            }

            val.style.display = 'contents'
            val.appendChild(div)
            return val
        }
        else if (field.isStringType()) {
            const str_index = object.view.readUInt(field.offset)
            const name = str_index > 0 ? Main.igz.fixups.TSTR.data[str_index] : null
            input = createDropdownInput(Main.igz.fixups.TSTR.data, name)
        }
        else if (type == 'igObjectRefMetaField') {
            const offset = object.view.readUInt(field.offset)
            const global_offset = Main.igz.getGlobalOffset(offset)
            const refOjbect = offset > 0 ? Main.igz.objects.find(e => global_offset >= e.global_offset && global_offset < e.global_offset + e.size) : null
            const inheritedClasses = getAllInheritedChildren(field.metaObject).add(field.metaObject)
            const names = Main.igz.objects.filter(e => !field.metaObject || inheritedClasses.has(e.type)).map(e => e.getDisplayName())
            input = createDropdownInput(names, refOjbect?.getDisplayName())
        }
        else if (type == 'igBitFieldMetaField') {
            const bytes = object.view.readInt(field.offset)
            const value = bitRead(bytes, field.bits, field.shift)

            if (field.metaField == 'igBoolMetaField')
                input = createCheckboxInput(value)
            else
                input = createNumberInput('readInt', 0, value)
        }
        else if (type == 'igMemoryRefMetaField') {
            input = document.createElement('div')
            input.innerText = `Type: ${field.getPrettyType(field.memType)} | ` + (field.elementSize > 0 ? `Elm. Size: ${field.elementSize}` : 'Count: 0')
        }
        else {
            input = createNumberInput('readInt')
        }

        if (input.onchange == null) input.onchange = () => this.onFieldUpdate(field, input.value)
        val.appendChild(input)

        field.input = input // Save a reference to the input field

        return val
    }

    // Update an object's data when a field is modified
    // Apply changes to all objects if the "Apply to all" checkbox is checked
    onFieldUpdate(field, value, id) {
        const searchMatches = Main.tree.matched()

        if (elm('#apply-all-checkbox').checked && searchMatches.length > 0) {
            searchMatches.each((e, i) => {
                const object = Main.igz.objects[e.objectIndex]
                this.updateObjectData(object, field, value, i == 0, id)
            })
        }
        else {
            this.updateObjectData(this.object, field, value, true, id)
        }

        Main.igz.updated = true
        if (Main.pak) Main.pak.updated = true

        Main.updateTitle()
        Main.colorizeMainTree()
    }

    /** 
     * Update an object's data when a field is modified
     * 
     * @param {igObject} object - The object to be updated
     * @param {HTMLInputElement} input - The input field that was modified
     * @param {Object} field - The corresponding field
     * @param {string} value - The new value of the field
     * @param {number} id - Element offset (for Vec2f and Vec3f fields)
    */
    updateObjectData(object, field, value, updateInput, id = 0) {
        let previousValue = null
        let autoUpdate = true

        const relativeCalculation = (type, id) => {
            const readMethod = 'read' + type
            const writeMethod = 'set' + type
            const dataOffset = field.offset + (id ?? 0) * 4
            previousValue = object.view[readMethod](dataOffset)

            let num = Number(value.replace(',', '.').replace(/[^\d.-]/g, '')) // Extract number from string

            // Perform relative calculation
            if (value.startsWith('+') || value.startsWith('-=')) num = previousValue + num
            else if (value.startsWith('*')) num = previousValue * num
            else if (value.startsWith('/')) num = previousValue / num
            
            if (type === 'Float') num = parseFloat(num.toFixed(3))

            // Update input value
            if (updateInput) {
                if (id != null) field.inputs[id].value = num
                else field.input.value = num
            }

            value = num

            // Update object data
            object.view[writeMethod](num, dataOffset)

            return num
        }

        if (['igIntMetaField', 'igEnumMetaField'].includes(field.type)) {
            relativeCalculation('Int')
        }
        else if (field.type == 'igUnsignedIntMetaField') {
            relativeCalculation('UInt')
        }
        else if (field.type == 'igShortMetaField') {
            relativeCalculation('Int16')
        }
        else if (field.type == 'igUnsignedShortMetaField') {
            relativeCalculation('UInt16')
        }
        else if (field.type == 'igFloatMetaField') {
            relativeCalculation('Float')
        }
        else if (field.isArrayType()) {
            // Update all values at once (paste operation)
            const isFloat = field.type !== 'igVectorMetaField'
            if (typeof(value) === 'object') {
                const item_count = field.size / 4

                for (let i = 0; i < item_count; i++) {
                    let previousValue

                    if (isFloat) {
                        previousValue = object.view.readFloat(field.offset + i * 4)
                        object.view.setFloat(value[i], field.offset + i * 4)
                        if (updateInput) field.inputs[i].value = parseFloat(value[i].toFixed(3))
                    }
                    else {
                        previousValue = object.view.readInt(field.offset + i * 4)
                        object.view.setInt(value[i], field.offset + i * 4)
                        if (updateInput) field.inputs[i].value = value[i]
                    }
                    addUpdatedData(object, this.fields.indexOf(field), value[i], previousValue, i)
                }
                autoUpdate = false
            }
            // Perform relative calculation on a single component
            else {
                relativeCalculation(isFloat ? 'Float' : 'Int', id)
            }
        }
        else if (field.type == 'igBoolMetaField') {
            previousValue = object.view.readByte(field.offset) === 1
            value = value ? 1 : 0
            object.view.setByte(value, field.offset)
        }
        else if (field.isStringType()) {
            if (typeof value === 'string')
                value = Math.max(0, Main.igz.fixups.TSTR.data.indexOf(value))
            previousValue = object.view.readUInt(field.offset)
            object.view.setUInt(value, field.offset)
            if (updateInput) field.input.value = value > 0 ? Main.igz.fixups.TSTR.data[value] : '--- None ---'
        }
        else if (field.type == 'igObjectRefMetaField') {
            let refOjbect = null
            
            if (typeof value === 'string') {
                refOjbect = Main.igz.objects.find(e => e.getDisplayName() == value)
                value = refOjbect?.offset ?? 0
            }
            refOjbect ??= Main.igz.objects.find(e => e.offset == value)

            previousValue = object.view.readUInt(field.offset)
            object.view.setUInt(value, field.offset)
            if (updateInput) field.input.value = value > 0 && refOjbect != null ? refOjbect.getDisplayName() : '--- None ---'
        }
        else if (field.type == 'igBitFieldMetaField') {
            if (value === true) value = 1
            else if (value === false) value = 0
            else value = parseInt(value)
            const currentInt = object.view.readInt(field.offset)
            value = bitReplace(currentInt, value, field.bits, field.shift)
            object.view.setUInt(value, field.offset)

            previousValue = bitRead(currentInt, field.bits, field.shift)
            value = bitRead(value, field.bits, field.shift)
            if (field.metaField != 'igBoolMetaField') field.input.value = value
        }
        else {
            console.warn('Unhandled field type', field.type)
            previousValue = object.view.readInt(field.offset)
            object.view.setInt(parseInt(value), field.offset)
        }

        // Keep track of updated fields
        if (autoUpdate) addUpdatedData(object, this.fields.indexOf(field), value, previousValue, id)

        // Update object's node name in tree view
        const node = Main.tree.available().find(e => e.objectIndex == object.index)
        const updated = this.isFieldUpdated(field)
        if (!updated && node.text.endsWith('*')) node.set('text', node.text.slice(0, -1))
        else if (updated && !node.text.endsWith('*')) node.set('text', node.text + '*')

        const saveCellIDs = field.hexCells.map(e => this.hexCells.indexOf(e))

        field.refreshNameStyle()
        this.createHexDataCells()
        this.onFieldHover(field)
        this.lastEditTime = Date.now()

        object.updated = Object.keys(updated_data[object.index] ?? {}).length > 0

        saveCellIDs.forEach(e => this.hexCells[e].element.classList.add('hex-flash')) // Flashing animation
    }
    
    // Check if a field data differs from the original data
    isFieldUpdated(field, id) {
        if (updated_data[this.object.index] == null) return false
        if (updated_data[this.object.index][this.fields.indexOf(field)] == null) return false
        if (id != null && updated_data[this.object.index][this.fields.indexOf(field)][id] == null) return false
        return true
    }

    // Sets the hex cells and fields references
    setupCellsAndFields() {
        for (const field of this.fields) {
            const cellStart = Math.floor(field.offset / 4)
            const cellEnd   = Math.ceil((field.offset + field.size) / 4)
            field.hexCells = this.hexCells.slice(cellStart, cellEnd)
        }

        for (const cell of this.hexCells) {
            cell.fields = this.fields.filter(e => cell.offset >= e.offset && cell.offset < e.offset + e.size)
        }
    }

    // Sets the currently selected field and cell
    setSelected(field, cell) {
        // Reset selection if clicked on the same field/cell
        this.selected = this.selected != null && (this.selected.field === field || this.selected.cell === cell) ? null : { field, cell }

        // Update hex cells
        this.hexCells.forEach(e => {
            if (e === this.selected?.cell) e.element.classList.add('selected')
            else e.element.classList.remove('selected')
        })
    }

    onFieldHover(field) {
        if (Date.now() - this.lastEditTime < 100) return // Prevent focusing another field just after closing a dropdown

        // Update field list
        this.fields.forEach(e => {
            e.element.style.backgroundColor = e === this.selected?.field || e === field ? '#5c5c5c' : ''
        })

        // Update hex cells
        this.hexCells.forEach(e => {
            e.element.style.backgroundColor = field.hexCells.includes(e) ? '#5c5c5c' : ''
        })
        field.hexCells[0].element.parentNode.scrollIntoViewIfNeeded()
    }

    onCellHover(cell, forceSelect = false) {
        // Update field list
        this.fields.forEach(e => {
            e.element.style.backgroundColor = e.hexCells.includes(cell) ? '#5c5c5c' : ''
        })

        // Update hex cells
        let cellsToHighlight = []

        if (cell.fields.length > 0) {
            cell.fields[0].element.scrollIntoViewIfNeeded()
            cellsToHighlight = cell.fields[0].hexCells
        }
        if (cellsToHighlight.length === 0 && forceSelect) cellsToHighlight = [cell]

        this.hexCells.forEach(e => {
            e.element.style.backgroundColor = cellsToHighlight.includes(e) ? '#5c5c5c' : ''
        })
    }

    onMouseLeave() {
        // Focus currently selected field
        if (this.selected?.field) 
            this.onFieldHover(this.selected.field)
        // Otherwise reset all styles
        else {
            this.hexCells.forEach(e => e.element.style.backgroundColor = '')
            this.fields.forEach(e => e.element.style.backgroundColor = '')
        }
    }

    /**
     * Creates and open a context menu when right-clicking on a field
     */
    async createContextMenu(field, x, y) {
        if (!field.isArrayType() && !field.isStringType() && field.type !== 'igObjectRefMetaField') return

        elm('#context-menu').style.left = x + 'px'
        elm('#context-menu').style.top = y + 'px'
        elm('#context-menu').onmouseleave = () => elm('#context-menu').style.display = 'none'

        // "Spawn here" and "Spawn on crate" buttons

        if (field.type === 'igVec3fMetaField' && Main.pak?.package_igz != null) {
            const [x, y, z] = this.object.view.readVector(field.offset, 3)

            elm('#spawn-here').style.display = 'block'
            elm('#spawn-here').onclick = () => {
                elm('#context-menu').style.display = 'none'
                saveTemporaryAndLaunch({ spawnPoint: [x, y, z] })
            }
            elm('#spawn-on-crate').style.display = 'block'
            elm('#spawn-on-crate').onclick = () => {
                elm('#context-menu').style.display = 'none'
                saveTemporaryAndLaunch({ spawnPoint: [x, y, z], spawnCrate: [x, y, z] })
            }
        }
        else {
            elm('#spawn-here').style.display = 'none'
            elm('#spawn-on-crate').style.display = 'none'
        }

        // "Copy" and "Paste" buttons

        const paste = await navigator.clipboard.readText()

        // Get the value of the field
        const getCopyValue = () => {
            if (field.isArrayType()) {
                const element_count = field.size / 4
                const readMethod = field.type == 'igVectorMetaField' ? 'readVectorInt' : 'readVector'
                return this.object.view[readMethod](field.offset, element_count)
            }
            return this.object.view.readInt(field.offset)
        }

        // Get the value of the clipboard and convert it to the correct format
        const getPasteValue = () => {
            try {
                if (field.isArrayType()) {
                    const element_count = field.size / 4
                    const data = JSON.parse(paste)
                    if (data.length !== element_count)
                    throw new Error()
                    return data
                }
                else if (field.isStringType()) {
                    const data = Number(paste)
                    if (isNaN(data)) throw new Error()
                    if (data < 0 || data >= Main.igz.fixups.TSTR.data.length) throw new Error()
                    return data
                }
                else if (field.type === 'igObjectRefMetaField') {
                    const data = Number(paste)
                    const refOjbect = Main.igz.objects.find(e => e.offset == data)
                    if (data === 0) return data
                    if (refOjbect == null) throw new Error()
                    if (field.metaObject && !getAllInheritedChildren(field.metaObject).add(field.type).has(refOjbect.type)) throw new Error()
                    return data
                }
                else {
                    const data = Number(paste)
                    if (isNaN(data)) throw new Error()
                    return data
                }
            }
            catch {
                return null
            }
        }

        const pasteValue = getPasteValue()

        // "Copy value" button
        elm('#copy-field').style.display = 'block'        
        elm('#copy-field').onclick = () => {
            navigator.clipboard.writeText(JSON.stringify(getCopyValue()))
            elm('#context-menu').style.display = 'none'
        }

        // "Paste value" button
        elm('#paste-field').style.display = pasteValue != null ? 'block' : 'none'
        elm('#paste-field').onclick = async () => {
            this.onFieldUpdate(field, pasteValue)
            elm('#context-menu').style.display = 'none'
        }
        
        elm('#context-menu').style.display = 'block'
    }

    // Find fields that have different values between objects
    findInterestingFields() {
        // Reset interesting fields on igz change
        if (interesting_fields.igz !== Main.igz) {
            interesting_fields.igz = Main.igz
            interesting_fields.fields = {}
        }
        // Load saved interesting fields
        else if (interesting_fields.fields[this.object.type] != null) {
            this.fields.forEach((e, i) => e.interesting = interesting_fields.fields[this.object.type].includes(i))
            return
        }

        // Calculate interesting fields
        const allObjects = Main.igz.objects.filter(e => e.type == this.object.type)
        let interestingFields = []

        for (let i = 0; i < this.fields.length; i++) {
            const field = this.fields[i]
            if (field.bitfieldRoot) continue

            let firstValue = null

            if (field.type === 'igBitFieldMetaField') {
                const bytes = allObjects[0].view.readInt(field.offset)
                firstValue = bitRead(bytes, field.bits, field.shift)
            }
            else {
                firstValue = allObjects[0].view.readBytes(field.size, field.offset)
            }

            for (let j = 1; j < allObjects.length; j++) {
                let interesting = false

                if (field.type === 'igBitFieldMetaField') {
                    const bytes = allObjects[j].view.readInt(field.offset)
                    const value = bitRead(bytes, field.bits, field.shift)
                    if (value !== firstValue) interesting = true
                }
                else {
                    const value = allObjects[j].view.readBytes(field.size, field.offset)
                    if (value.some((e, k) => e != firstValue[k])) interesting = true
                }

                if (interesting) {
                    field.interesting = true
                    interestingFields.push(i)
                    break
                }
            }
        }

        interesting_fields.fields[this.object.type] = interestingFields
    }
}

// Extract types metadata from the binary file
function read_all_types_metadata() {
    const names = []
    const objects = {}
    const view = new BufferView(new Uint8Array(types_metadata))

    const namesCount = view.readUInt16()

    // Read names
    for (let i = 0; i < namesCount; i++) {
        const name = view.readStr()
        names.push(name)
    }

    // Read types metadata
    while (view.offset < view.buffer.length) {
        const typeName = names[view.readUInt16()]
        const parent = names[view.readUInt16()]
        const size = view.readUInt16()
        const fieldCount = view.readUInt16()
        const fields = []

        // Add type to hierarchy data
        function addToHierarchy(type, children = null) {
            if (!TYPES_HIERARCHY[type]) TYPES_HIERARCHY[type] = { children: new Set() }
            if (children) children.forEach(e => TYPES_HIERARCHY[type].children.add(e))
        }
        addToHierarchy(typeName)
        addToHierarchy(parent, [typeName])

        // Read fields
        for (let i = 0; i < fieldCount; i++) {
            // Read name and type
            const field = new ObjectField({
                name: names[view.readUInt16()],
                type: names[view.readUInt16()],
                offset: view.readUInt16(),
                size: view.readUInt16(),
                typeSize: view.readUInt16(),
                static: view.readByte() === 1
            })
            
            // Read MetaObject (object reference type)
            if (field.type === 'igObjectRefMetaField' || field.type === 'igObjectRefArrayMetaField') {
                field.metaObject = names[view.readUInt16()]
            }
            // Read MemType (memory data type)
            else if (field.type === 'igMemoryRefMetaField') {
                field.memType = names[view.readUInt16()]
            }
            // Read bitfield data
            else if (field.type === 'igBitFieldMetaField') {
                field.rootIndex = view.readUInt16()
                field.metaField = names[view.readUInt16()]
                field.shift = view.readByte()
                field.bits = view.readByte()
            }
            
            fields.push(field)
        }

        // Update bitfield data
        fields.forEach(field => {
            if (field.type === 'igBitFieldMetaField') {
                field.root = fields[field.rootIndex]
                field.root.children ??= []
                field.root.children.push(field)
                field.root.bitfieldRoot = true
                field.size = field.root.size
                field.bitfield = true
            }
        })

        // Remove 0-sized fields, sort by offset and save type metadata
        objects[typeName] = fields.filter(e => e.type !== 'igStaticMetaField' && e.type !== 'igPropertyFieldMetaField')
                                  .sort((a, b) => a.offset - b.offset)
    }

    return objects
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

/**
 * Creates a dropdown input element with options based on the provided names array.
 * 
 * @param {string[]} names - An array of names to be used as options in the dropdown.
 * @param {string} selected - The name of the option to be selected by default.
 * @returns {HTMLSelectElement} - The created dropdown input element.
 */
function createDropdownInput(names, selected) {
    // Create HTML dropdown
    const select = document.createElement('select')
    select.className = 'data-type-select'

     // Add default option
    const option = document.createElement('option')
    const defaultText = '--- None ---'
    option.innerText = defaultText
    select.appendChild(option)

    // Add all options
    for (let i = 0; i < names.length; i++) {
        const option = document.createElement('option')
        option.innerText = names[i]
        select.appendChild(option)
    }

    select.selectedIndex = selected == null ? 0 : (names.indexOf(selected)+1)

    return select
}

function addUpdatedData(object, fieldIndex, value, originalValue, id = 0) {
    if (updated_data[object.index] == null)
        updated_data[object.index] = {}

    if (updated_data[object.index][fieldIndex] == null)
        updated_data[object.index][fieldIndex] = []

    if (updated_data[object.index][fieldIndex][id] == null)
        updated_data[object.index][fieldIndex][id] = originalValue

    if (updated_data[object.index][fieldIndex][id] == value) {
        delete updated_data[object.index][fieldIndex][id]
        
        if (updated_data[object.index][fieldIndex].every(e => e == null))
            delete updated_data[object.index][fieldIndex]
    }
}

function clearUpdatedData() {
    for (const index in updated_data) {
        delete updated_data[index]
    }
}

export default ObjectView
export {
    clearUpdatedData
}