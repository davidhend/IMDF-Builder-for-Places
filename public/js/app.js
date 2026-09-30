// IMDF Builder Application

// Category palette — approximates Microsoft Places' light-theme tints so the
// canvas previews roughly what the imported map will look like (Places picks
// the real colours itself from the unit category; IMDF has no colour control).
// Fills stay translucent so the floor-plan image shows through while editing.
const CATEGORY_STYLES = {
    room:           { fill: 'rgba(203, 224, 244, 0.55)', stroke: '#7ba7cc' },
    office:         { fill: 'rgba(203, 224, 244, 0.55)', stroke: '#7ba7cc' },
    workspace:      { fill: 'rgba(180, 211, 241, 0.55)', stroke: '#6b9cc4' },
    conferenceroom: { fill: 'rgba(215, 207, 242, 0.55)', stroke: '#907fc0' },
    conference:     { fill: 'rgba(215, 207, 242, 0.55)', stroke: '#907fc0' },
    phoneroom:      { fill: 'rgba(224, 218, 245, 0.55)', stroke: '#9a8bc8' },
    mothersroom:    { fill: 'rgba(224, 218, 245, 0.55)', stroke: '#9a8bc8' },
    restroom:       { fill: 'rgba(199, 208, 246, 0.55)', stroke: '#7f8cc9' },
    elevator:       { fill: 'rgba(214, 220, 228, 0.60)', stroke: '#8a97a8' },
    stairs:         { fill: 'rgba(214, 220, 228, 0.60)', stroke: '#8a97a8' },
    walkway:        { fill: 'rgba(238, 238, 234, 0.60)', stroke: '#c4c4bc' },
    lobby:          { fill: 'rgba(232, 224, 206, 0.55)', stroke: '#b3a071' },
    foodservice:    { fill: 'rgba(233, 217, 193, 0.55)', stroke: '#bfa26e' },
    kitchen:        { fill: 'rgba(233, 217, 193, 0.55)', stroke: '#bfa26e' },
    lounge:         { fill: 'rgba(214, 235, 224, 0.55)', stroke: '#74ab8e' },
    seating:        { fill: 'rgba(214, 235, 224, 0.55)', stroke: '#74ab8e' },
    nonpublic:      { fill: 'rgba(206, 208, 211, 0.60)', stroke: '#8f9499' },
    storage:        { fill: 'rgba(206, 208, 211, 0.60)', stroke: '#8f9499' },
    wall:           { fill: 'rgba(125, 135, 150, 0.50)', stroke: '#5d6878' },
    unspecified:    { fill: 'rgba(0, 120, 212, 0.3)',    stroke: '#0078d4' }
};
// Sections (desk pools) are drawn as a dashed outline with no fill, so one
// can cover a whole floor without hiding the rooms and desks beneath it —
// and, hit-tested per pixel, only its outline catches the mouse, so clicks
// inside still select what is underneath.
const SECTION_STYLE = {
    fill: 'rgba(255, 140, 0, 0)', stroke: '#ff8c00', strokeWidth: 3, strokeDashArray: [10, 6],
    perPixelTargetFind: true
};

function styleForUnit(data) {
    if ((data.featureType || 'unit') === 'section') return SECTION_STYLE;
    return {
        ...(CATEGORY_STYLES[data.category] || CATEGORY_STYLES.unspecified),
        strokeWidth: 2, strokeDashArray: null, perPixelTargetFind: false
    };
}

class IMDFBuilder {
    constructor() {
        this.canvas = null;
        this.currentTool = 'select';
        this.currentLevel = null;
        this.levels = [];
        this.units = [];
        this.amenities = [];
        this.fixtures = [];
        this.openings = [];
        this.selectedObject = null;
        this.projectId = null;
        this.floorplanImage = null;
        // Persisted so re-exports keep the same IMDF feature ids — a filled-in
        // Microsoft Places correlations CSV stays valid across exports.
        this.buildingId = null;
        this.footprintId = null;
        
        this.init();
    }

    init() {
        this.initPdfJs();
        this.initCanvas();
        this.attachEventListeners();
        this.updateCounts();
        this.initTheme();
        this.loadVersion();
    }

    async loadVersion() {
        try {
            const res = await fetch('/api/version');
            const { version } = await res.json();
            const el = document.getElementById('appVersion');
            if (el && version) el.textContent = `v${version}`;
        } catch {
            // Non-fatal: leave the placeholder if the version can't be fetched.
        }
    }

    initTheme() {
        // The inline head script already set data-theme; mirror it into the UI and
        // wire the toggle. Falls back to OS preference when nothing is stored.
        const saved = localStorage.getItem('imdf-theme');
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        this.applyTheme(saved || (prefersDark ? 'dark' : 'light'));

        const toggle = document.getElementById('themeToggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                localStorage.setItem('imdf-theme', next);
                this.applyTheme(next);
            });
        }
    }

    applyTheme(theme) {
        const isDark = theme === 'dark';
        document.documentElement.setAttribute('data-theme', theme);

        const icon = document.querySelector('.theme-toggle-icon');
        const label = document.querySelector('.theme-toggle-label');
        if (icon) icon.textContent = isDark ? '☀' : '☾';
        if (label) label.textContent = isDark ? 'Light' : 'Dark';

        // Keep the Fabric drawing surface in sync with the theme.
        if (this.canvas) {
            this.canvas.backgroundColor = isDark ? '#1e1e1e' : '#ffffff';
            this.canvas.renderAll();
        }
    }

    initPdfJs() {
        // pdf.js runs its parser in a web worker; point it at the vendored copy.
        if (window.pdfjsLib) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.js';
        }
    }

    initCanvas() {
        const canvasElement = document.getElementById('mainCanvas');
        const container = canvasElement.parentElement;
        
        // Set canvas size to fill container
        canvasElement.width = container.clientWidth;
        canvasElement.height = container.clientHeight;
        
        this.canvas = new fabric.Canvas('mainCanvas', {
            backgroundColor: '#ffffff',
            selection: true,
            // Makes a section's thin dashed outline comfortably clickable.
            targetFindTolerance: 5
        });

        // Handle window resize
        window.addEventListener('resize', () => {
            const container = canvasElement.parentElement;
            this.canvas.setDimensions({
                width: container.clientWidth,
                height: container.clientHeight
            });
            this.canvas.renderAll();
        });

        // Canvas event handlers
        this.canvas.on('selection:created', (e) => this.handleSelection(e));
        this.canvas.on('selection:updated', (e) => this.handleSelection(e));
        this.canvas.on('selection:cleared', () => this.clearSelection());
        this.canvas.on('mouse:down', (e) => {
            if (e.e && e.e.altKey) {
                this.cycleSelectionUnderPointer(e);
                return;
            }
            this.handleCanvasClick(e);
        });

        // Live pixel readout while dragging or resizing a shape.
        this.canvas.on('object:moving', (e) => this.showObjectMetrics(e.target));
        this.canvas.on('object:scaling', (e) => this.showObjectMetrics(e.target));
        this.canvas.on('object:modified', (e) => this.showObjectMetrics(e.target));
    }

    attachEventListeners() {
        // Project controls
        document.getElementById('newProjectBtn').addEventListener('click', () => this.newProject());
        document.getElementById('saveProjectBtn').addEventListener('click', () => this.saveProject());
        document.getElementById('loadProjectBtn').addEventListener('click', () => this.showLoadProjectModal());
        
        // Upload floor plan
        document.getElementById('uploadBtn').addEventListener('click', () => this.uploadFloorplan());
        document.getElementById('autoTraceBtn').addEventListener('click', () => this.autoTraceRooms());
        
        // Level management
        document.getElementById('addLevelBtn').addEventListener('click', () => this.addLevel());
        
        // Tool selection
        document.querySelectorAll('.btn-tool').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tool = e.target.dataset.tool;
                this.setTool(tool);
            });
        });

        // Delete selected
        document.getElementById('deleteBtn').addEventListener('click', () => this.deleteSelected());

        // Canvas controls
        document.getElementById('zoomInBtn').addEventListener('click', () => this.zoomIn());
        document.getElementById('zoomOutBtn').addEventListener('click', () => this.zoomOut());
        document.getElementById('resetViewBtn').addEventListener('click', () => this.resetView());

        // Export
        document.getElementById('exportBtn').addEventListener('click', () => this.exportIMDF());
        document.getElementById('previewBtn').addEventListener('click', () => this.previewPlaces());
        document.getElementById('previewClose').addEventListener('click', () => {
            document.getElementById('previewModal').style.display = 'none';
        });
        document.getElementById('effect3d').addEventListener('change', (e) => {
            document.getElementById('wallHeightGroup').style.display = e.target.checked ? '' : 'none';
        });

        // Modal close
        document.querySelector('.close').addEventListener('click', () => {
            document.getElementById('loadProjectModal').style.display = 'none';
        });
    }

    setTool(tool) {
        this.currentTool = tool;
        document.querySelectorAll('.btn-tool').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        
        if (tool === 'select') {
            this.canvas.selection = true;
            this.canvas.isDrawingMode = false;
        } else {
            this.canvas.selection = false;
            this.canvas.isDrawingMode = false;
        }
        
        this.updateCanvasInfo(`Tool: ${tool}`);
    }

    handleCanvasClick(event) {
        if (!event.pointer || this.currentTool === 'select') return;
        if (!this.currentLevel) {
            alert('Please add and select a level first');
            return;
        }

        const pointer = this.canvas.getPointer(event.e);
        
        switch (this.currentTool) {
            case 'unit':
                this.placeUnit(pointer);
                break;
            case 'section':
                this.placeSection(pointer);
                break;
            case 'amenity':
                this.placeAmenity(pointer);
                break;
            case 'fixture':
                this.placeFixture(pointer);
                break;
            case 'opening':
                this.placeOpening(pointer);
                break;
        }
    }

    placeUnit(pointer) {
        const rect = new fabric.Rect({
            left: pointer.x,
            top: pointer.y,
            width: 100,
            height: 100,
            ...CATEGORY_STYLES.room,
            strokeWidth: 2
        });

        const unit = {
            id: this.generateUUID(),
            name: `Unit ${this.units.length + 1}`,
            featureType: 'unit',
            category: 'room',
            restriction: null,
            placeId: null,
            levelId: this.currentLevel.id,
            fabricObject: rect
        };

        rect.imdfData = unit;
        this.units.push(unit);
        this.canvas.add(rect);
        this.updateCounts();
    }

    // Sections are desk pools: Places locates a bookable desk through the
    // Section directory object correlated to a section feature on the map.
    placeSection(pointer) {
        const rect = new fabric.Rect({
            left: pointer.x,
            top: pointer.y,
            width: 120,
            height: 100,
            ...SECTION_STYLE
        });

        const section = {
            id: this.generateUUID(),
            name: `Section ${this.units.filter(u => u.featureType === 'section').length + 1}`,
            featureType: 'section',
            category: 'unspecified',
            restriction: null,
            placeId: null,
            outlineOnly: true,
            levelId: this.currentLevel.id,
            fabricObject: rect
        };

        rect.imdfData = section;
        this.units.push(section);
        this.canvas.add(rect);
        this.updateCounts();
    }

    // Restyle a unit/section shape from its current category and feature type
    // so the canvas keeps previewing the Places category tints.
    applyUnitStyle(data) {
        if (!data.fabricObject) return;
        data.fabricObject.set(styleForUnit(data));
        this.canvas.renderAll();
        this.updateCounts();
    }

    placeAmenity(pointer) {
        const circle = new fabric.Circle({
            left: pointer.x,
            top: pointer.y,
            radius: 15,
            fill: 'rgba(40, 167, 69, 0.5)',
            stroke: '#28a745',
            strokeWidth: 2
        });

        const amenity = {
            id: this.generateUUID(),
            name: `Amenity ${this.amenities.length + 1}`,
            category: 'seating',
            levelId: this.currentLevel.id,
            fabricObject: circle
        };

        circle.imdfData = amenity;
        this.amenities.push(amenity);
        this.canvas.add(circle);
        this.updateCounts();
    }

    placeFixture(pointer) {
        const line = new fabric.Line([pointer.x, pointer.y, pointer.x + 50, pointer.y], {
            stroke: '#6c757d',
            strokeWidth: 3
        });

        const fixture = {
            id: this.generateUUID(),
            category: 'wall',
            levelId: this.currentLevel.id,
            fabricObject: line
        };

        line.imdfData = fixture;
        this.fixtures.push(fixture);
        this.canvas.add(line);
        this.updateCounts();
    }

    placeOpening(pointer) {
        const line = new fabric.Line([pointer.x, pointer.y, pointer.x + 30, pointer.y], {
            stroke: '#dc3545',
            strokeWidth: 4
        });

        const opening = {
            id: this.generateUUID(),
            category: 'door',
            levelId: this.currentLevel.id,
            fabricObject: line
        };

        line.imdfData = opening;
        this.openings.push(opening);
        this.canvas.add(line);
        this.updateCounts();
    }

    handleSelection(event) {
        const obj = event.selected[0];
        if (obj && obj.imdfData) {
            this.selectedObject = obj;
            this.showProperties(obj.imdfData);
            this.showObjectMetrics(obj);
        }
    }

    // Alt+click cycles through overlapping shapes under the cursor, so a
    // shape buried beneath another (a desk fixture under a furniture piece,
    // a room under a section) can still be selected and moved.
    cycleSelectionUnderPointer(event) {
        const pointer = this.canvas.getPointer(event.e);
        const point = new fabric.Point(pointer.x, pointer.y);
        const hits = this.canvas.getObjects()
            .filter(o => o.selectable !== false && o.imdfData && o.containsPoint(point))
            .reverse(); // topmost first, then progressively deeper
        if (hits.length === 0) return;
        const active = this.canvas.getActiveObject();
        const next = hits[(hits.indexOf(active) + 1) % hits.length];
        this.canvas.setActiveObject(next);
        this.canvas.renderAll();
        const name = next.imdfData.name || next.imdfData.category || 'shape';
        this.updateCanvasInfo(`Selected "${name}" — Alt+click again for the shape beneath`);
    }

    showObjectMetrics(obj) {
        if (!obj || !obj.imdfData) return;
        const w = Math.round((obj.width || 0) * (obj.scaleX || 1));
        const h = Math.round((obj.height || 0) * (obj.scaleY || 1));
        const name = obj.imdfData.name || obj.imdfData.category || 'shape';
        this.updateCanvasInfo(`${name}: ${w} × ${h} px @ (${Math.round(obj.left)}, ${Math.round(obj.top)})`);
        this.syncGeometryInputs(obj);
    }

    // Keep the properties panel's X/Y/W/H fields following the shape as it is
    // dragged or resized (only when that shape is the selected one).
    syncGeometryInputs(obj) {
        if (this.selectedObject !== obj) return;
        const values = {
            'prop-x': Math.round(obj.left),
            'prop-y': Math.round(obj.top),
            'prop-w': Math.round((obj.width || 0) * (obj.scaleX || 1)),
            'prop-h': Math.round((obj.height || 0) * (obj.scaleY || 1))
        };
        for (const [id, value] of Object.entries(values)) {
            const el = document.getElementById(id);
            if (el) el.value = value;
        }
    }

    clearSelection() {
        this.selectedObject = null;
        document.getElementById('propertiesPanel').innerHTML = '<p class="hint">Select an item to edit its properties</p>';
    }

    showProperties(data) {
        const panel = document.getElementById('propertiesPanel');
        let html = '';

        if (data.name !== undefined) {
            html += `
                <div class="property-field">
                    <label>Name:</label>
                    <input type="text" id="prop-name" value="${data.name || ''}" />
                </div>
            `;
        }

        if (data.category !== undefined) {
            html += `
                <div class="property-field">
                    <label>Category:</label>
                    <select id="prop-category">
                        <optgroup label="Rooms">
                            <option value="room" ${data.category === 'room' ? 'selected' : ''}>Room</option>
                            <option value="office" ${data.category === 'office' ? 'selected' : ''}>Office</option>
                            <option value="conferenceroom" ${data.category === 'conferenceroom' || data.category === 'conference' ? 'selected' : ''}>Conference Room</option>
                            <option value="workspace" ${data.category === 'workspace' ? 'selected' : ''}>Workspace (Desk Pool)</option>
                            <option value="phoneroom" ${data.category === 'phoneroom' ? 'selected' : ''}>Phone Room</option>
                            <option value="mothersroom" ${data.category === 'mothersroom' ? 'selected' : ''}>Mothers Room</option>
                        </optgroup>
                        <optgroup label="Circulation &amp; common">
                            <option value="walkway" ${data.category === 'walkway' ? 'selected' : ''}>Walkway / Corridor</option>
                            <option value="lobby" ${data.category === 'lobby' ? 'selected' : ''}>Lobby</option>
                            <option value="lounge" ${data.category === 'lounge' ? 'selected' : ''}>Lounge</option>
                            <option value="seating" ${data.category === 'seating' ? 'selected' : ''}>Seating</option>
                            <option value="kitchen" ${data.category === 'kitchen' ? 'selected' : ''}>Kitchen</option>
                            <option value="foodservice" ${data.category === 'foodservice' ? 'selected' : ''}>Food Service / Café</option>
                        </optgroup>
                        <optgroup label="Facilities">
                            <option value="restroom" ${data.category === 'restroom' ? 'selected' : ''}>Restroom</option>
                            <option value="elevator" ${data.category === 'elevator' ? 'selected' : ''}>Elevator</option>
                            <option value="stairs" ${data.category === 'stairs' ? 'selected' : ''}>Stairs</option>
                            <option value="nonpublic" ${data.category === 'nonpublic' ? 'selected' : ''}>Non-public / Service</option>
                            <option value="storage" ${data.category === 'storage' ? 'selected' : ''}>Storage</option>
                        </optgroup>
                        <optgroup label="Structure &amp; fixtures">
                            <option value="wall" ${data.category === 'wall' ? 'selected' : ''}>Wall</option>
                            <option value="furniture" ${data.category === 'furniture' ? 'selected' : ''}>Furniture</option>
                            <option value="desk" ${data.category === 'desk' ? 'selected' : ''}>Desk</option>
                            <option value="equipment" ${data.category === 'equipment' ? 'selected' : ''}>Equipment</option>
                            <option value="door" ${data.category === 'door' ? 'selected' : ''}>Door</option>
                            <option value="unspecified" ${data.category === 'unspecified' ? 'selected' : ''}>Unspecified</option>
                        </optgroup>
                    </select>
                </div>
            `;
        }

        // Drawn shapes can be correlated to a Microsoft Places directory object:
        // units to a Room, sections (desk pools) to a Section.
        if (this.units.some(u => u.id === data.id)) {
            const isSection = data.featureType === 'section';
            const obj = data.fabricObject;
            if (obj) {
                html += `
                    <div class="property-field">
                        <label>Position / Size (px):</label>
                        <div style="display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 4px 6px; align-items: center;">
                            <span>X</span><input type="number" id="prop-x" value="${Math.round(obj.left)}" />
                            <span>Y</span><input type="number" id="prop-y" value="${Math.round(obj.top)}" />
                            <span>W</span><input type="number" id="prop-w" value="${Math.round(obj.width * obj.scaleX)}" min="1" />
                            <span>H</span><input type="number" id="prop-h" value="${Math.round(obj.height * obj.scaleY)}" min="1" />
                        </div>
                    </div>
                `;
            }
            html += `
                <div class="property-field">
                    <label>Map Feature:</label>
                    <select id="prop-featuretype">
                        <option value="unit" ${!isSection ? 'selected' : ''}>Unit (Room)</option>
                        <option value="section" ${isSection ? 'selected' : ''}>Section (Desk Pool)</option>
                    </select>
                </div>
                <div class="property-field">
                    <label>Microsoft Places ID (optional):</label>
                    <input type="text" id="prop-placeid" value="${data.placeId || ''}" placeholder="${isSection ? 'Section PlaceId (not a Desk’s — desks locate via their Section)' : 'Room PlaceId from Get-PlaceV3'}" />
                </div>
            `;
            if (isSection) {
                html += `
                    <div class="property-field">
                        <label class="checkbox-row" for="prop-outline" title="Places paints a section as a solid fill over everything beneath it. As an outline it exports as a narrow frame along its edge, so rooms and desks inside stay visible.">
                            <input type="checkbox" id="prop-outline" ${data.outlineOnly !== false ? 'checked' : ''}>
                            Export as outline only (see-through in Places)
                        </label>
                    </div>
                `;
            }
        } else if (this.fixtures.some(f => f.id === data.id)) {
            // Bookable desks correlate to fixture features — set the Desk's
            // PlaceId here (and category "Desk") to link this shape to it.
            html += `
                <div class="property-field">
                    <label>Microsoft Places ID (optional):</label>
                    <input type="text" id="prop-placeid" value="${data.placeId || ''}" placeholder="Desk PlaceId from Get-PlaceV3" />
                </div>
            `;
        }

        html += `
            <button id="updatePropertiesBtn" class="btn btn-primary" style="width: 100%; margin-top: 10px;">
                Update Properties
            </button>
        `;

        panel.innerHTML = html;

        // Attach update handler
        const updateBtn = document.getElementById('updatePropertiesBtn');
        if (updateBtn) {
            updateBtn.addEventListener('click', () => this.updateSelectedProperties(data));
        }
    }

    updateSelectedProperties(data) {
        const nameInput = document.getElementById('prop-name');
        const categoryInput = document.getElementById('prop-category');
        const placeIdInput = document.getElementById('prop-placeid');
        const featureTypeInput = document.getElementById('prop-featuretype');

        if (nameInput) data.name = nameInput.value;
        if (categoryInput) data.category = categoryInput.value;
        if (placeIdInput) {
            data.placeId = this.extractPlaceId(placeIdInput.value, 'Microsoft Places ID');
            placeIdInput.value = data.placeId || '';
        }
        if (featureTypeInput) data.featureType = featureTypeInput.value;
        const outlineInput = document.getElementById('prop-outline');
        if (outlineInput) data.outlineOnly = outlineInput.checked;
        if (this.units.some(u => u.id === data.id)) this.applyUnitStyle(data);

        const xInput = document.getElementById('prop-x');
        if (xInput && data.fabricObject) {
            const x = parseFloat(xInput.value);
            const y = parseFloat(document.getElementById('prop-y').value);
            const w = parseFloat(document.getElementById('prop-w').value);
            const h = parseFloat(document.getElementById('prop-h').value);
            if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
                // Resize via scale, not width/height: polygon dimensions are
                // derived from their points and must not be set directly.
                const obj = data.fabricObject;
                obj.set({ left: x, top: y, scaleX: w / obj.width, scaleY: h / obj.height });
                obj.setCoords();
                this.canvas.renderAll();
                this.showObjectMetrics(data.fabricObject);
            } else {
                alert('Position/size values must be numbers (width and height above 0) — geometry not changed.');
            }
        }

        alert('Properties updated!');
    }

    deleteSelected() {
        if (!this.selectedObject) {
            alert('No object selected');
            return;
        }

        const data = this.selectedObject.imdfData;
        
        // Remove from canvas
        this.canvas.remove(this.selectedObject);

        // Remove from data arrays
        this.units = this.units.filter(u => u.id !== data.id);
        this.amenities = this.amenities.filter(a => a.id !== data.id);
        this.fixtures = this.fixtures.filter(f => f.id !== data.id);
        this.openings = this.openings.filter(o => o.id !== data.id);

        this.selectedObject = null;
        this.clearSelection();
        this.updateCounts();
    }

    addLevel() {
        const name = document.getElementById('levelName').value || `Level ${this.levels.length}`;
        const ordinal = parseInt(document.getElementById('levelOrdinal').value) || this.levels.length;

        const level = {
            id: this.generateUUID(),
            name: name,
            ordinal: ordinal,
            short_name: ordinal.toString()
        };

        this.levels.push(level);
        this.renderLevelsList();
        this.updateCounts();

        // Auto-select the new level
        this.selectLevel(level);

        // Clear inputs
        document.getElementById('levelName').value = '';
        document.getElementById('levelOrdinal').value = this.levels.length;
    }

    renderLevelsList() {
        const list = document.getElementById('levelsList');
        list.innerHTML = '';

        this.levels.forEach(level => {
            const item = document.createElement('div');
            item.className = 'level-item';
            if (this.currentLevel && this.currentLevel.id === level.id) {
                item.classList.add('active');
            }
            item.innerHTML = `
                <span>${level.name} (${level.ordinal})</span>
                <button class="btn btn-danger btn-sm" onclick="app.removeLevel('${level.id}')">Remove</button>
            `;
            item.addEventListener('click', (e) => {
                if (!e.target.classList.contains('btn')) {
                    this.selectLevel(level);
                }
            });
            list.appendChild(item);
        });
    }

    selectLevel(level) {
        this.currentLevel = level;
        this.renderLevelsList();
        this.updateCanvasInfo(`Current Level: ${level.name}`);
        this.showLevelProperties(level);
    }

    showLevelProperties(level) {
        const panel = document.getElementById('propertiesPanel');
        panel.innerHTML = `
            <div class="property-field">
                <label>Level Name:</label>
                <input type="text" id="level-prop-name" value="${level.name || ''}" />
            </div>
            <div class="property-field">
                <label>Level Number:</label>
                <input type="number" id="level-prop-ordinal" value="${level.ordinal}" />
            </div>
            <div class="property-field">
                <label>Microsoft Places ID (optional):</label>
                <input type="text" id="level-prop-placeid" value="${level.placeId || ''}" placeholder="Floor PlaceId from Get-PlaceV3" />
            </div>
            <p class="hint">The floor's Places SortOrder must match the level number.</p>
            <button id="updateLevelBtn" class="btn btn-primary" style="width: 100%; margin-top: 10px;">
                Update Level
            </button>
        `;
        document.getElementById('updateLevelBtn').addEventListener('click', () => {
            level.name = document.getElementById('level-prop-name').value || level.name;
            const ordinal = parseInt(document.getElementById('level-prop-ordinal').value);
            if (!isNaN(ordinal)) {
                level.ordinal = ordinal;
                level.short_name = ordinal.toString();
            }
            level.placeId = this.extractPlaceId(document.getElementById('level-prop-placeid').value, 'Floor Places ID');
            document.getElementById('level-prop-placeid').value = level.placeId || '';
            this.renderLevelsList();
            this.updateCanvasInfo(`Current Level: ${level.name}`);
            alert('Level updated!');
        });
    }

    removeLevel(levelId) {
        // Remove level
        this.levels = this.levels.filter(l => l.id !== levelId);
        
        // Remove associated items from canvas
        const itemsToRemove = [];
        this.canvas.getObjects().forEach(obj => {
            if (obj.imdfData && obj.imdfData.levelId === levelId) {
                itemsToRemove.push(obj);
            }
        });
        itemsToRemove.forEach(obj => this.canvas.remove(obj));

        // Remove from data arrays
        this.units = this.units.filter(u => u.levelId !== levelId);
        this.amenities = this.amenities.filter(a => a.levelId !== levelId);
        this.fixtures = this.fixtures.filter(f => f.levelId !== levelId);
        this.openings = this.openings.filter(o => o.levelId !== levelId);

        if (this.currentLevel && this.currentLevel.id === levelId) {
            this.currentLevel = null;
        }

        this.renderLevelsList();
        this.updateCounts();
    }

    // Detect the floor plan's structure and add editable shapes: rooms and
    // circulation as clean straightened outlines, the outer wall as the
    // footprint, doorways as openings, and furniture rebuilt shape by shape
    // (desks, chairs, tables, cubicle panels). The detection itself lives in
    // autotrace.js; this turns its result into canvas objects. On a level
    // that already has shapes it can either add only what is missing, or
    // rebuild the level — in which case a room that lines up with an existing
    // one takes over its identity (id, name, category, Places ID), so
    // correlations survive a re-trace.
    autoTraceRooms() {
        if (!this.currentLevel) {
            alert('Please add and select a level first');
            return;
        }
        const bg = this.canvas.backgroundImage;
        if (!bg) {
            alert('Upload a floor plan first — auto-trace scans the background image.');
            return;
        }
        const el = bg.getElement ? bg.getElement() : bg._element;
        const iw = el.naturalWidth || el.width;
        const ih = el.naturalHeight || el.height;
        const result = AutoTrace.trace({
            width: iw,
            height: ih,
            getPixels: (aw, ah) => {
                const off = document.createElement('canvas');
                off.width = aw;
                off.height = ah;
                const ctx = off.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(el, 0, 0, aw, ah);
                return ctx.getImageData(0, 0, aw, ah).data;
            }
        });
        if (!result) {
            alert('No drawing was detected on the floor plan image.');
            return;
        }

        // Map image pixels onto canvas coordinates. The floor plan is drawn
        // centred (originX/Y "center") and scaled.
        const bgScaleX = bg.scaleX || 1;
        const bgScaleY = bg.scaleY || 1;
        const toCanvasX = (imgX) => bg.left - (iw * bgScaleX) / 2 + imgX * bgScaleX;
        const toCanvasY = (imgY) => bg.top - (ih * bgScaleY) / 2 + imgY * bgScaleY;
        const toCanvas = (ring) => ring.map(([x, y]) => ({ x: toCanvasX(x), y: toCanvasY(y) }));
        // Plain boxes become rectangles (easiest to edit); anything else a polygon.
        const shapeFor = (ring, style) => {
            const pts = toCanvas(ring);
            const xs = [...new Set(pts.map(p => p.x))], ys = [...new Set(pts.map(p => p.y))];
            if (pts.length === 4 && xs.length === 2 && ys.length === 2) {
                const left = Math.min(...xs), top = Math.min(...ys);
                return new fabric.Rect({
                    left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top, ...style
                });
            }
            return new fabric.Polygon(pts, { ...style, objectCaching: false });
        };
        const centreOf = (shape) => ({
            x: shape.left + (shape.width * (shape.scaleX || 1)) / 2,
            y: shape.top + (shape.height * (shape.scaleY || 1)) / 2
        });
        const covers = (o, p) => o && o.width !== undefined &&
            p.x >= o.left && p.x <= o.left + o.width * (o.scaleX || 1) &&
            p.y >= o.top && p.y <= o.top + o.height * (o.scaleY || 1);
        const levelId = this.currentLevel.id;

        const onLevel = (item) => item.levelId === levelId;
        const isRoom = (u) => onLevel(u) && u.featureType !== 'section' && u.category !== 'walkway';
        // Drawn by an earlier trace (or by hand, but with nothing tied to
        // it): safe to redraw. Desks and anything correlated are kept.
        const isDecor = (fx) => onLevel(fx) && !fx.placeId && fx.category !== 'desk' &&
            fx.fabricObject && fx.fabricObject.type !== 'line';
        const rebuild = (this.units.some(onLevel) || this.fixtures.some(onLevel)) && confirm(
            'This level already has shapes.\n\n' +
            'OK — rebuild it from the floor plan. A room that lines up with an existing one keeps ' +
            'its name, category and Places ID; walkways, furniture and doorways are redrawn.\n\n' +
            'Cancel — keep everything as it is and only add what is missing.');
        const drop = (list, doomed) => {
            for (const item of list) if (doomed(item) && item.fabricObject) this.canvas.remove(item.fabricObject);
            return list.filter(item => !doomed(item));
        };
        if (rebuild) {
            this.units = drop(this.units, u => onLevel(u) && u.category === 'walkway' && !u.placeId);
            this.fixtures = drop(this.fixtures, isDecor);
            this.openings = drop(this.openings, o => onLevel(o) && o.category === 'door');
            this.canvas.discardActiveObject();
        }

        let rooms = 0, updated = 0;
        const roomStyle = { ...CATEGORY_STYLES.room, strokeWidth: 2 };
        const roomShapes = result.rooms.map(room => shapeFor(room.ring, roomStyle));
        // Rebuilding: pair each new room with the existing room it lines up
        // with (each sits on the other's centre), then clear out what is
        // left of the earlier trace — unpaired rooms still carrying their
        // generated name and no Places ID. Rooms someone named or correlated
        // stay, and still take precedence over a new room on the same spot.
        const twins = new Map();
        if (rebuild) {
            const taken = new Set();
            for (const shape of roomShapes) {
                const centre = centreOf(shape);
                const twin = this.units.find(u => isRoom(u) && !taken.has(u) && u.fabricObject &&
                    covers(u.fabricObject, centre) && covers(shape, centreOf(u.fabricObject)));
                if (twin) { taken.add(twin); twins.set(shape, twin); }
            }
            this.units = drop(this.units, u => isRoom(u) && !taken.has(u) && !u.placeId && /^Room \d+$/.test(u.name || ''));
        }
        for (const shape of roomShapes) {
            const twin = twins.get(shape);
            if (twin) {
                this.canvas.remove(twin.fabricObject);
                shape.set(styleForUnit(twin));
                twin.fabricObject = shape;
                shape.imdfData = twin;
                this.canvas.add(shape);
                updated++;
                continue;
            }
            const centre = centreOf(shape);
            if (this.units.some(u => isRoom(u) && covers(u.fabricObject, centre))) continue;
            const unit = {
                id: this.generateUUID(),
                name: `Room ${this.units.length + 1}`,
                featureType: 'unit',
                category: 'room',
                restriction: null,
                placeId: null,
                levelId,
                fabricObject: shape
            };
            shape.imdfData = unit;
            this.units.push(unit);
            this.canvas.add(shape);
            rooms++;
        }

        this.setBuildingOutline(toCanvas(result.footprint));

        // Circulation: corridors, lobbies and open areas become walkway
        // units, so the whole floor is partitioned into spaces like
        // professionally built Places maps (walls stay visible as the
        // unfilled gaps between units). A region that wraps around a room
        // block is a polygon with holes.
        let walkways = 0;
        const hasWalkway = this.units.some(u => onLevel(u) && u.category === 'walkway');
        if (!hasWalkway) {
            const walkwayStyle = { ...CATEGORY_STYLES.walkway, strokeWidth: 2 };
            for (const wk of result.walkways) {
                const shape = wk.rings.length === 1
                    ? new fabric.Polygon(toCanvas(wk.rings[0]), { ...walkwayStyle, objectCaching: false })
                    : this.pathFromRings(
                        wk.rings.map(ring => ring.map(([x, y]) => [toCanvasX(x), toCanvasY(y)])),
                        walkwayStyle,
                        { type: 'Point', coordinates: [toCanvasX(wk.point[0]) / 100000, toCanvasY(wk.point[1]) / 100000] });
                const unit = {
                    id: this.generateUUID(),
                    name: `Walkway ${walkways + 1}`,
                    featureType: 'unit',
                    category: 'walkway',
                    restriction: null,
                    placeId: null,
                    levelId,
                    fabricObject: shape
                };
                shape.imdfData = unit;
                this.units.push(unit);
                this.canvas.add(shape);
                // Fabric v6 name (sendToBack was removed in v6).
                this.canvas.sendObjectToBack(shape);
                walkways++;
            }
        }

        // Furniture and partitions (wing walls, stall dividers): fixtures,
        // exported as outlined shapes on top of the rooms. Only shapes from
        // earlier runs count as "already drawn" — pieces from this run nest
        // by design (a seat inside its chair).
        let furniture = 0;
        const furnitureStyle = {
            fill: 'rgba(108, 117, 125, 0.35)',
            stroke: '#6c757d',
            strokeWidth: 1
        };
        const earlier = this.fixtures.slice();
        const addFixture = (ring, category, label) => {
            const shape = shapeFor(ring, furnitureStyle);
            const centre = centreOf(shape);
            if (earlier.some(f => covers(f.fabricObject, centre))) return;
            const fixture = {
                id: this.generateUUID(),
                name: `${label} ${this.fixtures.length + 1}`,
                category,
                placeId: null,
                levelId,
                geometryType: 'Polygon',
                fabricObject: shape
            };
            shape.imdfData = fixture;
            this.fixtures.push(fixture);
            this.canvas.add(shape);
            furniture++;
        };
        for (const p of result.partitions) addFixture(p.ring, 'wall', 'Partition');
        for (const p of result.furniture) addFixture(p.ring, 'furniture', 'Furniture');

        // Doorways, as openings on the wall line. Places doesn't import
        // openings, but the 3D export uses them to leave the doorways open.
        let doors = 0;
        for (const d of result.doors) {
            const x1 = toCanvasX(d.x1), y1 = toCanvasY(d.y1), x2 = toCanvasX(d.x2), y2 = toCanvasY(d.y2);
            const reach = Math.hypot(x2 - x1, y2 - y1) / 2;
            const taken = this.openings.some(o => {
                const l = o.fabricObject;
                return l && Math.hypot((l.x1 + l.x2) / 2 - (x1 + x2) / 2, (l.y1 + l.y2) / 2 - (y1 + y2) / 2) < reach;
            });
            if (taken) continue;
            const line = new fabric.Line([x1, y1, x2, y2], { stroke: '#dc3545', strokeWidth: 3 });
            const opening = {
                id: this.generateUUID(),
                category: 'door',
                levelId,
                fabricObject: line
            };
            line.imdfData = opening;
            this.openings.push(opening);
            this.canvas.add(line);
            doors++;
        }

        // Whatever was kept from before (desks, sections) belongs on top of
        // the redrawn rooms.
        if (rebuild) {
            for (const item of [...this.units.filter(u => onLevel(u) && u.featureType === 'section'),
                                ...this.fixtures.filter(fx => onLevel(fx) && !isDecor(fx))]) {
                if (item.fabricObject) this.canvas.bringObjectToFront(item.fabricObject);
            }
        }

        this.canvas.renderAll();
        this.updateCounts();
        if (rooms === 0 && updated === 0 && furniture === 0 && walkways === 0) {
            alert('No enclosed rooms were detected. Rooms already covered by existing boxes are left alone; otherwise try drawing manually.');
        } else {
            alert(`Auto-trace added ${rooms} room(s)` +
                  (updated ? `, redrew ${updated} existing room(s) in place` : '') +
                  (walkways ? `, ${walkways} walkway area(s) covering the circulation space` : '') +
                  (furniture ? `, ${furniture} furniture piece(s)` : '') +
                  (doors ? `, ${doors} doorway(s)` : '') +
                  ', and the building outline (exported as the footprint)' +
                  '. Move, resize, rename, or delete any shape afterwards — set each room’s category so Places tints it correctly.');
        }
    }

    // The traced outer wall, drawn as a locked outline and exported as the
    // building footprint. Stored as canvas-pixel points on this.buildingOutline.
    setBuildingOutline(points) {
        if (this.buildingOutlineObject) this.canvas.remove(this.buildingOutlineObject);
        this.buildingOutline = points;
        const poly = new fabric.Polygon(points, {
            fill: 'rgba(0, 0, 0, 0)',
            stroke: '#212529',
            strokeWidth: 3,
            selectable: false,
            evented: false,
            objectCaching: false
        });
        this.buildingOutlineObject = poly;
        this.canvas.add(poly);
        this.canvas.sendObjectToBack(poly);
    }

    async uploadFloorplan() {
        const fileInput = document.getElementById('floorplanUpload');
        const file = fileInput.files[0];
        
        if (!file) {
            alert('Please select a file first');
            return;
        }

        const formData = new FormData();
        formData.append('floorplan', file);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            const result = await this.parseJsonResponse(response);

            if (response.ok && result.success) {
                this.floorplanImage = result.path;
                await this.loadFloorplanToCanvas(result.path);
                alert('Floor plan uploaded successfully!');
            } else {
                alert('Upload failed: ' + (result.error || `HTTP ${response.status}`));
            }
        } catch (error) {
            alert('Upload error: ' + error.message);
        }
    }

    // Parse a fetch response as JSON, tolerating a non-JSON body (e.g. an HTML error
    // page from a proxy or a crashed server) instead of throwing the confusing
    // "JSON.parse: unexpected character" error users reported in issue #4.
    async parseJsonResponse(response) {
        const text = await response.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            return { error: `Server returned a non-JSON response (HTTP ${response.status})` };
        }
    }

    async loadFloorplanToCanvas(imageUrl) {
        // A PDF can't be drawn as an <img>; rasterize its first page first (issue #4).
        const isPdf = /\.pdf($|\?)/i.test(imageUrl);
        const sourceUrl = isPdf ? await this.renderPdfToDataUrl(imageUrl) : imageUrl;

        // Fabric v6 returns a Promise from fromURL (the old callback form is gone).
        const img = await fabric.Image.fromURL(sourceUrl);
        if (!img) {
            throw new Error('Failed to load floor plan image');
        }

        // Scale image to fit canvas
        const scale = Math.min(
            this.canvas.width / img.width,
            this.canvas.height / img.height
        ) * 0.9;

        img.scale(scale);
        img.set({
            left: this.canvas.width / 2,
            top: this.canvas.height / 2,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false
        });

        // Fabric v6: backgroundImage is a property; setBackgroundImage() was removed.
        this.canvas.backgroundImage = img;
        this.canvas.renderAll();
    }

    async renderPdfToDataUrl(pdfUrl) {
        if (!window.pdfjsLib) {
            throw new Error('PDF support failed to load. Please refresh and try again.');
        }
        const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
        const page = await pdf.getPage(1); // first page becomes the floor plan
        // Render at 2x so the background stays crisp when zoomed in.
        const viewport = page.getViewport({ scale: 2 });
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = viewport.width;
        tmpCanvas.height = viewport.height;
        await page.render({ canvasContext: tmpCanvas.getContext('2d'), viewport }).promise;
        return tmpCanvas.toDataURL('image/png');
    }

    zoomIn() {
        this.zoomBy(1.1);
    }

    zoomOut() {
        this.zoomBy(1 / 1.1);
    }

    // Zoom about the middle of the view, so what is centred stays centred
    // (setZoom zooms about the top-left corner and walks the plan away).
    zoomBy(factor) {
        const zoom = Math.min(20, Math.max(0.1, this.canvas.getZoom() * factor));
        const centre = new fabric.Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2);
        this.canvas.zoomToPoint(centre, zoom);
        this.canvas.renderAll();
    }

    resetView() {
        this.canvas.setZoom(1);
        this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
        this.canvas.renderAll();
    }

    // Single source of truth for the project payload used by save and export.
    // Building/footprint ids are minted once and persisted so every export
    // reuses them — a filled-in Places correlations CSV stays valid.
    collectProjectData() {
        const projectName = document.getElementById('projectName').value || 'Untitled Project';
        this.buildingId = this.buildingId || this.generateUUID();
        this.footprintId = this.footprintId || this.generateUUID();

        const buildingPlaceIdInput = document.getElementById('buildingPlaceId');
        const buildingPlaceId = this.extractPlaceId(buildingPlaceIdInput.value, 'Building Places ID');
        buildingPlaceIdInput.value = buildingPlaceId || '';

        return {
            projectName: projectName,
            venue: {
                name: projectName,
                coordinates: this.parseCoordinates(document.getElementById('venueCoords').value)
            },
            building: {
                id: this.buildingId,
                footprintId: this.footprintId,
                name: document.getElementById('buildingName').value || 'Building',
                placeId: buildingPlaceId,
                widthMeters: parseFloat(document.getElementById('buildingWidth').value) || null,
                coordinates: this.getBuildingCoordinates(),
                // Traced outer wall (canvas px / 100000, one ring) — the server
                // uses it as the real footprint/level outline when present.
                outline: this.buildingOutline
                    ? [this.buildingOutline.map(p => [p.x / 100000, p.y / 100000])]
                    : null
            },
            levels: this.levels.map(l => ({
                id: l.id,
                name: l.name,
                ordinal: l.ordinal,
                short_name: l.short_name,
                placeId: l.placeId || null,
                coordinates: this.getLevelCoordinates()
            })),
            units: this.units.map(u => ({
                id: u.id,
                name: u.name,
                featureType: u.featureType || 'unit',
                category: u.category,
                restriction: u.restriction,
                placeId: u.placeId || null,
                outlineOnly: u.outlineOnly !== false,
                levelId: u.levelId,
                coordinates: this.getObjectCoordinates(u.fabricObject),
                display_point: this.getDisplayPoint(u.fabricObject)
            })),
            amenities: this.amenities.map(a => ({
                id: a.id,
                name: a.name,
                category: a.category,
                levelId: a.levelId,
                coordinates: this.getPointCoordinates(a.fabricObject)
            })),
            fixtures: this.fixtures.map(f => {
                const isLine = f.fabricObject && f.fabricObject.type === 'line';
                return {
                    id: f.id,
                    name: f.name || null,
                    category: f.category,
                    placeId: f.placeId || null,
                    levelId: f.levelId,
                    // Places' desk icon can be oriented via the documented
                    // "rotation" fixture extension — taken from the shape's
                    // rotation handle.
                    rotation: !isLine && f.fabricObject && Math.round(f.fabricObject.angle || 0) !== 0
                        ? Math.round(f.fabricObject.angle) : null,
                    geometryType: isLine ? 'LineString' : 'Polygon',
                    coordinates: isLine
                        ? this.getLineCoordinates(f.fabricObject)
                        : this.getObjectCoordinates(f.fabricObject)
                };
            }),
            openings: this.openings.map(o => ({
                id: o.id,
                category: o.category,
                levelId: o.levelId,
                coordinates: this.getLineCoordinates(o.fabricObject)
            })),
            options: {
                effect3d: document.getElementById('effect3d').checked,
                wallHeightMeters: parseFloat(document.getElementById('wallHeight').value) || null
            }
        };
    }

    async saveProject() {
        const projectData = this.collectProjectData();
        const projectName = projectData.projectName;
        projectData.floorplanImage = this.floorplanImage;
        projectData.createdAt = new Date().toISOString();

        try {
            const response = await fetch('/api/projects/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: this.projectId,
                    projectName: projectName,
                    projectData: projectData
                })
            });

            const result = await response.json();
            
            if (result.success) {
                this.projectId = result.projectId;
                alert('Project saved successfully!');
            } else {
                alert('Save failed: ' + result.error);
            }
        } catch (error) {
            alert('Save error: ' + error.message);
        }
    }

    async showLoadProjectModal() {
        try {
            const response = await fetch('/api/projects');
            const projects = await response.json();

            const list = document.getElementById('projectsList');
            list.innerHTML = '';

            if (projects.length === 0) {
                list.innerHTML = '<p>No saved projects found.</p>';
            } else {
                projects.forEach(project => {
                    const item = document.createElement('div');
                    item.className = 'project-item';
                    item.innerHTML = `
                        <h3>${project.name}</h3>
                        <p>Updated: ${new Date(project.updatedAt).toLocaleString()}</p>
                    `;
                    item.addEventListener('click', () => this.loadProject(project.id));
                    list.appendChild(item);
                });
            }

            document.getElementById('loadProjectModal').style.display = 'block';
        } catch (error) {
            alert('Error loading projects: ' + error.message);
        }
    }

    async loadProject(projectId) {
        try {
            const response = await fetch(`/api/projects/${projectId}`);
            const project = await response.json();

            // Clear current state
            this.canvas.clear();
            this.levels = [];
            this.units = [];
            this.amenities = [];
            this.fixtures = [];
            this.openings = [];
            this.currentLevel = null;

            // Load project data
            this.projectId = project.id;
            document.getElementById('projectName').value = project.name;
            
            const data = project.data;
            
            if (data.venue) {
                document.getElementById('venueCoords').value = data.venue.coordinates.join(', ');
            }
            
            if (data.building) {
                document.getElementById('buildingName').value = data.building.name;
                document.getElementById('buildingPlaceId').value = data.building.placeId || '';
                document.getElementById('buildingWidth').value = data.building.widthMeters || 50;
                this.buildingId = data.building.id || null;
                this.footprintId = data.building.footprintId || null;
            }

            const options = data.options || {};
            document.getElementById('effect3d').checked = !!options.effect3d;
            document.getElementById('wallHeight').value = options.wallHeightMeters || 0.35;
            document.getElementById('wallHeightGroup').style.display = options.effect3d ? '' : 'none';

            // Load floor plan if exists
            if (data.floorplanImage) {
                this.floorplanImage = data.floorplanImage;
                await this.loadFloorplanToCanvas(data.floorplanImage);
            }

            // Load levels
            if (data.levels) {
                this.levels = data.levels;
                this.renderLevelsList();
                if (this.levels.length > 0) {
                    this.selectLevel(this.levels[0]);
                }
            }

            // Load units
            if (data.units) {
                data.units.forEach(unitData => {
                    const shape = this.shapeFromSavedCoordinates(unitData.coordinates, {
                        ...styleForUnit(unitData)
                    }, unitData.display_point);
                    unitData.fabricObject = shape;
                    shape.imdfData = unitData;
                    this.units.push(unitData);
                    this.canvas.add(shape);
                });
            }

            // Restore the traced building outline
            this.buildingOutlineObject = null;
            this.buildingOutline = null;
            const outlineRing = data.building && data.building.outline && data.building.outline[0];
            if (Array.isArray(outlineRing) && outlineRing.length >= 3) {
                this.setBuildingOutline(outlineRing.map(p => ({ x: p[0] * 100000, y: p[1] * 100000 })));
            }

            // Load amenities
            if (data.amenities) {
                data.amenities.forEach(amenityData => {
                    const pt = Array.isArray(amenityData.coordinates) ? amenityData.coordinates : [0.002, 0.002];
                    const circle = new fabric.Circle({
                        left: pt[0] * 100000,
                        top: pt[1] * 100000,
                        radius: 15,
                        fill: 'rgba(40, 167, 69, 0.5)',
                        stroke: '#28a745',
                        strokeWidth: 2
                    });
                    amenityData.fabricObject = circle;
                    circle.imdfData = amenityData;
                    this.amenities.push(amenityData);
                    this.canvas.add(circle);
                });
            }

            // Load fixtures and openings — previously dropped on load, which
            // silently deleted them from the project on the next save.
            if (data.fixtures) {
                data.fixtures.forEach(fixtureData => {
                    const shape = fixtureData.geometryType === 'Polygon'
                        ? this.shapeFromSavedCoordinates(fixtureData.coordinates, {
                            fill: 'rgba(108, 117, 125, 0.35)', stroke: '#6c757d', strokeWidth: 1
                        })
                        : this.lineFromSavedCoordinates(fixtureData.coordinates, { stroke: '#6c757d', strokeWidth: 3 });
                    fixtureData.fabricObject = shape;
                    shape.imdfData = fixtureData;
                    this.fixtures.push(fixtureData);
                    this.canvas.add(shape);
                });
            }
            if (data.openings) {
                data.openings.forEach(openingData => {
                    const line = this.lineFromSavedCoordinates(openingData.coordinates, { stroke: '#dc3545', strokeWidth: 4 });
                    openingData.fabricObject = line;
                    line.imdfData = openingData;
                    this.openings.push(openingData);
                    this.canvas.add(line);
                });
            }

            this.updateCounts();
            document.getElementById('loadProjectModal').style.display = 'none';
            alert('Project loaded successfully!');
        } catch (error) {
            alert('Error loading project: ' + error.message);
        }
    }

    newProject() {
        if (confirm('Start a new project? Any unsaved changes will be lost.')) {
            this.canvas.clear();
            this.levels = [];
            this.units = [];
            this.amenities = [];
            this.fixtures = [];
            this.openings = [];
            this.currentLevel = null;
            this.projectId = null;
            this.floorplanImage = null;
            this.buildingId = null;
            this.footprintId = null;
            this.buildingOutline = null;
            this.buildingOutlineObject = null;

            document.getElementById('projectName').value = '';
            document.getElementById('buildingName').value = '';
            document.getElementById('buildingPlaceId').value = '';
            document.getElementById('buildingWidth').value = 50;
            document.getElementById('venueCoords').value = '0, 0';
            document.getElementById('effect3d').checked = false;
            document.getElementById('wallHeight').value = 0.35;
            document.getElementById('wallHeightGroup').style.display = 'none';
            
            this.renderLevelsList();
            this.updateCounts();
            this.clearSelection();
        }
    }

    async exportIMDF() {
        const projectData = this.collectProjectData();

        try {
            const response = await fetch('/api/generate-imdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectData })
            });

            if (!response.ok) {
                const result = await this.parseJsonResponse(response);
                alert('Export failed: ' + (result.error || `HTTP ${response.status}`));
                return;
            }
            this.downloadBlob(await response.blob(), 'imdf-export.zip');

            // Companion correlations CSV for Import-MapCorrelations, pre-filled
            // with this export's feature ids and any Places IDs entered above.
            const csvResponse = await fetch('/api/generate-mapfeatures', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectData })
            });
            if (csvResponse.ok) {
                this.downloadBlob(await csvResponse.blob(), 'mapfeatures.csv');
            }

            alert('IMDF files exported successfully!');
        } catch (error) {
            alert('Export error: ' + error.message);
        }
    }

    // Draw the export the way Microsoft Places does, so the map can be judged
    // (and the 3D effect tried) without waiting out an import. Places styles
    // by feature type, not per shape: units get one fill and a thin outline,
    // walkways a near-white fill and no outline, the footprint a heavier
    // outline, and later features are painted over earlier ones.
    async previewPlaces() {
        const projectData = this.collectProjectData();
        let files;
        try {
            const response = await fetch('/api/preview-imdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectData })
            });
            const result = await this.parseJsonResponse(response);
            if (!response.ok) {
                alert('Preview failed: ' + (result.error || `HTTP ${response.status}`));
                return;
            }
            files = result.files;
        } catch (error) {
            alert('Preview error: ' + error.message);
            return;
        }

        document.getElementById('previewModal').style.display = 'block';
        const canvas = document.getElementById('previewCanvas');
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
        canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));

        const levelId = this.currentLevel ? this.currentLevel.id : null;
        const onLevel = f => !levelId || !f.properties.level_id || f.properties.level_id === levelId;
        const footprint = files['footprint.geojson'].features[0].geometry.coordinates;
        const units = files['unit.geojson'].features.filter(onLevel);
        const desks = (files['fixture.geojson'] ? files['fixture.geojson'].features : []).filter(onLevel);
        const sections = (files['section.geojson'] ? files['section.geojson'].features : []).filter(onLevel);

        // Fit the footprint, with longitude squeezed by cos(latitude).
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const [lon, lat] of footprint[0]) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
        const squeeze = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180) || 1;
        const spanX = Math.max((maxLon - minLon) * squeeze, 1e-12), spanY = Math.max(maxLat - minLat, 1e-12);
        const fit = Math.min(canvas.width / spanX, canvas.height / spanY) * 0.92;
        const view = { zoom: 1, panX: 0, panY: 0 };
        const px = ([lon, lat]) => [
            canvas.width / 2 + view.panX + ((lon - (minLon + maxLon) / 2) * squeeze) * fit * view.zoom,
            canvas.height / 2 + view.panY - (lat - (minLat + maxLat) / 2) * fit * view.zoom
        ];

        const ctx = canvas.getContext('2d');
        const trace = (rings) => {
            ctx.beginPath();
            for (const ring of rings) {
                ring.forEach((pt, i) => {
                    const [x, y] = px(pt);
                    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
                });
                ctx.closePath();
            }
        };
        const draw = () => {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.lineJoin = 'round';
            trace(footprint);
            ctx.strokeStyle = '#99a0c3';
            ctx.lineWidth = 3 * ratio;
            ctx.stroke();
            ctx.lineWidth = ratio;
            for (const unit of units) {
                trace(unit.geometry.coordinates);
                if (unit.properties.category === 'walkway') {
                    ctx.fillStyle = '#fbfbfd';
                    ctx.fill();
                } else {
                    ctx.fillStyle = '#ebedf6';
                    ctx.fill();
                    ctx.stroke();
                }
            }
            // Sections: a solid fill on top of the units, no border.
            for (const section of sections) {
                trace(section.geometry.coordinates);
                ctx.fillStyle = '#ebedf6';
                ctx.fill();
            }
            // Places replaces a desk's geometry with its own icon.
            for (const desk of desks) {
                const ring = desk.geometry.coordinates[0];
                const centre = px([
                    ring.reduce((sum, p) => sum + p[0], 0) / ring.length,
                    ring.reduce((sum, p) => sum + p[1], 0) / ring.length
                ]);
                ctx.beginPath();
                ctx.arc(centre[0], centre[1], 5 * ratio, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
                ctx.strokeStyle = '#2f9e44';
                ctx.lineWidth = 2 * ratio;
                ctx.stroke();
                ctx.strokeStyle = '#99a0c3';
                ctx.lineWidth = ratio;
            }
        };
        draw();

        canvas.onwheel = (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const cx = (e.clientX - rect.left) * ratio - canvas.width / 2;
            const cy = (e.clientY - rect.top) * ratio - canvas.height / 2;
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const zoom = Math.min(40, Math.max(0.5, view.zoom * factor));
            view.panX = cx - (cx - view.panX) * (zoom / view.zoom);
            view.panY = cy - (cy - view.panY) * (zoom / view.zoom);
            view.zoom = zoom;
            draw();
        };
        let drag = null;
        canvas.onmousedown = (e) => { drag = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY }; };
        canvas.onmousemove = (e) => {
            if (!drag) return;
            view.panX = drag.panX + (e.clientX - drag.x) * ratio;
            view.panY = drag.panY + (e.clientY - drag.y) * ratio;
            draw();
        };
        canvas.onmouseup = canvas.onmouseleave = () => { drag = null; };
    }

    downloadBlob(blob, filename) {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    }

    // Saved shapes store canvas pixels / 100000 (see getObjectCoordinates and
    // friends); scale them back up so loading a project restores positions
    // instead of piling everything at a default spot.
    rectFromSavedCoordinates(coordinates, options) {
        let left = 100, top = 100, width = 100, height = 100;
        const ring = Array.isArray(coordinates) && coordinates[0];
        if (ring && ring.length >= 4) {
            const xs = ring.map(p => p[0] * 100000);
            const ys = ring.map(p => p[1] * 100000);
            left = Math.min(...xs);
            top = Math.min(...ys);
            width = Math.max(...xs) - left;
            height = Math.max(...ys) - top;
        }
        return new fabric.Rect({ left, top, width, height, strokeWidth: 2, ...options });
    }

    // A walkway that surrounds rooms is a polygon with holes (outer ring +
    // one hole ring per enclosed block). Fabric polygons are single-ring, so
    // holed shapes render as a locked Path (evenodd fill leaves the holes
    // open) and export the exact rings they were created with.
    pathFromRings(canvasRings, options, displayPoint) {
        const pathStr = canvasRings.map(ring =>
            'M ' + ring.map(p => `${p[0]} ${p[1]}`).join(' L ') + ' Z').join(' ');
        const shape = new fabric.Path(pathStr, {
            strokeWidth: 2,
            ...options,
            fillRule: 'evenodd',
            objectCaching: false,
            hasControls: false,
            lockMovementX: true,
            lockMovementY: true,
            hoverCursor: 'pointer',
            perPixelTargetFind: true
        });
        // Geometry is locked, so the creation-time rings stay authoritative.
        const closeRing = ring => {
            const first = ring[0], last = ring[ring.length - 1];
            return (first[0] === last[0] && first[1] === last[1]) ? ring : [...ring, [first[0], first[1]]];
        };
        shape.imdfFixedRings = canvasRings.map(ring => closeRing(ring.map(p => [p[0] / 100000, p[1] / 100000])));
        if (displayPoint && Array.isArray(displayPoint.coordinates)) {
            shape.imdfDisplayPoint = displayPoint.coordinates;
        }
        return shape;
    }

    // Axis-aligned 4-corner rings come back as rectangles (easy to edit);
    // anything else — traced corridors, L-shaped rooms — as a polygon.
    // Multi-ring coordinates (a shape with holes) become a locked Path.
    shapeFromSavedCoordinates(coordinates, options, displayPoint) {
        if (Array.isArray(coordinates) && coordinates.length > 1) {
            const canvasRings = coordinates.map(ring => ring.map(p => [p[0] * 100000, p[1] * 100000]));
            return this.pathFromRings(canvasRings, options, displayPoint);
        }
        const ring = Array.isArray(coordinates) && coordinates[0];
        if (ring && ring.length > 3) {
            const xs = new Set(ring.map(p => p[0]));
            const ys = new Set(ring.map(p => p[1]));
            const isBox = ring.length <= 5 && xs.size <= 2 && ys.size <= 2;
            if (!isBox) {
                const points = ring.slice(0, ring.length - 1)
                    .map(p => ({ x: p[0] * 100000, y: p[1] * 100000 }));
                return new fabric.Polygon(points, { strokeWidth: 2, objectCaching: false, ...options });
            }
        }
        return this.rectFromSavedCoordinates(coordinates, options);
    }

    lineFromSavedCoordinates(coordinates, options) {
        const pts = Array.isArray(coordinates) && coordinates.length >= 2
            ? coordinates
            : [[0.001, 0.001], [0.0015, 0.001]];
        return new fabric.Line(
            [pts[0][0] * 100000, pts[0][1] * 100000, pts[1][0] * 100000, pts[1][1] * 100000],
            options
        );
    }

    // Users paste PlaceIds straight out of Get-PlaceV3 table output, often with
    // neighbouring columns attached ("<guid> Desk"). Keep just the GUID; anything
    // without exactly one GUID is rejected loudly rather than saved corrupted.
    extractPlaceId(value, label) {
        const trimmed = (value || '').trim();
        if (!trimmed) return null;
        const guids = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
        if (guids.length !== 1) {
            alert(`${label}: "${trimmed}" doesn't contain exactly one PlaceId GUID (like 7b52c3f3-6700-4c58-89cc-e7934bfab853). The value was not saved.`);
            return null;
        }
        return guids[0].toLowerCase();
    }

    // Helper methods
    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    parseCoordinates(str) {
        const parts = str.split(',').map(s => parseFloat(s.trim()));
        return parts.length === 2 ? parts : [0, 0];
    }

    getBuildingCoordinates() {
        // Return a simple polygon for the building footprint
        return [[[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]]];
    }

    getLevelCoordinates() {
        // Return a simple polygon for the level
        return [[[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]]];
    }

    getObjectCoordinates(obj) {
        // Convert fabric object to polygon coordinates
        if (!obj) return [[[0, 0], [0, 0.0001], [0.0001, 0.0001], [0.0001, 0], [0, 0]]];

        // Holed shapes (walkways around rooms) are movement-locked Paths that
        // keep their creation-time rings.
        if (obj.imdfFixedRings) return obj.imdfFixedRings;

        if (obj.type === 'polygon') {
            const m = obj.calcTransformMatrix();
            const ring = obj.points.map(p => {
                const x = p.x - obj.pathOffset.x;
                const y = p.y - obj.pathOffset.y;
                return [
                    (m[0] * x + m[2] * y + m[4]) / 100000,
                    (m[1] * x + m[3] * y + m[5]) / 100000
                ];
            });
            ring.push([ring[0][0], ring[0][1]]);
            return [ring];
        }

        const left = obj.left / 100000;
        const top = obj.top / 100000;
        const width = (obj.width * obj.scaleX) / 100000;
        const height = (obj.height * obj.scaleY) / 100000;

        return [[
            [left, top],
            [left, top + height],
            [left + width, top + height],
            [left + width, top],
            [left, top]
        ]];
    }

    getDisplayPoint(obj) {
        if (!obj) return { type: 'Point', coordinates: [0, 0] };

        // Holed shapes carry a precomputed point known to lie inside the
        // shape (the bbox centre / centroid can fall inside a hole).
        if (obj.imdfDisplayPoint) {
            return { type: 'Point', coordinates: obj.imdfDisplayPoint };
        }

        // For traced polygons (L-shapes, corridors) the bounding-box centre
        // can fall outside the room — use the area centroid instead.
        if (obj.type === 'polygon') {
            const ring = this.getObjectCoordinates(obj)[0];
            let area = 0, cx = 0, cy = 0;
            for (let i = 0; i < ring.length - 1; i++) {
                const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
                area += cross;
                cx += (ring[i][0] + ring[i + 1][0]) * cross;
                cy += (ring[i][1] + ring[i + 1][1]) * cross;
            }
            if (Math.abs(area) > 1e-12) {
                return { type: 'Point', coordinates: [cx / (3 * area), cy / (3 * area)] };
            }
        }

        return {
            type: 'Point',
            coordinates: [
                (obj.left + (obj.width * obj.scaleX) / 2) / 100000,
                (obj.top + (obj.height * obj.scaleY) / 2) / 100000
            ]
        };
    }

    getPointCoordinates(obj) {
        if (!obj) return [0, 0];
        return [obj.left / 100000, obj.top / 100000];
    }

    getLineCoordinates(obj) {
        if (!obj) return [[0, 0], [0, 0.0001]];
        return [
            [obj.x1 / 100000, obj.y1 / 100000],
            [obj.x2 / 100000, obj.y2 / 100000]
        ];
    }

    updateCounts() {
        const sections = this.units.filter(u => u.featureType === 'section').length;
        document.getElementById('levelCount').textContent = this.levels.length;
        document.getElementById('unitCount').textContent = this.units.length - sections;
        document.getElementById('sectionCount').textContent = sections;
        document.getElementById('amenityCount').textContent = this.amenities.length;
        document.getElementById('fixtureCount').textContent = this.fixtures.length;
        document.getElementById('openingCount').textContent = this.openings.length;
    }

    updateCanvasInfo(text) {
        document.getElementById('canvasInfo').textContent = text;
    }
}

// Initialize the application
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new IMDFBuilder();
});
