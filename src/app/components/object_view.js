import ObjectField, { clearUpdatedData } from './object_field'
import { createElm, elm } from "./utils/utils"
import { bitRead } from '../../utils'
import { TYPES_METADATA } from './utils/metadata'

// Save interesting fields on IGZ load (fields that have 
// different values between objects of the same type)
const interesting_fields = {
    igz: null,
    fields: {}
}

// Save memory fields on IGZ load to be able to link 
// their children if they are not in the same object
const memory_fields = {
    igz: null,
    fields: []
}

class ObjectView {
    hoverColor = '#4c4c4c'
    
    constructor(object, init_dom = true) {
        const fields = TYPES_METADATA[object.type] // Retrieve fields metadata from the object's type

        this.container = elm('#object-view')  // Field list DOM container
        this.object = object                  // parent igObject reference

        this.fields = this.initFields(fields) // Array of ObjectField instances
        this.hexCells = []                    // Array of cells from the hex data view

        this.selected = null                  // { field, cell }, Currently selected field and cell 

        if (init_dom) {
            elm('#object-name').innerText = object.getDisplayName()
            this.findAllMemoryFields()
            this.findInterestingFields()
            this.createFieldList()
            this.createHexDataCells()
        }
    }
    
    /**
     * Converts fields infos to ObjectField instances
     * and sets their parent and children references.
     */
    initFields(fields) {
        fields = fields.map(e => new ObjectField(e))
        fields.forEach(e => {
            e.object = this.object
            if (e.parent)   e.parent = fields.find(f => f.name === e.parent.name)
            if (e.children) e.children = e.children.map(c => fields.find(f => f.name === c.name))
        })
        return fields
    }

    /**
     * Creates hex data cells for each 4 bytes of the object's data
     */
    createHexDataCells() {
        const bytesPerRow = 4 * 6
        const table = elm('#data-table')
        table.onmouseleave = () => this.onMouseLeave()
        
        let row = createElm('tr')
        this.hexCells = []

        Main.showObjectDataView(true)

        // Iterate over every 4 bytes of the object's data
        for (let i = 0; i <= this.object.data.length - 4; i += 4) {
            const value = this.object.view.readInt(i)

            // Create offset column
            if (i % bytesPerRow == 0) {
                const offsetCell = createElm('td')
                offsetCell.innerText = '0x' + i.toString(16).toUpperCase().padStart(4, '0')
                offsetCell.classList.add('hex-offset')
                row.appendChild(offsetCell)
            }

            // Create hex cell DOM element
            const cell = createElm('td', 'hex-zero')
            cell.innerText = (value >>> 0).toString(16).toUpperCase().padStart(8, '0').replace(/(.{2})/g, '$1 ')
            if ((localStorage.getItem('big-endian') ?? 'true') === 'false') 
                cell.innerText = cell.innerText.split(' ').reverse().join(' ')
            
            // Create hex cell object
            const hexCell = { element: cell, offset: i }
            this.hexCells.push(hexCell)

            // Add mouse events
            cell.onclick = () => this.setSelected(hexCell.fields[0], hexCell)
            cell.onmouseover = () => {
                if (this.selected == null) 
                    this.onCellHover(hexCell)
            }

            // Add to row
            row.appendChild(cell)

            if (i % bytesPerRow == bytesPerRow - 4) {
                table.appendChild(row)
                row = createElm('tr')
            }
            if (i == this.object.data.length - 4) {
                table.appendChild(row)
            }
        }

        this.setupCellsAndFields()
        this.styleHexDataCells()
    }

    /**
     * Colorize hex cells based on the fields' type, colorization state and value
     */
    styleHexDataCells() {
        if (this.fields.length == 0) return

        // Loop through all fields and colorize corresponding hex cells
        for (let i = 0; i < this.fields.length; i++) {
            const field = this.fields[i]

            // Skip fields that do not point to this object (some igMemoryRef elements)
            if (field.object !== this.object) continue

            // If bitfield, colorize root cell with the first children only
            if (field.bitfield && field.offset - field.parent.offset > 0) continue

            const colorType = field.getColorClass()
            
            // Colorize corresponding data cells
            for (let j = 0; j < Math.ceil(field.size / 4); j++) {
                const cell = this.hexCells[Math.floor(field.offset / 4) + j].element
                const isLong = field.isLongType()
                const method = isLong ? 'Int' : field.getIntegerMethod() ?? 'Int'
                const value = this.object.view['read' + method](field.offset + j * 4) >>> 0
                const isValid = value != 0 && value != 0xFFFFFFFF
                
                if ((field.colorized == null && isValid) || (field.colorized === true && (j == 0 || isValid))) {
                    cell.style.filter = 'brightness(1.1)'
                    cell.classList.remove('hex-zero')
                    cell.classList.add(colorType)
                }
                else if (value != 0) cell.style.filter = 'brightness(1.6)' 

                if (field.isUpdated(j) || isLong && field.isUpdated()) {
                    cell.classList.remove('hex-zero')
                    cell.classList.add('hex-updated')
                    cell.classList.add(colorType)
                }
            }
        }

        // Colorize unassigned cells that have a value
        const lastField = this.fields.reduce((a, b) => a.offset + a.size > b.offset + b.size ? a : b)
        let lastOffset = lastField.offset + lastField.size
        if (lastOffset % 4 != 0) lastOffset += 4 - (lastOffset % 4)
        for (let i = lastOffset; i < this.object.size; i += 4) {
            const cell = this.hexCells[i/4].element
            const value = this.object.view.readUInt(i)
            if (value != 0 && value != 0xFAFAFAFA) cell.classList.remove('hex-zero')
        }
    }

    /**
     * Create DOM elements for each field and add them to the container
     */
    createFieldList() {
        this.container.innerHTML = ''
        this.container.onmouseleave = () => this.onMouseLeave()
        Main.showObjectDataView(true)

        if (this.object.type == 'CVscComponentData') {
            this.createCommonSpawnerTemplate()
        }

        // Setup MemoryRef fields
        for (const field of this.fields) {
            if (field.type == 'igMemoryRefMetaField') {
                this.setupMemoryRefField(field)
            }
            else if (field.type == 'igVectorMetaField') {
                this.setupMemoryRefField(field, 8) // igVectors contains a igMemoryRef
            }
        }

        // Link unassigned data defined in external memory fields
        memory_fields.fields.filter(e => e.ref_object == this.object)
                            .forEach(e => this.fields.push(e, ...e.children))

        // Create all fields
        for (const [index, field] of Object.entries(this.fields)) {
            field.index ??= parseInt(index)

            const row = field.createField({
                onChange: this.onFieldUpdate.bind(this, field),
                onHover:  () => this.onFieldHover(field),
                onSelect: () => this.setSelected(field, field.hexCells[0]),
            })
            this.container.appendChild(row)
        }

        // Add object's references to the bottom of the field list
        const refs = this.object.references.filter(e => e.index !== 0).map(e => '<p>&nbsp;&nbsp;' + e.getDisplayName())
        const div = createElm('div', 'ref-list')
        div.innerHTML = `References: (${refs.length}) ` + refs.join('</p>') + '</p>'
        this.container.appendChild(div)
    }

    /**
     * Setup additional fields for MemoryRef fields:
     * _size, _bitfield, _address and all children elements
     * Also matches _keys and _values fields
     */
    setupMemoryRefField(field, igMemoryRefOffset = 0) {
        if (field.children) return

        const getMemoryInfos = (field) => {
            const bitfield = this.object.view.readUInt(field.offset + igMemoryRefOffset + 4)

            const mem = {
                field,
                memSize:     this.object.view.readUInt(field.offset + igMemoryRefOffset),
                active:      (bitfield >> 0x18) & 0x1 != 0x0,
                dataOffset:  this.object.view.readUInt(field.offset + igMemoryRefOffset + 8),
                elementSize: field.getTypeSize(field.memType),
            }
            mem.elementCount   = mem.memSize / mem.elementSize
            mem.object         = Main.igz.findObject(mem.dataOffset)
            mem.startOffset    = Main.igz.getGlobalOffset(mem.dataOffset) - mem.object.global_offset
            mem.field.children = []
            mem.field.collapsable = true
            return mem
        }

        const addMemoryElement = (mem, index, offset) => {
            const field = new ObjectField({
                index:  index,
                name:   `${mem.field.name} #${index}`,
                type:    mem.field.memType,
                refType: mem.field.elmType,
                size:    mem.elementSize,
                parent:  mem.field,
                object:  mem.object,
                offset:  offset,
            })
            mem.field.children.push(field)
        }

        const updateField = (mem) => {
            if (mem == null) return
            mem.field.element_size    = mem.elementSize
            mem.field.memory_size     = mem.memSize
            mem.field.capacity        = mem.elementCount
            mem.field.element_count   = mem.field.children.length
            mem.field.ref_object      = mem.object
            mem.field.ref_data_offset = mem.startOffset
            mem.field.collapsable     = mem.field.element_count > 0
            mem.field.memory_active   = mem.active

            if (mem.field.ref_object != mem.field.object) mem.field.name += ' (external)'

            const fieldID = this.fields.indexOf(mem.field)
            this.fields = this.fields.slice(0, fieldID + 1).concat(mem.field.children).concat(this.fields.slice(fieldID + 1))
        }

        // Create values and keys(optional) MemoryRef fields
        const values   = getMemoryInfos(field)
        const keyField = this.fields.find(e => e.name === '_keys')
        const keys     = field.name === '_values' && keyField ? getMemoryInfos(keyField) : null

        if (keys && keys.elementCount != values.elementCount) console.warn('Value and keys count mismatch:', values.elementCount, keys.elementCount)

        // Add elements to the list(s)
        if (field.memType != 'void' && values.active)
            for (let k = 0, index = 0; k < values.elementCount; k++) {
                if (keys) {
                    const keyOffset = keys.startOffset + k * keys.elementSize
                    const key = keys.object.view.readInt(keyOffset)

                    // Skip invalid keys
                    // TODO: Should include fixup lookup
                    if (keys.field.isIntegerType(keys.field.memType) && key >>> 0 == 0xFAFAFAFA) continue
                    else if (key == 0) continue
                    
                    addMemoryElement(keys, index, keyOffset) // Add key
                }


                const valueOffset = values.startOffset + k * values.elementSize
                addMemoryElement(values, index++, valueOffset) // Add value
            }

        updateField(values)
        updateField(keys)
    }

    createCommonSpawnerTemplate() {
        let offset = this.object.view.readInt(0x18) - this.object.offset
        const _metaObject = this.object.view.readInt(0x20)
        const inRNEX = Main.igz.fixups.RNEX?.data.includes(this.object.offset + 0x20)
        const handle = Main.igz.named_externals[_metaObject]

        if (!inRNEX || handle[0] != 'common_Spawner_TemplateData') return

        const fields = [
            { name: 'ActivateCheckpointLoad', type: 'igBoolMetaField', size: 1 },
            { name: 'ActivateOnSpawn', type: 'igBoolMetaField', size: 1 },
            { name: 'RespawnOnDeath', type: 'igBoolMetaField', size: 1 },
            { name: 'SpawnOnEnter', type: 'igBoolMetaField', size: 1 },
            { name: 'WaitForSpawnTemplateEvent', type: 'igBoolMetaField', size: 4 },
            { name: 'SpawnAtEntity', type: 'igHandleMetaField', size: 8 },
            { name: 'UsedEntityToSpawn', type: 'igHandleMetaField', size: 8 },
            { name: 'TriggerVolume', type: 'igHandleMetaField', size: 8 },
            { name: 'EntityToSpawn', type: 'igHandleMetaField', size: 8 },
            { name: 'InitialDelay', type: 'igFloatMetaField', size: 4 },
            { name: 'DeathRespawnTimer', type: 'igFloatMetaField', size: 4 },
            { name: 'Bool_id_j3kcr18d', type: 'igBoolMetaField', size: 1 },
            { name: 'Bool_id_o8p58cmq', type: 'igBoolMetaField', size: 1 },
            { name: 'NewEnum11_id_6xic0fuw', type: 'igEnumMetaField', size: 2 },
            { name: 'Bool_id_x2ny9dmw', type: 'igBoolMetaField', size: 4 },
            { name: 'Bool_id_9b50frs9', type: 'igBoolMetaField', size: 4 },
            { name: 'Bool_id_tm3edvov', type: 'igBoolMetaField', size: 4 },
        ]
        .map(e => {
            offset += e.size
            return new ObjectField({
                object: this.object,
                offset: offset - e.size,
                refType: e.type == 'igObjectRefMetaField' ? 'CEntity' : null,
                ...e,
            })
        })

        this.fields.push(...fields)
    }

    // Update an object's data when a field is modified
    // Apply changes to all objects if the "Apply to all" checkbox is checked
    onFieldUpdate(field, value, id) {
        const searchMatches = Main.tree.matched()

        if (elm('#apply-all-checkbox').checked && searchMatches.length > 0) {
            searchMatches.each((e, i) => {
                const object = Main.igz.objects[e.objectIndex]
                field.updateObject(object, value, i == 0, id)
            })
        }
        else {
            field.updateObject(this.object, value, true, id)
        }

        const saveCellIDs = field.hexCells.map(e => this.hexCells.indexOf(e))

        field.refreshNameStyle()
        this.createHexDataCells()
        this.onFieldHover(field)
        this.lastEditTime = Date.now()

        saveCellIDs.forEach(e => this.hexCells[e].element.classList.add('hex-flash')) // Flashing animation

        Main.igz.updated = true
        if (Main.pak) Main.pak.updated = true

        Main.updateTitle()
        Main.colorizeMainTree()
    }

    // Sets the hex cells and fields references
    setupCellsAndFields() {
        for (const field of this.fields) {
            if (field.object !== this.object) continue
            const cellStart = Math.floor(field.offset / 4)
            const cellEnd   = Math.ceil((field.offset + field.size) / 4)
            field.hexCells = this.hexCells.slice(cellStart, cellEnd)
            
            if (field.isMemoryType() && field.object == this.object) {
                // Add all data cells to igMemoryRef fields
                const dataStart = Math.floor(field.ref_data_offset / 4)
                const dataEnd   = Math.ceil((field.ref_data_offset + field.memory_size) / 4)
                field.hexCells.push(...this.hexCells.slice(dataStart, dataEnd))
            }
        }

        for (const cell of this.hexCells) {
            cell.fields = this.fields.filter(e => e.object == this.object && cell.offset >= e.offset && cell.offset < e.offset + e.size)
        }
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
            let firstValue = null

            if (field.children) continue

            if (field.bitfield) {
                const bytes = allObjects[0].view.readInt(field.offset)
                firstValue = bitRead(bytes, field.bits, field.shift)
            }
            else {
                firstValue = allObjects[0].view.readBytes(field.size, field.offset)
            }

            for (let j = 1; j < allObjects.length; j++) {
                let interesting = false

                if (field.bitfield) {
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

    // Find all memory fields pointing to external data in the igz file
    findAllMemoryFields() {
        if (memory_fields.igz == Main.igz) return // Only run once per igz file

        memory_fields.igz = Main.igz
        memory_fields.fields = []

        for (const obj of Main.igz.objects) {
            const mems = new ObjectView(obj, false)
                            .findMemories()
                            .filter(e => e.ref_object != e.object)

            memory_fields.fields.push(...mems.map(e => {
                e.name = `(${obj.getDisplayName()})`
                return e
            }))
        }
    }

    // Find all memory fields in the object's fields
    findMemories() {
        const memories = []

        const addMemory = (field, offset = 0) => {
            this.setupMemoryRefField(field, offset)
            if (!field.children?.length) return
            memories.push(field)
        }
        this.fields.forEach(e => {
            if (e.type == 'igMemoryRefMetaField')   addMemory(e)
            else if (e.type == 'igVectorMetaField') addMemory(e, 8)
        })

        return memories
    }

    // Sets the currently selected field and cell
    setSelected(field, cell, forceSelect = false) {
        // Reset selection if clicked on the same field/cell
        this.selected = this.selected != null && (this.selected.field === field || this.selected.cell === cell) ? null : { field, cell }

        // Select parent field if current field is collapsed
        if (this.selected?.field?.collapsed && this.selected?.field.parent) this.selected.field = this.selected.field.parent

        // Update css
        this.fields.forEach(e => {
            if (e === this.selected?.field) e.element.classList.add('selected')
            else e.element.classList.remove('selected')
        })
        this.hexCells.forEach(e => {
            if (e === this.selected?.cell) e.element.classList.add('selected')
            else e.element.classList.remove('selected')
        })

        this.onCellHover(cell, forceSelect)
    }

    onFieldHover(field) {
        if (Date.now() - this.lastEditTime < 100) return // Prevent focusing another field just after closing a dropdown

        // Update field list
        this.fields.forEach(e => {
            e.element.style.filter = e === this.selected?.field || e === field ? 'brightness(1.7)' : ''
        })

        // Update hex cells
        this.hexCells.forEach(e => {
            e.element.style.backgroundColor = field.hexCells.includes(e) ? this.hoverColor : ''
        })

        if (this.object == field.object)
            field.hexCells[0].element.parentNode.scrollIntoViewIfNeeded()
    }

    onCellHover(cell, forceSelect = false) {
        // Update field list
        this.fields.forEach(e => {
            e.element.style.filter = e.hexCells.includes(cell) ? 'brightness(1.7)' : ''
        })

        // Update hex cells
        let cellsToHighlight = []

        if (cell?.fields.length > 0) {
            cell.fields[0].element.scrollIntoViewIfNeeded()
            cellsToHighlight = cell.fields[0].hexCells
        }
        if (cellsToHighlight.length === 0 && forceSelect && cell) cellsToHighlight = [cell]

        this.hexCells.forEach(e => {
            e.element.style.backgroundColor = cellsToHighlight.includes(e) ? this.hoverColor : ''
        })
    }

    onMouseLeave() {
        // Focus currently selected field
        if (this.selected?.field) 
            this.onFieldHover(this.selected.field)
        // Otherwise reset all styles
        else {
            this.hexCells.forEach(e => e.element.style.backgroundColor = '')
            this.fields.forEach(e => e.element.style.filter = '')
        }
    }

    // On parent igz save
    onSave() {
        document.activeElement?.blur()
        clearUpdatedData()
        this.createHexDataCells()
        this.fields.forEach(e => e.refreshNameStyle())
    }
}

export default ObjectView