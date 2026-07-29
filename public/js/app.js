// IMDF Builder Application

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
            selection: true
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
        this.canvas.on('mouse:down', (e) => this.handleCanvasClick(e));

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
            fill: 'rgba(0, 120, 212, 0.3)',
            stroke: '#0078d4',
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
            fill: 'rgba(255, 140, 0, 0.3)',
            stroke: '#ff8c00',
            strokeWidth: 2
        });

        const section = {
            id: this.generateUUID(),
            name: `Section ${this.units.filter(u => u.featureType === 'section').length + 1}`,
            featureType: 'section',
            category: 'unspecified',
            restriction: null,
            placeId: null,
            levelId: this.currentLevel.id,
            fabricObject: rect
        };

        rect.imdfData = section;
        this.units.push(section);
        this.canvas.add(rect);
        this.updateCounts();
    }

    applyFeatureTypeStyle(fabricObject, featureType) {
        if (!fabricObject) return;
        const isSection = featureType === 'section';
        fabricObject.set({
            fill: isSection ? 'rgba(255, 140, 0, 0.3)' : 'rgba(0, 120, 212, 0.3)',
            stroke: isSection ? '#ff8c00' : '#0078d4'
        });
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
                        <option value="room" ${data.category === 'room' ? 'selected' : ''}>Room</option>
                        <option value="office" ${data.category === 'office' ? 'selected' : ''}>Office</option>
                        <option value="conference" ${data.category === 'conference' ? 'selected' : ''}>Conference Room</option>
                        <option value="seating" ${data.category === 'seating' ? 'selected' : ''}>Seating</option>
                        <option value="restroom" ${data.category === 'restroom' ? 'selected' : ''}>Restroom</option>
                        <option value="elevator" ${data.category === 'elevator' ? 'selected' : ''}>Elevator</option>
                        <option value="stairs" ${data.category === 'stairs' ? 'selected' : ''}>Stairs</option>
                        <option value="wall" ${data.category === 'wall' ? 'selected' : ''}>Wall</option>
                        <option value="furniture" ${data.category === 'furniture' ? 'selected' : ''}>Furniture</option>
                        <option value="door" ${data.category === 'door' ? 'selected' : ''}>Door</option>
                        <option value="unspecified" ${data.category === 'unspecified' ? 'selected' : ''}>Unspecified</option>
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
        if (featureTypeInput && featureTypeInput.value !== (data.featureType || 'unit')) {
            data.featureType = featureTypeInput.value;
            this.applyFeatureTypeStyle(data.fabricObject, data.featureType);
        }

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

    // Detect enclosed rooms on the uploaded floor plan and add an editable
    // shape for each. Pure pixel work: binarize, seal door openings, flood
    // away everything connected to the image border, then take each remaining
    // open region as a room. Rectangular rooms become boxes; corridors and
    // L-shaped rooms become polygons that follow the walls. The building's
    // outer wall is traced into a footprint outline, and free-standing ink
    // clusters inside the building (desks, tables, chairs) become furniture
    // fixtures so the exported map reads like the original plan.
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
        const maxDim = 900;
        const s = Math.min(1, maxDim / Math.max(iw, ih));
        const w = Math.max(1, Math.round(iw * s));
        const h = Math.max(1, Math.round(ih * s));

        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const ctx = off.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(el, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;

        // 1 = open space (light or transparent), 0 = ink (walls, lines).
        // Thin lines are kept on purpose: door swing arcs are thin, and they
        // are what seals a doorway once the ink is dilated below.
        let open = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const lum = px[i * 4 + 3] < 40
                ? 255
                : 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
            open[i] = lum > 180 ? 1 : 0;
        }

        // Untouched copy of the binarized image: room regrowth (below) must
        // stop at real wall pixels, and furniture detection reads real ink.
        const openOrig = new Uint8Array(open);

        // Label every connected ink blob. The largest is the outer wall — its
        // bounding box bounds the building, so dashed construction marks,
        // title text and dimension lines outside it get filtered away. The
        // small free-standing blobs inside are furniture candidates.
        const inkComp = new Int32Array(w * h);
        const comps = [];
        const inkStack = [];
        let bounds = null;
        for (let start = 0; start < w * h; start++) {
            if (open[start] || inkComp[start]) continue;
            const id = comps.length + 1;
            const c = { id, minX: w, minY: h, maxX: 0, maxY: 0, count: 0 };
            inkStack.push(start);
            while (inkStack.length) {
                const i = inkStack.pop();
                if (i < 0 || i >= w * h || inkComp[i] || open[i]) continue;
                inkComp[i] = id;
                c.count++;
                const x = i % w, y = (i / w) | 0;
                if (x < c.minX) c.minX = x;
                if (x > c.maxX) c.maxX = x;
                if (y < c.minY) c.minY = y;
                if (y > c.maxY) c.maxY = y;
                if (x > 0) inkStack.push(i - 1);
                if (x < w - 1) inkStack.push(i + 1);
                inkStack.push(i - w, i + w);
            }
            comps.push(c);
            if (!bounds || c.count > bounds.count) bounds = c;
        }

        // Dilate the ink to seal door openings (door leaf + swing arc close
        // the gap once thickened). Boxes are grown back by the same amount.
        const sealRadius = Math.max(2, Math.round(Math.max(w, h) / 300));
        for (let pass = 0; pass < sealRadius; pass++) {
            const eroded = new Uint8Array(open);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = y * w + x;
                    if (open[i] && (
                        (x > 0 && !open[i - 1]) || (x < w - 1 && !open[i + 1]) ||
                        (y > 0 && !open[i - w]) || (y < h - 1 && !open[i + w]))) {
                        eroded[i] = 0;
                    }
                }
            }
            open = eroded;
        }

        // Flood from the borders: everything reachable is outside the building.
        const label = new Int32Array(w * h);
        const stack = [];
        for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
        for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
        const flood = (seedLabel, collect) => {
            let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
            while (stack.length) {
                const i = stack.pop();
                if (i < 0 || i >= w * h || label[i] !== 0 || !open[i]) continue;
                label[i] = seedLabel;
                count++;
                const x = i % w;
                if (collect) {
                    const y = (i / w) | 0;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
                if (x > 0) stack.push(i - 1);
                if (x < w - 1) stack.push(i + 1);
                stack.push(i - w, i + w);
            }
            return { minX, minY, maxX, maxY, count };
        };
        flood(-1, false);

        // Remaining open regions are enclosed spaces: room candidates.
        const regions = [];
        let nextLabel = 1;
        for (let start = 0; start < w * h; start++) {
            if (label[start] === 0 && open[start]) {
                stack.push(start);
                const r = flood(nextLabel, true);
                r.label = nextLabel;
                regions.push(r);
                nextLabel++;
            }
        }

        // Grow each room back through the sealed band so traced outlines sit
        // on the walls instead of a seal-radius short of them. Growth only
        // claims pixels that were open before sealing, so it hard-stops at
        // real wall ink; in a doorway the band is split between the two
        // rooms that meet there.
        for (let pass = 0; pass < sealRadius; pass++) {
            const adopted = [];
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = y * w + x;
                    if (label[i] !== 0 || !openOrig[i] || open[i]) continue;
                    const near =
                        (x > 0 && label[i - 1] > 0 && label[i - 1]) ||
                        (x < w - 1 && label[i + 1] > 0 && label[i + 1]) ||
                        (y > 0 && label[i - w] > 0 && label[i - w]) ||
                        (y < h - 1 && label[i + w] > 0 && label[i + w]) || 0;
                    if (near) adopted.push(i, near);
                }
            }
            for (let k = 0; k < adopted.length; k += 2) {
                const i = adopted[k], lab = adopted[k + 1];
                label[i] = lab;
                const r = regions[lab - 1];
                const x = i % w, y = (i / w) | 0;
                r.count++;
                if (x < r.minX) r.minX = x;
                if (x > r.maxX) r.maxX = x;
                if (y < r.minY) r.minY = y;
                if (y > r.maxY) r.maxY = y;
            }
        }

        // Map detected image pixels back onto canvas coordinates. The floor
        // plan is drawn centred (originX/Y "center") and scaled.
        const bgScaleX = bg.scaleX || 1;
        const bgScaleY = bg.scaleY || 1;
        const toCanvasX = (imgX) => bg.left - (iw * bgScaleX) / 2 + (imgX / s) * bgScaleX;
        const toCanvasY = (imgY) => bg.top - (ih * bgScaleY) / 2 + (imgY / s) * bgScaleY;
        const coveredByExisting = (cx, cy) => this.units.some(u => {
            const o = u.fabricObject;
            return o && cx >= o.left && cx <= o.left + o.width * o.scaleX
                     && cy >= o.top && cy <= o.top + o.height * o.scaleY;
        });

        const imgArea = w * h;
        const tol = sealRadius + 2;
        const unitStyle = {
            fill: 'rgba(0, 120, 212, 0.3)',
            stroke: '#0078d4',
            strokeWidth: 2
        };
        let added = 0;
        let polygons = 0;
        const acceptedRegions = [];
        for (const r of regions.sort((a, b) => b.count - a.count)) {
            if (added >= 80) break;
            const bw = r.maxX - r.minX + 1;
            const bh = r.maxY - r.minY + 1;
            const areaFraction = r.count / imgArea;
            if (areaFraction < 0.0015 || areaFraction > 0.35) continue; // noise / whole floor
            if (bw < 6 || bh < 6) continue;
            if (bounds && (r.minX < bounds.minX - tol || r.maxX > bounds.maxX + tol ||
                           r.minY < bounds.minY - tol || r.maxY > bounds.maxY + tol)) continue;

            // Near-full boxes stay rectangles (easiest to edit); corridors and
            // L-shaped rooms get a polygon traced along their actual walls.
            let shape;
            if (r.count / (bw * bh) >= 0.92) {
                const left = toCanvasX(r.minX);
                const top = toCanvasY(r.minY);
                shape = new fabric.Rect({
                    left, top,
                    width: toCanvasX(r.maxX + 1) - left,
                    height: toCanvasY(r.maxY + 1) - top,
                    ...unitStyle
                });
            } else {
                const outline = this.traceMaskOutline(
                    (x, y) => label[y * w + x] === r.label,
                    r.minX, r.minY, r.maxX, r.maxY, w, h);
                if (outline.length < 4) continue;
                const points = this.simplifyPath(outline, 1.5)
                    .map(([px, py]) => ({ x: toCanvasX(px), y: toCanvasY(py) }));
                if (points.length < 3) continue;
                shape = new fabric.Polygon(points, { ...unitStyle, objectCaching: false });
                polygons++;
            }
            const cx = shape.left + (shape.width * (shape.scaleX || 1)) / 2;
            const cy = shape.top + (shape.height * (shape.scaleY || 1)) / 2;
            if (coveredByExisting(cx, cy)) {
                if (shape.type === 'polygon') polygons--;
                continue;
            }

            const unit = {
                id: this.generateUUID(),
                name: `Room ${this.units.length + 1}`,
                featureType: 'unit',
                category: 'room',
                restriction: null,
                placeId: null,
                levelId: this.currentLevel.id,
                fabricObject: shape
            };
            shape.imdfData = unit;
            this.units.push(unit);
            this.canvas.add(shape);
            acceptedRegions.push(r);
            added++;
        }

        // Trace the building's outer wall: everything not reachable from the
        // image border, walked from the wall blob's top edge. Exported as the
        // footprint/level outline so Places shows the real building shape.
        if (bounds) {
            let startX = -1;
            for (let x = bounds.minX; x <= bounds.maxX && startX < 0; x++) {
                if (inkComp[bounds.minY * w + x] === bounds.id) startX = x;
            }
            if (startX >= 0) {
                const outline = this.traceMaskOutline(
                    (x, y) => x >= bounds.minX && x <= bounds.maxX &&
                              y >= bounds.minY && y <= bounds.maxY &&
                              label[y * w + x] !== -1,
                    bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, w, h,
                    startX, bounds.minY);
                if (outline.length >= 4) {
                    const points = this.simplifyPath(outline, 2)
                        .map(([px, py]) => ({ x: toCanvasX(px), y: toCanvasY(py) }));
                    if (points.length >= 3) this.setBuildingOutline(points);
                }
            }
        }

        // Furniture: free-standing ink clusters strictly inside the building
        // (desks, tables, chairs are drawn as thin lines that rarely touch a
        // wall). Nearby blobs — a desk and its chair — merge into one block.
        let furniture = 0;
        if (bounds) {
            const maxDimX = (bounds.maxX - bounds.minX) * 0.3;
            const maxDimY = (bounds.maxY - bounds.minY) * 0.3;
            // A blob whose bounding box swallows a detected room is a wall
            // structure (an office block whose walls never touch the outer
            // wall), not furniture — rooms sit inside walls, never inside desks.
            const enclosesRoom = c => acceptedRegions.some(a =>
                a.minX >= c.minX - 2 && a.maxX <= c.maxX + 2 &&
                a.minY >= c.minY - 2 && a.maxY <= c.maxY + 2);
            const cands = comps.filter(c => c.id !== bounds.id &&
                c.count >= 6 && c.count <= imgArea * 0.01 &&
                c.minX > bounds.minX && c.maxX < bounds.maxX &&
                c.minY > bounds.minY && c.maxY < bounds.maxY &&
                (c.maxX - c.minX) <= maxDimX && (c.maxY - c.minY) <= maxDimY &&
                !enclosesRoom(c));
            const gap = Math.max(3, sealRadius);
            const used = new Array(cands.length).fill(false);
            const coveredByFixture = (x, y) => this.fixtures.some(f => {
                const o = f.fabricObject;
                return o && o.width !== undefined && x >= o.left && x <= o.left + o.width * (o.scaleX || 1)
                         && y >= o.top && y <= o.top + o.height * (o.scaleY || 1);
            });
            for (let i = 0; i < cands.length && furniture < 150; i++) {
                if (used[i]) continue;
                used[i] = true;
                const cl = { minX: cands[i].minX, minY: cands[i].minY, maxX: cands[i].maxX, maxY: cands[i].maxY };
                let grew = true;
                while (grew) {
                    grew = false;
                    for (let j = 0; j < cands.length; j++) {
                        if (used[j]) continue;
                        const c = cands[j];
                        if (c.minX <= cl.maxX + gap && c.maxX >= cl.minX - gap &&
                            c.minY <= cl.maxY + gap && c.maxY >= cl.minY - gap) {
                            used[j] = true;
                            grew = true;
                            if (c.minX < cl.minX) cl.minX = c.minX;
                            if (c.maxX > cl.maxX) cl.maxX = c.maxX;
                            if (c.minY < cl.minY) cl.minY = c.minY;
                            if (c.maxY > cl.maxY) cl.maxY = c.maxY;
                        }
                    }
                }
                if (cl.maxX - cl.minX < 4 || cl.maxY - cl.minY < 4) continue;
                const left = toCanvasX(cl.minX);
                const top = toCanvasY(cl.minY);
                const width = toCanvasX(cl.maxX + 1) - left;
                const height = toCanvasY(cl.maxY + 1) - top;
                if (coveredByFixture(left + width / 2, top + height / 2)) continue;

                const rect = new fabric.Rect({
                    left, top, width, height,
                    fill: 'rgba(108, 117, 125, 0.35)',
                    stroke: '#6c757d',
                    strokeWidth: 1
                });
                const fixture = {
                    id: this.generateUUID(),
                    name: `Furniture ${this.fixtures.length + 1}`,
                    category: 'furniture',
                    levelId: this.currentLevel.id,
                    geometryType: 'Polygon',
                    fabricObject: rect
                };
                rect.imdfData = fixture;
                this.fixtures.push(fixture);
                this.canvas.add(rect);
                furniture++;
            }
        }

        this.canvas.renderAll();
        this.updateCounts();
        if (added === 0 && furniture === 0) {
            alert('No enclosed rooms were detected. Rooms already covered by existing boxes are left alone; otherwise try drawing manually.');
        } else {
            alert(`Auto-trace added ${added} room(s)` +
                  (polygons ? ` (${polygons} traced as wall-following polygons)` : '') +
                  (furniture ? `, ${furniture} furniture block(s)` : '') +
                  (this.buildingOutline ? ', and the building outline (exported as the footprint)' : '') +
                  '. Move, resize, rename, or delete any shape afterwards. Note: doors cannot be shown in Microsoft Places — it rejects IMDF opening files.');
        }
    }

    // Walk the crack between inside and outside pixels (marching-squares
    // style): every boundary edge of the mask becomes a directed segment
    // (inside kept on the right), then the loop is walked corner-to-corner
    // from the region's topmost-leftmost pixel until it closes. Returns the
    // outer contour only — interior holes are separate loops, never visited.
    traceMaskOutline(isInside, minX, minY, maxX, maxY, w, h, startX, startY) {
        const inside = (x, y) => x >= 0 && x < w && y >= 0 && y < h && isInside(x, y);
        const key = (x, y) => y * (w + 2) + x;
        const nextEdge = new Map();
        const addEdge = (x1, y1, x2, y2) => {
            const k = key(x1, y1);
            const list = nextEdge.get(k);
            if (list) list.push(x2, y2); else nextEdge.set(k, [x2, y2]);
        };
        let sx = startX, sy = startY;
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                if (!inside(x, y)) continue;
                if (sx === undefined) { sx = x; sy = y; }
                if (!inside(x, y - 1)) addEdge(x, y, x + 1, y);
                if (!inside(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
                if (!inside(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
                if (!inside(x - 1, y)) addEdge(x, y + 1, x, y);
            }
        }
        if (sx === undefined) return [];
        const pts = [];
        let cx = sx, cy = sy;
        const limit = 4 * (maxX - minX + maxY - minY + 4) * 8;
        do {
            pts.push([cx, cy]);
            const list = nextEdge.get(key(cx, cy));
            if (!list || list.length === 0) break;
            cy = list.pop();
            cx = list.pop();
        } while ((cx !== sx || cy !== sy) && pts.length < limit);
        return pts;
    }

    // Douglas-Peucker with a cheap collinear collapse first — traced walls
    // are long axis-aligned runs of unit steps, so most points drop out.
    simplifyPath(points, epsilon) {
        if (points.length < 3) return points;
        const collapsed = [points[0]];
        for (let i = 1; i < points.length - 1; i++) {
            const [ax, ay] = collapsed[collapsed.length - 1];
            const [bx, by] = points[i];
            const [cx, cy] = points[i + 1];
            if ((bx - ax) * (cy - ay) !== (cx - ax) * (by - ay)) collapsed.push(points[i]);
        }
        collapsed.push(points[points.length - 1]);

        const keep = new Uint8Array(collapsed.length);
        keep[0] = keep[collapsed.length - 1] = 1;
        const stack = [[0, collapsed.length - 1]];
        while (stack.length) {
            const [a, b] = stack.pop();
            const [ax, ay] = collapsed[a];
            const [bx, by] = collapsed[b];
            const dx = bx - ax, dy = by - ay;
            const len = Math.hypot(dx, dy) || 1;
            let worst = -1, worstDist = epsilon;
            for (let i = a + 1; i < b; i++) {
                const d = Math.abs(dx * (ay - collapsed[i][1]) - (ax - collapsed[i][0]) * dy) / len;
                if (d > worstDist) { worstDist = d; worst = i; }
            }
            if (worst >= 0) {
                keep[worst] = 1;
                stack.push([a, worst], [worst, b]);
            }
        }
        return collapsed.filter((_, i) => keep[i]);
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
        const zoom = this.canvas.getZoom();
        this.canvas.setZoom(zoom * 1.1);
    }

    zoomOut() {
        const zoom = this.canvas.getZoom();
        this.canvas.setZoom(zoom * 0.9);
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
                    levelId: f.levelId,
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
            }))
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
                    const isSection = unitData.featureType === 'section';
                    const shape = this.shapeFromSavedCoordinates(unitData.coordinates, {
                        fill: isSection ? 'rgba(255, 140, 0, 0.3)' : 'rgba(0, 120, 212, 0.3)',
                        stroke: isSection ? '#ff8c00' : '#0078d4'
                    });
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

    // Axis-aligned 4-corner rings come back as rectangles (easy to edit);
    // anything else — traced corridors, L-shaped rooms — as a polygon.
    shapeFromSavedCoordinates(coordinates, options) {
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
