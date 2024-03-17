const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron')
const ProgressBar = require('electron-progressbar')
const Store = require('electron-store')

const store = new Store()
let win, progressBar

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
    app.quit();
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

/** 
 * Main entry point
 */
app.whenReady().then(() => {
    // Setup IPC events
    ipcMain.handle('open-file', showOpenFileDialog)
    ipcMain.handle('save-file', showSaveFileDialog)
    ipcMain.handle('open-folder', showOpenFolderDialog)
    ipcMain.handle('create-import-modal', createImportModal)
    ipcMain.handle('show-confirm-message', showConfirmMessage)
    ipcMain.on('show-info-message', showInfoMessage)
    ipcMain.on('show-warning-message', showWarningMessage)
    ipcMain.on('show-error-message', showErrorMessage)
    ipcMain.on('set-progress-bar', setProgressBar)
    
    createMainWindow()
  
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow()
        }
    })
})

/**
 * Creates the main window
 */
function createMainWindow() {
    win = new BrowserWindow({
        width: 1400,
        height: 800,
        show: false,
        webPreferences: {
            // preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
            additionalArguments: [ "main_window" ],
            sandbox: false,
            devTools: true,

            nodeIntegration: true,
            contextIsolation: false
        }
    })

    // Build the menu
    const menu_template = [
        {
            label: 'File',
            submenu: [
                { 
                    label: 'Open',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => win.webContents.send('menu-open'),
                }, { 
                    label: 'Import',
                    accelerator: 'CmdOrCtrl+I',
                    click: () => win.webContents.send('menu-import'),
                }, { 
                    label: 'Reload',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => win.webContents.send('menu-reload'),
                }, {
                    type: 'separator',
                }, { 
                    label: 'Save',
                    accelerator: 'CmdOrCtrl+S',
                    click: () => win.webContents.send('menu-save'),
                }, { 
                    label: 'Save As',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: () => win.webContents.send('menu-save-as'),
                }, {
                    label: 'Save And Launch',
                    accelerator: 'CmdOrCtrl+L',
                    click: () => win.webContents.send('menu-save-launch'),
                },
                { 
                    label: 'Revert Level',
                    accelerator: 'CmdOrCtrl+Shift+R',
                    click: () => win.webContents.send('menu-revert'),
                    
                }, {
                    type: 'separator',
                }, {
                    role: 'quit'
                }
            ]
        },
        {
            label: 'Settings',
            submenu: [
                {
                    label: 'Set game folder path',
                    click: () => win.webContents.send('menu-change-game-folder')
                },
                {
                    label: 'Backup game folder',
                    click: () => win.webContents.send('menu-backup-game-folder')
                },
                {
                    label: 'Restore game folder',
                    click: () => win.webContents.send('menu-restore-game-folder')
                },
                {
                    type: 'separator'
                },
                {
                    label: 'View data as big endian',
                    type: 'checkbox',
                    checked: store.get('menu-toggle-endian', true),
                    click: (e) => {
                        store.set('menu-toggle-endian', e.checked)
                        win.webContents.send('menu-toggle-endian', e.checked)
                    }
                },
                {
                    label: 'Update referenceCount on save',
                    type: 'checkbox',
                    checked: store.get('menu-toggle-refcount', true),
                    click: (e) => {
                        store.set('menu-toggle-refcount', e.checked)
                        win.webContents.send('menu-toggle-refcount', e.checked)
                    }
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Open dev tools',
                    click: () => win.webContents.openDevTools()
                }
            ]
        },
        {
            label: 'Level Explorer',
            submenu: [
                {
                    label: 'Load/Reload Level Explorer',
                    accelerator: 'CmdOrCtrl+E',
                    click: () => win.webContents.send('menu-open-explorer'),
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Show splines',
                    type: 'checkbox',
                    checked: store.get('menu-toggle-show-splines', true),
                    click: (e) => {
                        store.set('menu-toggle-show-splines', e.checked)
                        win.webContents.send('menu-toggle-show-splines', e.checked)
                    }
                },
                {
                    label: 'Show entity links',
                    type: 'checkbox',
                    checked: store.get('menu-toggle-show-entity-links', false),
                    click: (e) => {
                        store.set('menu-toggle-show-entity-links', e.checked)
                        win.webContents.send('menu-toggle-show-entity-links', e.checked)
                    }
                },
                {
                    label: 'Show grass',
                    type: 'checkbox',
                    checked: store.get('menu-toggle-show-grass', false),
                    click: (e) => {
                        store.set('menu-toggle-show-grass', e.checked)
                        win.webContents.send('menu-toggle-show-grass', e.checked)
                    }
                },
                {
                    label: 'Show hidden objects',
                    type: 'checkbox',
                    checked: store.get('menu-toggle-show-all-objects', false),
                    click: (e) => {
                        store.set('menu-toggle-show-all-objects', e.checked)
                        win.webContents.send('menu-toggle-show-all-objects', e.checked)
                    }
                },
                {
                    label: 'Render at full resolution',
                    type: 'checkbox',
                    checked: store.get('menu-toggle-full-resolution', false),
                    click: (e) => {
                        store.set('menu-toggle-full-resolution', e.checked)
                        win.webContents.send('menu-toggle-full-resolution', e.checked)
                    }
                }
            ]
        },
        {
            label: 'About',
            submenu: [
                {
                    label: 'README.md',
                    click: () => shell.openExternal('https://github.com/kishimisu/Crash-NST-Modding-Tool/blob/main/README.md')
                },
                {
                    label: 'Contribute on Github!',
                    click: () => shell.openExternal('https://github.com/kishimisu/Crash-NST-Modding-Tool')
                }
            ]
        }
    ]

    win.setMenu(Menu.buildFromTemplate(menu_template))
    win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
    if (process.env.NODE_ENV === 'development') win.webContents.openDevTools()

    win.once('ready-to-show', () => {
        win.webContents.once("did-finish-load", () => {
            win.show()
        })
    })
}

/**
 * Creates an import modal window
 */
function createImportModal(event, props) {
    const child = new BrowserWindow({
        parent: win,
        modal: true,
        show: false,
        webPreferences: {
            // preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
            devTools: true,
            sandbox: false,

            nodeIntegration: true,
            contextIsolation: false
        }
    })

    child.removeMenu()
    child.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
    // child.webContents.openDevTools()

    child.webContents.once('dom-ready', () => {
        child.webContents.send('init-import-modal', props)
    })

    child.once('ready-to-show', () => {
        child.setTitle('Import from ' + props.file_path)
        child.webContents.once("did-finish-load", () => {
            child.show()
        })
    })

    return new Promise((resolve, reject) => {
        ipcMain.once('on-file-select', (event, fileIndex, importDeps) => {
            child.destroy()
            resolve([fileIndex, importDeps])
        })

        child.on('close', () => {
            resolve(null)
        })
    })
}

/**
 * Shows the OS file selection dialog
 * 
 * @param {String[]} extensions Array of enabled file extensions
 * @returns the path to the selected file
 */
function showOpenFileDialog(event, extensions = ['pak', 'igz']) {
    const filePath = dialog.showOpenDialogSync({
        properties: ['openFile'],
        filters: [
            { 
                name: extensions.map(e => '.' + e).join('/') + ' files', 
                extensions
            },
        ]
    })

    return filePath ? filePath[0] : null
}

/**
 * Shows the OS folder selection dialog
 * 
 * @returns the path to the selected folder
 */
function showOpenFolderDialog() {
    const filePath = dialog.showOpenDialogSync({ properties: ['openDirectory'] })
    return filePath ? filePath[0] : null
}

/**
 * Shows the OS file save dialog
 * 
 * @param {String} extension Enabled file extension
 * @returns the path to the saved file
 */
function showSaveFileDialog(event, extension = 'pak') {
    const filePath = dialog.showSaveDialogSync({
        filters: [
            { 
                name: '.' + extension + ' files', 
                extensions: [ extension ]
            },
        ]
    })

    return filePath
}

/**
 * Updates the current progress bar window
 * Creates a new progress bar if it doesn't exist.
 * 
 * @param {*} current_file Number of files processed so far
 * @param {*} file_count Total files to process. If null, the progress bar will be indeterminate
 */
function setProgressBar(event, current_file, file_count, title, detail, text = "files written") {   
    // reset progress bar
    if (current_file == null) {
        if (progressBar != null) {
            progressBar.setCompleted()
            progressBar = null
        }
        win.setProgressBar(0)
        return
    }

    const isLoadingBar = file_count == null

    // create progress bar
    if (progressBar == null) {
        progressBar = new ProgressBar({
            title,
            detail,
            maxValue: 1,
            indeterminate: isLoadingBar,
            browserWindow: {
                parent: win,
                closable: current_file == null,
            }
        })
        // progressBar.on('aborted', function() {});
    }

    const progress = isLoadingBar ? 0 : (current_file + 1) / file_count
    if (!isLoadingBar) progressBar.value = progress
    progressBar.text = isLoadingBar ? text : `${current_file} / ${file_count} ${text}. (${(progress * 100).toFixed(2)}%)`
    progressBar.detail = detail

    if (progress == 1) {
        progressBar.setCompleted()
        progressBar = null
    }

    win.setProgressBar(progress == 1 ? 0 : progress)
}

async function showConfirmMessage(event, message) {
    const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Yes', 'No'],
        message
    })
    return response == 0
}

function showInfoMessage(event, message) {
    dialog.showMessageBox(win, { type: 'info', message })
}

function showWarningMessage(event, message) {
    dialog.showMessageBox(win, { type: 'warning', message })
}

function showErrorMessage(event, title = 'Error', message) {
    dialog.showErrorBox(title, message)
}