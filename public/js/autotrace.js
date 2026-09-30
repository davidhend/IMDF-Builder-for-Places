// Auto-trace: turns a floor-plan raster into clean vector map geometry.
//
// Microsoft Places draws every unit with the same flat fill and a thin
// outline, so a map only looks as good as its geometry: pixel-traced
// staircases and wobbly diagonals read as sloppy. This module therefore
// never hands raster outlines through. Walls are found geometrically, rooms
// are straightened onto axis-aligned lines, and furniture is rebuilt from the
// closed shapes its line-work encloses (each fitted with a rectangle, rounded
// rectangle or smoothed curve), so the result matches the drawing but is
// crisp at any zoom.
//
// DOM-free: the caller supplies pixels, so the same code runs in the browser
// and under Node for headless checks. All size thresholds are relative to
// the detected building, so page margins and export scale don't matter.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./mapgeom.js'));
    else root.AutoTrace = factory(root.MapGeom);
})(typeof self !== 'undefined' ? self : this, function (G) {
    'use strict';

    // Connected components of a mask (4- or 8-connected). comps[0] is unused
    // so a label doubles as an index.
    function labelMask(mask, w, h, eight) {
        const labels = new Int32Array(w * h);
        const comps = [null];
        const stack = [];
        for (let start = 0; start < w * h; start++) {
            if (!mask[start] || labels[start]) continue;
            const c = { id: comps.length, minX: w, minY: h, maxX: 0, maxY: 0, count: 0 };
            stack.push(start);
            while (stack.length) {
                const i = stack.pop();
                if (labels[i] || !mask[i]) continue;
                labels[i] = c.id;
                c.count++;
                const x = i % w, y = (i / w) | 0;
                if (x < c.minX) c.minX = x;
                if (x > c.maxX) c.maxX = x;
                if (y < c.minY) c.minY = y;
                if (y > c.maxY) c.maxY = y;
                if (x > 0) stack.push(i - 1);
                if (x < w - 1) stack.push(i + 1);
                if (y > 0) stack.push(i - w);
                if (y < h - 1) stack.push(i + w);
                if (eight) {
                    if (x > 0 && y > 0) stack.push(i - w - 1);
                    if (x < w - 1 && y > 0) stack.push(i - w + 1);
                    if (x > 0 && y < h - 1) stack.push(i + w - 1);
                    if (x < w - 1 && y < h - 1) stack.push(i + w + 1);
                }
            }
            comps.push(c);
        }
        return { labels, comps };
    }

    // Binarize at a given scale. `ink` holds dark strokes (walls, doors);
    // `mark` also captures faint ones (light-gray furniture). The largest
    // dark blob is the wall network and bounds the building.
    function analyze(source, scale) {
        const w = Math.max(1, Math.round(source.width * scale));
        const h = Math.max(1, Math.round(source.height * scale));
        const px = source.getPixels(w, h);
        const ink = new Uint8Array(w * h);
        const mark = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const lum = px[i * 4 + 3] < 40
                ? 255
                : 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
            if (lum <= 180) ink[i] = 1;
            if (lum <= 245) mark[i] = 1;
        }
        const { labels: inkComp, comps } = labelMask(ink, w, h, false);
        let bounds = null;
        for (const c of comps) if (c && (!bounds || c.count > bounds.count)) bounds = c;
        return { w, h, ink, mark, inkComp, comps, bounds };
    }

    // Dashed lines (ceiling features, canopies, property lines) are drawing
    // annotations, not things on the floor. A dash is a short thin stroke
    // with free ends; three or more in a row on the same line make a dashed
    // line. The corner pieces of a dashed rectangle count toward both of its
    // sides, and the end dashes of a line may run into other ink (a wall, a
    // chair the line passes through) — those are picked up as stubs: thin
    // runs free at one end. Returns a mask of pixels to erase: bit 1 for
    // horizontal dashed lines, bit 2 for vertical ones.
    function findDashes(mask, w, h, dashMax) {
        const { labels, comps } = labelMask(mask, w, h, true);
        const cand = [];
        const isolated = new Uint8Array(comps.length);
        for (const c of comps) {
            if (!c) continue;
            const cw = c.maxX - c.minX + 1, ch = c.maxY - c.minY + 1;
            if (Math.max(cw, ch) > dashMax || c.count > (cw + ch) * 1.6 + 2) continue;
            const rows = new Int32Array(ch), cols = new Int32Array(cw);
            for (let y = c.minY; y <= c.maxY; y++) {
                for (let x = c.minX; x <= c.maxX; x++) {
                    if (labels[y * w + x] === c.id) { rows[y - c.minY]++; cols[x - c.minX]++; }
                }
            }
            let rowPeak = 0, colPeak = 0;
            for (let i = 1; i < ch; i++) if (rows[i] > rows[rowPeak]) rowPeak = i;
            for (let i = 1; i < cw; i++) if (cols[i] > cols[colPeak]) colPeak = i;
            const corner = cw > 3 && ch > 3 && rows[rowPeak] >= cw * 0.7 && cols[colPeak] >= ch * 0.7;
            isolated[c.id] = 1;
            cand.push({
                minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, comp: c.id,
                h: ch <= 3 || corner, v: cw <= 3 || corner,
                midH: ch <= 3 ? (c.minY + c.maxY) / 2 : c.minY + rowPeak,
                midV: cw <= 3 ? (c.minX + c.maxX) / 2 : c.minX + colPeak
            });
        }
        // Stubs, row-wise then column-wise.
        for (const horizontal of [true, false]) {
            const outer = horizontal ? h : w, inner = horizontal ? w : h;
            const at = (o, n) => horizontal ? o * w + n : n * w + o;
            const thin = (o, n) => mask[at(o, n)] && !mask[at(o - 1, n)] && !mask[at(o + 1, n)];
            const touches = (o, n) => n >= 0 && n < inner &&
                (mask[at(o, n)] || mask[at(o - 1, n)] || mask[at(o + 1, n)]);
            for (let o = 1; o < outer - 1; o++) {
                let start = -1;
                for (let n = 0; n <= inner; n++) {
                    const on = n < inner && thin(o, n);
                    if (on && start < 0) start = n;
                    if (on || start < 0) continue;
                    const a = start, b = n - 1;
                    start = -1;
                    const len = b - a + 1;
                    if (len < 3 || len > dashMax || isolated[labels[at(o, a)]]) continue;
                    if (touches(o, a - 1) === touches(o, b + 1)) continue;
                    cand.push(horizontal
                        ? { minX: a, maxX: b, minY: o, maxY: o, stub: true, h: true, v: false, midH: o, midV: 0 }
                        : { minX: o, maxX: o, minY: a, maxY: b, stub: true, h: false, v: true, midH: 0, midV: o });
                }
            }
        }

        const erase = new Uint8Array(w * h);
        for (const horizontal of [true, false]) {
            const lo = k => horizontal ? k.minX : k.minY;
            const hi = k => horizontal ? k.maxX : k.maxY;
            const len = k => hi(k) - lo(k) + 1;
            const mid = k => horizontal ? k.midH : k.midV;
            const order = cand.filter(k => horizontal ? k.h : k.v).sort((p, q) => lo(p) - lo(q));
            const parent = order.map((_, i) => i);
            const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
            for (let p = 0; p < order.length; p++) {
                for (let q = p + 1; q < order.length; q++) {
                    const gap = lo(order[q]) - hi(order[p]) - 1;
                    if (gap > dashMax) break;
                    if (gap < 1 || Math.abs(mid(order[p]) - mid(order[q])) > 1) continue;
                    if (gap <= Math.max(3, len(order[p]), len(order[q]))) parent[find(p)] = find(q);
                }
            }
            const groups = new Map();
            for (let i = 0; i < order.length; i++) {
                const r = find(i);
                if (!groups.has(r)) groups.set(r, []);
                groups.get(r).push(order[i]);
            }
            const bit = horizontal ? 1 : 2;
            for (const members of groups.values()) {
                const free = members.filter(k => !k.stub);
                if (members.length < 3 || !free.length) continue;
                // Stubs only count in a line that is convincingly dashed:
                // even gaps, and no stub longer than the free dashes.
                const lens = free.map(len).sort((p, q) => p - q);
                const typical = lens[lens.length >> 1];
                let gapMin = Infinity, gapMax = 0, stubMax = 0;
                for (let i = 0; i < members.length; i++) {
                    if (members[i].stub) stubMax = Math.max(stubMax, len(members[i]));
                    if (i === 0) continue;
                    const gap = lo(members[i]) - hi(members[i - 1]) - 1;
                    gapMin = Math.min(gapMin, gap);
                    gapMax = Math.max(gapMax, gap);
                }
                const regular = gapMax - gapMin <= 2 && gapMax <= Math.max(3, typical) && stubMax <= typical + 1;
                if (!regular && free.length < 3) continue;
                for (const k of regular ? members : free) {
                    for (let y = k.minY; y <= k.maxY; y++) {
                        for (let x = k.minX; x <= k.maxX; x++) {
                            if (k.stub || labels[y * w + x] === k.comp) erase[y * w + x] |= bit;
                        }
                    }
                }
            }
        }
        return erase;
    }

    function eraseDashes(A, dashMax) {
        const { w, h, ink, mark } = A;
        const dark = findDashes(ink, w, h, dashMax);
        // A dark dash can lie along a fainter stroke (a dashed soffit line
        // drawn over the edge of a chair). Such a dash has faint ink carrying
        // on past both of its ends; it loses its darkness but the stroke
        // underneath stays.
        const overlay = new Uint8Array(w * h);
        for (const horizontal of [true, false]) {
            const outer = horizontal ? h : w, inner = horizontal ? w : h;
            const at = (o, n) => horizontal ? o * w + n : n * w + o;
            for (let o = 0; o < outer; o++) {
                let start = -1;
                for (let n = 0; n <= inner; n++) {
                    const on = n < inner && dark[at(o, n)];
                    if (on && start < 0) start = n;
                    if (on || start < 0) continue;
                    const faint = (k) => k >= 0 && k < inner && mark[at(o, k)] && !dark[at(o, k)];
                    if (n - start >= 3 && faint(start - 1) && faint(n)) for (let k = start; k < n; k++) overlay[at(o, k)] = 1;
                    start = -1;
                }
            }
        }
        const halo = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            if (!dark[i]) continue;
            const x = i % w, y = (i / w) | 0;
            ink[i] = 0;
            if (overlay[i]) continue;
            // Where a dash crosses another stroke (a chair under a dashed
            // soffit line) the crossing pixel belongs to that stroke too —
            // erasing it would cut the shape open.
            let across = 0;
            if (dark[i] !== 3) {
                const step = dark[i] === 1 ? w : 1;
                const limit = dark[i] === 1 ? h : w, pos = dark[i] === 1 ? y : x;
                for (let k = 1; pos - k >= 0 && mark[i - k * step] && !dark[i - k * step]; k++) across++;
                for (let k = 1; pos + k < limit && mark[i + k * step] && !dark[i + k * step]; k++) across++;
            }
            if (across >= 3) continue;
            mark[i] = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    const n = ny * w + nx;
                    if (mark[n] && !ink[n]) halo[n] = 1;
                }
            }
        }
        // Anti-aliasing halos orphaned by the erased dashes, then light-gray
        // dashed lines.
        const light = labelMask(mark, w, h, true);
        const keep = new Uint8Array(light.comps.length);
        for (let i = 0; i < w * h; i++) if (mark[i] && !halo[i]) keep[light.labels[i]] = 1;
        for (let i = 0; i < w * h; i++) if (mark[i] && !keep[light.labels[i]]) mark[i] = 0;
        const faint = findDashes(mark, w, h, dashMax);
        for (let i = 0; i < w * h; i++) if (faint[i]) { mark[i] = 0; ink[i] = 0; }
    }

    function trace(source, options) {
        const opts = options || {};
        const iw = source.width, ih = source.height;

        // Two-pass: if the plan sits inside wide page margins, rescan at a
        // scale where the building itself gets ~1000px.
        let s = Math.min(1, 1200 / Math.max(iw, ih));
        let A = analyze(source, s);
        if (A.bounds) {
            const buildingMaxImg = Math.max(
                A.bounds.maxX - A.bounds.minX,
                A.bounds.maxY - A.bounds.minY) / s;
            const s2 = Math.min(1, 1000 / Math.max(buildingMaxImg, 1));
            if (s2 > s * 1.15 && iw * s2 * ih * s2 < 4.2e6) {
                s = s2;
                A = analyze(source, s);
            }
        }
        if (!A.bounds) return null;
        const { w, h, ink, mark, inkComp, comps, bounds } = A;
        const bW = bounds.maxX - bounds.minX + 1;
        const bH = bounds.maxY - bounds.minY + 1;
        const bMax = Math.max(bW, bH);
        const bboxArea = bW * bH;

        const lMin = Math.max(20, Math.round(bMax / 28));     // shortest hairline that can be a wall
        const gapMax = Math.max(8, Math.round(bMax / 40));    // widest doorway that gets sealed (~1.2m)
        const dashMax = Math.max(6, Math.round(bMax / 40));
        const wallT = Math.max(6, Math.round(gapMax * 0.6));  // thickest wall two rooms can share
        const jogTol = Math.max(3, Math.round(gapMax * 0.45)); // smallest step kept in a room outline
        const footTol = Math.round(gapMax * 1.6);             // smallest step kept in the building outline

        const markBefore = opts.debug ? new Uint8Array(mark) : null;
        eraseDashes(A, dashMax);
        const dashed = opts.debug ? markBefore.map((v, i) => (v && !mark[i] ? 1 : 0)) : null;

        // Structural ink = walls. Thick strokes (a pixel whose 4 neighbours
        // are all ink) are always walls; hairline partitions are long
        // straight runs in a component that also contains thick wall ink.
        // Furniture strokes are short and thin, so they never qualify.
        const wallInk = new Uint8Array(w * h);
        const structural = new Uint8Array(w * h);
        const runH = new Int32Array(w * h);
        const runV = new Int32Array(w * h);
        const findWalls = () => {
            const hasCore = new Uint8Array(comps.length + 1);
            const thickCore = new Uint8Array(w * h);
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (ink[i] && ink[i - 1] && ink[i + 1] && ink[i - w] && ink[i + w]) {
                        thickCore[i] = 1;
                        hasCore[inkComp[i]] = 1;
                    }
                }
            }
            for (let y = 0; y < h; y++) {
                let start = -1;
                for (let x = 0; x <= w; x++) {
                    const on = x < w && ink[y * w + x];
                    if (on && start < 0) start = x;
                    if (!on && start >= 0) {
                        const len = x - start;
                        for (let k = start; k < x; k++) runH[y * w + k] = len;
                        start = -1;
                    }
                }
            }
            for (let x = 0; x < w; x++) {
                let start = -1;
                for (let y = 0; y <= h; y++) {
                    const on = y < h && ink[y * w + x];
                    if (on && start < 0) start = y;
                    if (!on && start >= 0) {
                        const len = y - start;
                        for (let k = start; k < y; k++) runV[k * w + x] = len;
                        start = -1;
                    }
                }
            }
            wallInk.fill(0);
            for (let i = 0; i < w * h; i++) {
                if (!ink[i]) continue;
                if (thickCore[i] ||
                    (Math.max(runH[i], runV[i]) >= lMin && hasCore[inkComp[i]])) wallInk[i] = 1;
            }
            // Grow by one pixel to swallow anti-aliasing halos.
            structural.set(wallInk);
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (!wallInk[i] && (wallInk[i - 1] || wallInk[i + 1] ||
                        wallInk[i - w] || wallInk[i + w])) structural[i] = 1;
                }
            }
        };
        findWalls();

        // Doorway candidates: straight gaps between wall runs, row-wise and
        // column-wise, grouped into blobs. A doorway is only as deep as its
        // wall, so a bridge that keeps going (two walls facing each other
        // down the length of a closet or toilet stall) is a narrow room and
        // is not a candidate.
        const gapWide = Math.round(gapMax * 2.2);
        const sealMin = Math.max(5, Math.round(gapMax * 0.45));
        const sealDepth = Math.max(sealMin, Math.round(gapMax * 0.6));
        const scanGaps = () => {
            const out = [];
            for (const rowWise of [true, false]) {
                const outer = rowWise ? h : w, inner = rowWise ? w : h;
                const at = (o, n) => rowWise ? o * w + n : n * w + o;
                const cand = new Uint8Array(w * h);
                for (let o = 0; o < outer; o++) {
                    let runEnd = -1, runLen = 0;
                    for (let n = 0; n < inner; n++) {
                        if (!structural[at(o, n)]) continue;
                        const gap = n - runEnd - 1;
                        if (runEnd >= 0 && gap >= 1 && gap <= gapWide && runLen >= 3) {
                            let len = 0;
                            while (n + len < inner && structural[at(o, n + len)]) len++;
                            if (len >= 3) for (let k = runEnd + 1; k < n; k++) cand[at(o, k)] = 1;
                        }
                        runLen = (n > 0 && structural[at(o, n - 1)]) ? runLen + 1 : 1;
                        runEnd = n;
                    }
                }
                const { labels, comps: cc } = labelMask(cand, w, h, false);
                for (const c of cc) {
                    if (!c) continue;
                    const width = rowWise ? c.maxX - c.minX + 1 : c.maxY - c.minY + 1;
                    const depth = rowWise ? c.maxY - c.minY + 1 : c.maxX - c.minX + 1;
                    if (width > 3 && depth > sealDepth) continue;
                    out.push({ rowWise, c, labels, width });
                }
            }
            return out;
        };

        // Doors. A drawn door is a leaf plus a quarter-circle swing from one
        // jamb round to the open leaf. Wherever a gap has one, the gap is
        // certainly a doorway (even a wide one), and the door itself is
        // erased from the drawing: bold swing arcs would otherwise read as
        // curved walls, and thin ones as furniture.
        // Doors are drawn in wall-weight (dark) ink. Swing arcs are curved,
        // so their pixels sit in short runs; long straight runs are walls
        // and don't count as evidence.
        const arcInkNear = (x, y, runMax) => {
            const cx = Math.round(x), cy = Math.round(y);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const px = cx + dx, py = cy + dy;
                    if (px < 0 || py < 0 || px >= w || py >= h) continue;
                    const i = py * w + px;
                    if (ink[i] && Math.max(runH[i], runV[i]) < runMax) return true;
                }
            }
            return false;
        };
        // Fraction of a quarter-circle swing (hinge hx,hy, radius r, from
        // the far jamb along u round to the open leaf along v) that is inked.
        const arcScore = (hx, hy, r, ux, uy, vx, vy) => {
            let hit = 0, total = 0;
            const steps = Math.max(8, Math.round(r * 1.2));
            const runMax = Math.max(6, r * 0.6);
            for (let k = 1; k < steps; k++) {
                const t = (k / steps) * Math.PI / 2;
                const a = Math.cos(t) * r, b = Math.sin(t) * r;
                total++;
                if (arcInkNear(hx + ux * a + vx * b, hy + uy * a + vy * b, runMax)) hit++;
            }
            return hit / total;
        };
        // The open leaf: a straight stroke about as long as the door is
        // wide, running from the hinge square to the wall. (A longer stroke
        // there is a side wall.)
        const leafScore = (hx, hy, r, vx, vy) => {
            let hit = 0, total = 0;
            const run = vx !== 0 ? runH : runV;
            for (let b = 2; b <= r - 1; b++) {
                total++;
                const cx = Math.round(hx + vx * b), cy = Math.round(hy + vy * b);
                let found = false;
                for (let d = -1; d <= 1 && !found; d++) {
                    const px = cx + (vx !== 0 ? 0 : d), py = cy + (vx !== 0 ? d : 0);
                    if (px < 0 || py < 0 || px >= w || py >= h) continue;
                    const i = py * w + px;
                    if (ink[i] && run[i] >= r * 0.5 && run[i] <= r + 4) found = true;
                }
                if (found) hit++;
            }
            return total ? hit / total : 0;
        };
        // How convincingly a door is drawn for this hinge/width/side: a
        // swing arc with its leaf, or an all-but-complete arc on its own.
        const doorScore = (hx, hy, r, ux, uy, vx, vy, arcMin) => {
            const arc = arcScore(hx, hy, r, ux, uy, vx, vy);
            if (arc < arcMin) return 0;
            const leaf = leafScore(hx, hy, r, vx, vy);
            if (leaf < 0.6 && arc < 0.92) return 0;
            return arc + leaf * 0.5;
        };
        const eraseSwing = (hx, hy, r, ux, uy, vx, vy) => {
            for (let b = 1.5; b <= r + 2.5; b += 0.5) {
                for (let a = -2.5; a <= r + 2.5; a += 0.5) {
                    const onLeaf = a < 1.5;
                    if (!onLeaf && Math.abs(Math.hypot(a, b) - r) > 2.5) continue;
                    const x = Math.round(hx + ux * a + vx * b), y = Math.round(hy + uy * a + vy * b);
                    if (x < 0 || y < 0 || x >= w || y >= h) continue;
                    const i = y * w + x;
                    if (!mark[i]) continue;
                    // Beside the hinge a long stroke is the side wall the
                    // open leaf rests against, not the leaf.
                    if (onLeaf && ink[i] && (vx !== 0 ? runH[i] : runV[i]) > r + 4) continue;
                    ink[i] = 0;
                    mark[i] = 0;
                }
            }
        };
        const doorAt = [new Int32Array(w * h), new Int32Array(w * h)];   // row-wise, column-wise gaps
        const doorSize = [0];
        const swings = [];
        for (const g of scanGaps()) {
            if (g.width < sealMin) continue;
            const c = g.c;
            // Jambs a/b at mid-depth of the gap; n = unit normal of the wall.
            const mid = g.rowWise ? (c.minY + c.maxY) / 2 : (c.minX + c.maxX) / 2;
            const ax = g.rowWise ? c.minX - 1 : mid, ay = g.rowWise ? mid : c.minY - 1;
            const bx = g.rowWise ? c.maxX + 1 : mid, by = g.rowWise ? mid : c.maxY + 1;
            const ux = g.rowWise ? 1 : 0, uy = g.rowWise ? 0 : 1;
            // The leaf can be narrower than the gap between wall runs (a
            // hairline frame or sidelight fills the rest), so try every
            // hinge position and leaf width that fits.
            let found = null, best = 0;
            const rMin = Math.max(sealMin * 1.5, g.width * 0.5);
            for (const side of [1, -1]) {
                const vx = uy * side, vy = ux * side;
                for (let r = g.width + 3; r >= rMin; r--) {
                    const slack = Math.max(0, g.width + 1 - r);
                    for (let t = 0; t <= slack; t++) {
                        const sa = doorScore(ax + ux * t, ay + uy * t, r, ux, uy, vx, vy, 0.75);
                        if (sa > best) { best = sa; found = [[ax + ux * t, ay + uy * t, r, ux, uy, vx, vy]]; }
                        const sb = doorScore(bx - ux * t, by - uy * t, r, -ux, -uy, vx, vy, 0.75);
                        if (sb > best) { best = sb; found = [[bx - ux * t, by - uy * t, r, -ux, -uy, vx, vy]]; }
                    }
                }
                // Double doors: two half-width leaves meeting in the middle.
                const half = (g.width + 1) / 2;
                if (!found && half >= sealMin * 1.5 &&
                    doorScore(ax, ay, half, ux, uy, vx, vy, 0.7) > 0 &&
                    doorScore(bx, by, half, -ux, -uy, vx, vy, 0.7) > 0) {
                    found = [[ax, ay, half, ux, uy, vx, vy], [bx, by, half, -ux, -uy, vx, vy]];
                }
            }
            if (!found) continue;
            swings.push(...found);
            const plane = doorAt[g.rowWise ? 0 : 1];
            let n = 0;
            for (let y = c.minY; y <= c.maxY; y++) {
                for (let x = c.minX; x <= c.maxX; x++) {
                    if (g.labels[y * w + x] === c.id) { plane[y * w + x] = doorSize.length; n++; }
                }
            }
            doorSize.push(n);
        }
        for (const swing of swings) eraseSwing(...swing);
        findWalls();

        // Seal doorways — every gap a drawn door was found in, plus plain
        // openings up to ~1.2m wide (hairline breaks always close) — then
        // flood from the borders: everything reachable is outside, and the
        // remaining open regions (walls sealed, furniture floodable) are
        // spaces. If the building itself floods, an entrance wider than the
        // limit was left open; widen the limit and try again.
        const label = new Int32Array(w * h);
        const stack = [];
        const flood = (seedLabel) => {
            let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
            while (stack.length) {
                const i = stack.pop();
                if (label[i] !== 0 || closed[i]) continue;
                label[i] = seedLabel;
                count++;
                const x = i % w, y = (i / w) | 0;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (x > 0) stack.push(i - 1);
                if (x < w - 1) stack.push(i + 1);
                if (y > 0) stack.push(i - w);
                if (y < h - 1) stack.push(i + w);
            }
            return { minX, minY, maxX, maxY, count };
        };
        const gaps = scanGaps();
        let closed, doorways;
        for (let attempt = 0, limit = gapMax; ; attempt++, limit = Math.round(limit * 1.5)) {
            closed = new Uint8Array(structural);
            doorways = [];
            for (const g of gaps) {
                const c = g.c;
                let confirmed = g.width <= limit;
                if (!confirmed) {
                    // Same doorway as one a drawn door was found in?
                    const plane = doorAt[g.rowWise ? 0 : 1];
                    const hits = new Map();
                    for (let y = c.minY; y <= c.maxY; y++) {
                        for (let x = c.minX; x <= c.maxX; x++) {
                            const d = plane[y * w + x];
                            if (d && g.labels[y * w + x] === c.id) hits.set(d, (hits.get(d) || 0) + 1);
                        }
                    }
                    for (const [d, n] of hits) if (n >= doorSize[d] * 0.5) { confirmed = true; break; }
                }
                if (!confirmed) continue;
                for (let y = c.minY; y <= c.maxY; y++) {
                    for (let x = c.minX; x <= c.maxX; x++) {
                        if (g.labels[y * w + x] === c.id) closed[y * w + x] = 1;
                    }
                }
                // Jamb to jamb along the middle of the wall.
                if (g.width >= sealMin) {
                    doorways.push(g.rowWise
                        ? { x1: c.minX, y1: (c.minY + c.maxY + 1) / 2, x2: c.maxX + 1, y2: (c.minY + c.maxY + 1) / 2 }
                        : { x1: (c.minX + c.maxX + 1) / 2, y1: c.minY, x2: (c.minX + c.maxX + 1) / 2, y2: c.maxY + 1 });
                }
            }
            label.fill(0);
            for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
            for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
            flood(-1);
            let enclosed = 0;
            for (let y = bounds.minY; y <= bounds.maxY; y++) {
                for (let x = bounds.minX; x <= bounds.maxX; x++) if (label[y * w + x] !== -1) enclosed++;
            }
            if (enclosed >= bboxArea * 0.5 || attempt >= 2) break;
        }
        const seal = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) if (closed[i] && !structural[i]) seal[i] = 1;

        let regions = [null];
        for (let start = 0; start < w * h; start++) {
            if (label[start] === 0 && !closed[start]) {
                stack.push(start);
                const r = flood(regions.length);
                r.label = regions.length;
                regions.push(r);
            }
        }

        // ---- Building outline ------------------------------------------
        // Everything the outside flood couldn't reach, opened with a ~1m
        // square so door swings, canopy beams and posts hanging off the
        // facade fall away, then straightened. Steps smaller than ~1.5m are
        // treated as facade detail, so a rectangular building comes out as a
        // plain box.
        const kOpen = Math.max(3, Math.round(gapMax * 0.5));
        const integral = (mask) => {
            const I = new Int32Array((w + 1) * (h + 1));
            for (let y = 0; y < h; y++) {
                let row = 0;
                for (let x = 0; x < w; x++) {
                    row += mask[y * w + x];
                    I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
                }
            }
            return I;
        };
        const windowSum = (I, x0, y0, x1, y1) => {   // inclusive pixel box, clamped
            const ax = Math.max(0, x0), ay = Math.max(0, y0);
            const bx = Math.min(w - 1, x1) + 1, by = Math.min(h - 1, y1) + 1;
            return I[by * (w + 1) + bx] - I[ay * (w + 1) + bx] - I[by * (w + 1) + ax] + I[ay * (w + 1) + ax];
        };
        const notOutside = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) if (label[i] !== -1) notOutside[i] = 1;
        const fullWindow = (2 * kOpen + 1) * (2 * kOpen + 1);
        const eroded = new Uint8Array(w * h);
        {
            const I = integral(notOutside);
            for (let y = kOpen; y < h - kOpen; y++) {
                for (let x = kOpen; x < w - kOpen; x++) {
                    if (windowSum(I, x - kOpen, y - kOpen, x + kOpen, y + kOpen) === fullWindow) eroded[y * w + x] = 1;
                }
            }
        }
        const opened = new Uint8Array(w * h);
        {
            const I = integral(eroded);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (windowSum(I, x - kOpen, y - kOpen, x + kOpen, y + kOpen) > 0) opened[y * w + x] = 1;
                }
            }
        }
        const regularize = (loop, tol) => {
            const clean = G.cleanRing(loop);
            let perimeter = 0, stair = 0;
            for (let i = 0; i < clean.length; i++) {
                const a = clean[i], b = clean[(i + 1) % clean.length];
                const len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
                perimeter += len;
                if (len < 3) stair += len;
            }
            // Mostly one-pixel steps = a diagonal or curved wall: keep its shape.
            if (perimeter > 0 && stair / perimeter > 0.3) {
                return { ring: G.simplifyRing(clean, 1.5), rectilinear: false };
            }
            return { ring: G.rectilinearSimplify(clean, tol), rectilinear: true };
        };
        const outerLoop = (isInside, c) => {
            const loops = G.traceLoops(isInside, c.minX, c.minY, c.maxX, c.maxY);
            let best = null, bestArea = 0;
            for (const l of loops) {
                const a = Math.abs(G.ringArea(l));
                if (a > bestArea) { bestArea = a; best = l; }
            }
            return best;
        };

        let footprint = null;
        let footprintRectilinear = false;
        {
            const { labels, comps: fc } = labelMask(opened, w, h, false);
            let big = null;
            for (const c of fc) if (c && (!big || c.count > big.count)) big = c;
            if (big) {
                const loop = outerLoop((x, y) => labels[y * w + x] === big.id, big);
                if (loop) {
                    const reg = regularize(loop, footTol);
                    // The outside flood stops at the grown wall mask, one
                    // pixel proud of the real ink.
                    footprint = reg.rectilinear ? G.offsetRectilinear(reg.ring, -1) : reg.ring;
                    footprintRectilinear = reg.rectilinear;
                }
            }
        }
        if (!footprint || footprint.length < 3) return null;

        const inFoot = new Uint8Array(w * h);
        {
            const fb = G.ringBounds(footprint);
            for (let y = Math.max(0, Math.floor(fb.minY)); y <= Math.min(h - 1, Math.ceil(fb.maxY)); y++) {
                const yc = y + 0.5;
                const xsHit = [];
                for (let i = 0; i < footprint.length; i++) {
                    const [x1, y1] = footprint[i];
                    const [x2, y2] = footprint[(i + 1) % footprint.length];
                    if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
                        xsHit.push(x1 + (yc - y1) * (x2 - x1) / (y2 - y1));
                    }
                }
                xsHit.sort((a, b) => a - b);
                for (let k = 0; k + 1 < xsHit.length; k += 2) {
                    const a = Math.max(0, Math.ceil(xsHit[k] - 0.5));
                    const b = Math.min(w - 1, Math.floor(xsHit[k + 1] - 0.5));
                    for (let x = a; x <= b; x++) inFoot[y * w + x] = 1;
                }
            }
        }
        const fpBounds = G.ringBounds(footprint);
        const fpArea = Math.abs(G.ringArea(footprint));

        // ---- Spaces ----------------------------------------------------
        // Regions outside the outline (door-swing pockets on the facade)
        // count as outside. Slivers — the white core of a double-line wall —
        // become wall.
        const inside = new Int32Array(regions.length);
        for (let i = 0; i < w * h; i++) if (label[i] > 0 && inFoot[i]) inside[label[i]]++;
        const state = new Int8Array(regions.length);   // 0 space, 1 outside, 2 wall
        const tinyArea = Math.max(12, Math.round(gapMax * gapMax * 0.25));
        const thinMax = Math.max(3, gapMax * 0.3);
        for (let r = 1; r < regions.length; r++) {
            const reg = regions[r];
            const bw = reg.maxX - reg.minX + 1, bh = reg.maxY - reg.minY + 1;
            if (inside[r] < reg.count * 0.5) state[r] = 1;
            else if (reg.count < tinyArea || reg.count / Math.max(bw, bh) <= thinMax) state[r] = 2;
        }
        for (let i = 0; i < w * h; i++) {
            const l = label[i];
            if (l <= 0) continue;
            if (state[l] === 1) label[i] = -1;
            else if (state[l] === 2) { label[i] = 0; closed[i] = 1; }
        }

        // Which spaces face each other across a wall, and whether a sealed
        // doorway connects them.
        const N = regions.length;
        const contact = new Map();
        const addContact = (a, b, door) => {
            const key = a < b ? a * N + b : b * N + a;
            const c = contact.get(key);
            if (c) { c.weight += door ? 3 : 1; if (door) c.door = true; }
            else contact.set(key, { a: Math.min(a, b), b: Math.max(a, b), weight: door ? 3 : 1, door });
        };
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                const a = label[i];
                if (a <= 0) continue;
                if (x + 1 < w && closed[i + 1]) {
                    let k = 1, door = false;
                    while (k <= wallT && x + k < w && closed[i + k]) { if (seal[i + k]) door = true; k++; }
                    if (k <= wallT && x + k < w) {
                        const b = label[i + k];
                        if (b > 0 && b !== a) addContact(a, b, door);
                    }
                }
                if (y + 1 < h && closed[i + w]) {
                    let k = 1, door = false;
                    while (k <= wallT && y + k < h && closed[i + k * w]) { if (seal[i + k * w]) door = true; k++; }
                    if (k <= wallT && y + k < h) {
                        const b = label[i + k * w];
                        if (b > 0 && b !== a) addContact(a, b, door);
                    }
                }
            }
        }

        // Merge spaces too small to be a room — toilet stalls, closets,
        // vestibules — into the neighbour they share the most wall (or a
        // door) with, smallest first. This is what keeps a restroom core one
        // clean shape instead of a mosaic of fragments and blank holes.
        const minRoom = fpArea * 0.003;
        const parent = new Int32Array(N);
        const size = new Float64Array(N);
        for (let r = 1; r < N; r++) { parent[r] = r; size[r] = state[r] === 0 ? regions[r].count : 0; }
        const find = (r) => { while (parent[r] !== r) { parent[r] = parent[parent[r]]; r = parent[r]; } return r; };
        const neighbours = Array.from({ length: N }, () => new Map());
        for (const c of contact.values()) {
            neighbours[c.a].set(c.b, { weight: c.weight, door: c.door });
            neighbours[c.b].set(c.a, { weight: c.weight, door: c.door });
        }
        for (;;) {
            let pick = -1;
            for (let r = 1; r < N; r++) {
                if (state[r] !== 0 || parent[r] !== r || size[r] >= minRoom || neighbours[r].size === 0) continue;
                if (pick < 0 || size[r] < size[pick]) pick = r;
            }
            if (pick < 0) break;
            let best = -1, bestW = -1;
            for (const [nb, c] of neighbours[pick]) {
                if (c.weight > bestW || (c.weight === bestW && size[nb] > size[best])) { bestW = c.weight; best = nb; }
            }
            parent[pick] = best;
            size[best] += size[pick];
            neighbours[best].delete(pick);
            for (const [nb, c] of neighbours[pick]) {
                if (nb === best) continue;
                neighbours[nb].delete(pick);
                const prev = neighbours[best].get(nb);
                const merged = prev
                    ? { weight: prev.weight + c.weight, door: prev.door || c.door }
                    : { weight: c.weight, door: c.door };
                neighbours[best].set(nb, merged);
                neighbours[nb].set(best, merged);
            }
            neighbours[pick].clear();
        }
        for (let i = 0; i < w * h; i++) if (label[i] > 0) label[i] = find(label[i]);

        // A wall with the same space on both sides is a partition inside it
        // (a wing wall, a stall divider, a cubicle panel, the wall a merge
        // just removed). Fold those pixels into the space so its outline is
        // one clean shape; the partitions themselves are drawn separately.
        const wallMask = new Uint8Array(closed);   // walls before folding
        const absorbed = new Uint8Array(w * h);
        for (let pass = 0; pass < 3; pass++) {
            const next = new Int32Array(label);
            let changed = false;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = y * w + x;
                    if (label[i] !== 0 || !closed[i]) continue;
                    let l = 1, r = 1, u = 1, d = 1;
                    while (l <= wallT && x - l >= 0 && label[i - l] === 0 && closed[i - l]) l++;
                    while (r <= wallT && x + r < w && label[i + r] === 0 && closed[i + r]) r++;
                    while (u <= wallT && y - u >= 0 && label[i - u * w] === 0 && closed[i - u * w]) u++;
                    while (d <= wallT && y + d < h && label[i + d * w] === 0 && closed[i + d * w]) d++;
                    const L = x - l >= 0 ? label[i - l] : -1, R = x + r < w ? label[i + r] : -1;
                    const U = y - u >= 0 ? label[i - u * w] : -1, D = y + d < h ? label[i + d * w] : -1;
                    let to = 0;
                    if (L > 0 && L === R && l + r - 1 <= wallT) to = L;
                    else if (U > 0 && U === D && u + d - 1 <= wallT) to = U;
                    if (to) { next[i] = to; changed = true; }
                }
            }
            if (!changed) break;
            for (let i = 0; i < w * h; i++) {
                if (next[i] !== label[i]) { label[i] = next[i]; closed[i] = 0; absorbed[i] = 1; }
            }
        }

        const spaces = new Map();
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const l = label[y * w + x];
                if (l <= 0) continue;
                let sp = spaces.get(l);
                if (!sp) { sp = { label: l, minX: w, minY: h, maxX: 0, maxY: 0, count: 0, doors: 0 }; spaces.set(l, sp); }
                sp.count++;
                if (x < sp.minX) sp.minX = x;
                if (x > sp.maxX) sp.maxX = x;
                if (y < sp.minY) sp.minY = y;
                if (y > sp.maxY) sp.maxY = y;
            }
        }
        for (const [r, nbs] of neighbours.entries()) {
            const sp = spaces.get(r);
            if (!sp) continue;
            for (const c of nbs.values()) if (c.door) sp.doors++;
        }

        // Rooms vs circulation. Corridor networks sprawl (large area, low
        // bounding-box solidity) or dominate the floor; everything else
        // enclosed is a room.
        const roomSpaces = [];
        const isRoom = new Uint8Array(N);
        let largest = null;
        for (const sp of spaces.values()) if (!largest || sp.count > largest.count) largest = sp;
        for (const sp of [...spaces.values()].sort((a, b) => b.count - a.count)) {
            const bw = sp.maxX - sp.minX + 1, bh = sp.maxY - sp.minY + 1;
            const fraction = sp.count / fpArea;
            if (sp.count < minRoom * 0.35) continue;                        // left as wall-side clutter
            if (fraction > 0.6) continue;
            if (sp.count / (bw * bh) < 0.45 && fraction >= 0.01) continue;
            if (sp === largest && fraction >= 0.2) continue;
            isRoom[sp.label] = 1;
            roomSpaces.push(sp);
        }

        const rooms = [];
        for (const sp of roomSpaces) {
            const loop = outerLoop((x, y) => label[y * w + x] === sp.label, sp);
            if (!loop) continue;
            const reg = regularize(loop, jogTol);
            if (reg.ring.length < 3) continue;
            // Undo the one-pixel wall growth so the outline sits on the ink.
            rooms.push({
                ring: reg.rectilinear ? G.offsetRectilinear(reg.ring, 1) : reg.ring,
                rectilinear: reg.rectilinear,
                area: sp.count
            });
        }

        // Circulation: every interior space no room claimed. A region that
        // wraps around a room block keeps the block as a hole ring.
        const walkways = [];
        {
            const walkMask = new Uint8Array(w * h);
            for (let i = 0; i < w * h; i++) if (label[i] > 0 && !isRoom[label[i]]) walkMask[i] = 1;
            const { labels: wl, comps: wc } = labelMask(walkMask, w, h, false);
            const minWalk = fpArea * 0.002;
            for (const comp of wc) {
                if (!comp || comp.count < minWalk) continue;
                const loops = G.traceLoops((x, y) => wl[y * w + x] === comp.id,
                    comp.minX, comp.minY, comp.maxX, comp.maxY);
                if (!loops.length) continue;
                loops.sort((a, b) => Math.abs(G.ringArea(b)) - Math.abs(G.ringArea(a)));
                const rings = [];
                let rectilinear = true;
                loops.forEach((loop, idx) => {
                    if (idx > 0 && Math.abs(G.ringArea(loop)) < jogTol * jogTol) return;
                    const reg = regularize(loop, jogTol);
                    if (reg.ring.length < 3) return;
                    if (!reg.rectilinear) rectilinear = false;
                    rings.push(reg.rectilinear ? G.offsetRectilinear(reg.ring, idx === 0 ? 1 : -1) : reg.ring);
                });
                if (!rings.length) continue;

                // A point guaranteed inside the shape (the centroid can land
                // in a hole): midpoint of the widest corridor run.
                let bestLen = 0, bestX = (comp.minX + comp.maxX) / 2, bestY = (comp.minY + comp.maxY) / 2;
                for (let y = comp.minY; y <= comp.maxY; y++) {
                    let runStart = -1;
                    for (let x = comp.minX; x <= comp.maxX + 1; x++) {
                        const on = x <= comp.maxX && wl[y * w + x] === comp.id;
                        if (on && runStart < 0) runStart = x;
                        if (!on && runStart >= 0) {
                            if (x - runStart > bestLen) {
                                bestLen = x - runStart;
                                bestX = (runStart + x) / 2;
                                bestY = y + 0.5;
                            }
                            runStart = -1;
                        }
                    }
                }
                walkways.push({ rings, rectilinear, point: [bestX, bestY], area: comp.count });
            }
        }

        // ---- Partitions ------------------------------------------------
        // Wall ink folded into a space: drawn as thin shapes on top of it.
        const partitions = [];
        {
            const pMask = new Uint8Array(w * h);
            for (let i = 0; i < w * h; i++) if (absorbed[i] && wallInk[i]) pMask[i] = 1;
            const { labels: pl, comps: pc } = labelMask(pMask, w, h, false);
            for (const comp of pc) {
                if (!comp || comp.count < 4) continue;
                if (Math.max(comp.maxX - comp.minX, comp.maxY - comp.minY) < jogTol) continue;
                const loops = G.traceLoops((x, y) => pl[y * w + x] === comp.id,
                    comp.minX, comp.minY, comp.maxX, comp.maxY);
                if (!loops.length) continue;
                loops.sort((a, b) => Math.abs(G.ringArea(b)) - Math.abs(G.ringArea(a)));
                const rings = loops
                    .filter((l, idx) => idx === 0 || Math.abs(G.ringArea(l)) >= 9)
                    .map(l => G.rectilinearSimplify(l, 2))
                    .filter(l => l.length >= 4);
                if (!rings.length) continue;
                const pieces = rings.length === 1 ? [rings[0]] : G.splitRectilinearHoles(rings);
                for (const ring of pieces) partitions.push({ ring });
            }
        }

        // ---- Doors -----------------------------------------------------
        // Row-wise and column-wise scans can both catch one doorway (at a
        // corner); keep one line per doorway, inside the building.
        const doors = [];
        for (const d of doorways) {
            const mx = (d.x1 + d.x2) / 2, my = (d.y1 + d.y2) / 2;
            if (!inFoot[Math.min(h - 1, Math.floor(my)) * w + Math.min(w - 1, Math.floor(mx))]) continue;
            const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
            if (doors.some(o => Math.hypot((o.x1 + o.x2) / 2 - mx, (o.y1 + o.y2) / 2 - my) < len / 2)) continue;
            doors.push(d);
        }

        // ---- Furniture -------------------------------------------------
        // Every visible stroke (light or dark) inside the building that
        // isn't a wall. Line-work is rebuilt from what it encloses: each
        // closed pocket of floor bounded by furniture ink is a "face" (a
        // desktop, a chair seat), and each free-standing drawing also gets
        // its outer silhouette. Drawing those outlines reproduces the
        // original lines. A pocket that touches a sealed doorway is a door
        // swing, not furniture; strokes that enclose nothing (labels, ticks,
        // arcs) are dropped.
        const furniture = [];
        {
            // Partitions count as strokes here so casework drawn partly in
            // wall-weight lines (a counter against a wall) still closes.
            const F = new Uint8Array(w * h);
            const partInk = new Uint8Array(w * h);
            for (let i = 0; i < w * h; i++) {
                if (!inFoot[i] || label[i] === -1) continue;
                if (absorbed[i] && wallInk[i]) { F[i] = 1; partInk[i] = 1; }
                else if (mark[i] && !structural[i] && !seal[i]) F[i] = 1;
            }

            // Pockets: enclosed patches of floor, each owned by the drawing
            // that surrounds it. The largest patch of a space is its open
            // floor, never a pocket.
            const pocketScan = () => {
                const free = new Uint8Array(w * h);
                for (let i = 0; i < w * h; i++) {
                    if (inFoot[i] && !F[i] && !wallMask[i] && label[i] > 0) free[i] = 1;
                }
                const { labels: fl, comps: fcomps } = labelMask(free, w, h, false);
                const { labels: cl, comps: clusters } = labelMask(F, w, h, true);
                const floorOf = new Map();
                const spaceOf = new Int32Array(fcomps.length);
                for (let i = 0; i < w * h; i++) if (fl[i] && !spaceOf[fl[i]]) spaceOf[fl[i]] = label[i];
                for (const c of fcomps) {
                    if (!c) continue;
                    const cur = floorOf.get(spaceOf[c.id]);
                    if (!cur || c.count > cur.count) floorOf.set(spaceOf[c.id], c);
                }
                const touch = fcomps.map(() => null);
                const atDoor = new Uint8Array(fcomps.length);
                for (let y = 1; y < h - 1; y++) {
                    for (let x = 1; x < w - 1; x++) {
                        const i = y * w + x;
                        const fId = fl[i];
                        if (!fId) continue;
                        for (const n of [i - 1, i + 1, i - w, i + w]) {
                            if (seal[n]) atDoor[fId] = 1;
                            const c = cl[n];
                            if (c) {
                                if (!touch[fId]) touch[fId] = new Map();
                                touch[fId].set(c, (touch[fId].get(c) || 0) + 1);
                            }
                        }
                    }
                }
                const pocketsOf = clusters.map(() => []);
                const doorPocket = new Uint8Array(fcomps.length);
                for (const c of fcomps) {
                    if (!c || !touch[c.id] || floorOf.get(spaceOf[c.id]) === c) continue;
                    let owner = 0, ownerTouch = 0;
                    for (const [k, n] of touch[c.id]) {
                        const kc = clusters[k];
                        if (c.minX < kc.minX - 2 || c.maxX > kc.maxX + 2 ||
                            c.minY < kc.minY - 2 || c.maxY > kc.maxY + 2) continue;
                        if (n > ownerTouch) { ownerTouch = n; owner = k; }
                    }
                    if (!owner) continue;
                    if (atDoor[c.id]) doorPocket[c.id] = 1;
                    else pocketsOf[owner].push(c);
                }
                const isFloor = new Uint8Array(fcomps.length);
                for (const c of floorOf.values()) isFloor[c.id] = 1;
                return { fl, cl, clusters, pocketsOf, doorPocket, isFloor };
            };

            // First pass finds door swings; their leaf and arc are erased so
            // they can't be mistaken for furniture.
            {
                const scan = pocketScan();
                for (let y = 1; y < h - 1; y++) {
                    for (let x = 1; x < w - 1; x++) {
                        const i = y * w + x;
                        if (!F[i] || partInk[i]) continue;
                        let door = false;
                        for (let dy = -1; dy <= 1 && !door; dy++) {
                            for (let dx = -1; dx <= 1; dx++) {
                                const fId = scan.fl[i + dy * w + dx];
                                if (fId && scan.doorPocket[fId]) { door = true; break; }
                            }
                        }
                        if (door) F[i] = 0;
                    }
                }
            }
            const { fl, cl, clusters, pocketsOf, isFloor } = pocketScan();

            const maxDimX = (fpBounds.maxX - fpBounds.minX) * 0.35;
            const maxDimY = (fpBounds.maxY - fpBounds.minY) * 0.35;
            const minInk = Math.max(6, Math.round(bboxArea / 80000));
            const minFace = 8;
            const scrapArea = gapMax * gapMax * 0.2;

            // Fit a clean shape to a pixel mask: a rectangle whose corners
            // may each be rounded (desks, chairs, stools, bow fronts), else
            // a squared-up polygon (L-shaped returns, chamfered corners),
            // else a smoothed trace (curves). `grow` moves the boundary
            // onto the centre of the pen stroke.
            const fitShape = (test, x0, y0, x1, y1, grow, keepScraps) => {
                const lw = x1 - x0 + 1, lh = y1 - y0 + 1;
                const rows = new Int32Array(lh), cols = new Int32Array(lw);
                let count = 0;
                for (let y = y0; y <= y1; y++) {
                    for (let x = x0; x <= x1; x++) {
                        if (test(x, y)) { rows[y - y0]++; cols[x - x0]++; count++; }
                    }
                }
                if (!count) return null;
                // Robust box: ignore rows/columns that are only stray pixels.
                let rowMax = 0, colMax = 0;
                for (const v of rows) if (v > rowMax) rowMax = v;
                for (const v of cols) if (v > colMax) colMax = v;
                let top = 0, bottom = lh - 1, left = 0, right = lw - 1;
                while (top < bottom && rows[top] < rowMax * 0.3) top++;
                while (bottom > top && rows[bottom] < rowMax * 0.3) bottom--;
                while (left < right && cols[left] < colMax * 0.3) left++;
                while (right > left && cols[right] < colMax * 0.3) right--;
                const bx0 = x0 + left, by0 = y0 + top, bx1 = x0 + right + 1, by1 = y0 + bottom + 1;
                const bw = bx1 - bx0, bh = by1 - by0;
                const box = { x0: bx0, y0: by0, x1: bx1, y1: by1 };

                // Corner radius from the area each corner is missing. One
                // missing pixel is noise — unless all four corners agree.
                const qw = Math.max(1, Math.floor(bw / 2)), qh = Math.max(1, Math.floor(bh / 2));
                const quadrant = (qx0, qy0) => {
                    let n = 0;
                    for (let y = qy0; y < qy0 + qh; y++) for (let x = qx0; x < qx0 + qw; x++) if (test(x, y)) n++;
                    return Math.min(Math.sqrt(Math.max(0, qw * qh - n) / (1 - Math.PI / 4)), Math.min(bw, bh) / 2);
                };
                let radii = [
                    quadrant(bx0, by0), quadrant(bx1 - qw, by0),
                    quadrant(bx1 - qw, by1 - qh), quadrant(bx0, by1 - qh)
                ];
                const floor = radii.every(r => r >= 1.5) ? 1.5 : 2.5;
                radii = radii.map(r => (r < floor ? 0 : r));
                const midX = (bx0 + bx1) / 2, midY = (by0 + by1) / 2;
                const inModel = (x, y) => {
                    const px = x + 0.5, py = y + 0.5;
                    if (px < bx0 || px > bx1 || py < by0 || py > by1) return false;
                    const cornerOk = (r, ax, ay) => {
                        if (r <= 0) return true;
                        const dx = ax < midX ? (ax + r) - px : px - (ax - r);
                        const dy = ay < midY ? (ay + r) - py : py - (ay - r);
                        return !(dx > 0 && dy > 0 && dx * dx + dy * dy > r * r);
                    };
                    return cornerOk(radii[0], bx0, by0) && cornerOk(radii[1], bx1, by0) &&
                           cornerOk(radii[2], bx1, by1) && cornerOk(radii[3], bx0, by1);
                };
                const agreement = (inShape) => {
                    let inter = 0, union = 0;
                    for (let y = y0; y <= y1; y++) {
                        for (let x = x0; x <= x1; x++) {
                            const p = test(x, y), q = inShape(x, y);
                            if (p && q) inter++;
                            if (p || q) union++;
                        }
                    }
                    return union ? inter / union : 0;
                };
                if (agreement(inModel) >= (count >= 60 ? 0.9 : 0.84) && bw + 2 * grow > 1 && bh + 2 * grow > 1) {
                    return {
                        kind: 'box', box,
                        ring: G.roundedRect(bx0 - grow, by0 - grow, bx1 + grow, by1 + grow,
                            radii.map(r => (r > 0 ? Math.max(0, r + grow) : 0)))
                    };
                }

                const loop = outerLoop(test, { minX: x0, minY: y0, maxX: x1, maxY: y1 });
                if (!loop) return null;
                const clean = G.cleanRing(loop);
                const poly = G.snapAxes(G.simplifyRing(clean, 1.1));
                if (poly.length >= 3 && poly.length <= 14 &&
                    agreement((x, y) => G.pointInRings(x + 0.5, y + 0.5, [poly])) >= 0.88) {
                    return { kind: 'polygon', box, ring: G.offsetPolygon(poly, grow) };
                }
                // Ragged but square at heart (a band whose edge a dashed line
                // has chewed): straighten it, dropping the small steps.
                const square = G.rectilinearSimplify(clean, 2.5);
                if (square.length >= 4 &&
                    agreement((x, y) => G.pointInRings(x + 0.5, y + 0.5, [square])) >= 0.86) {
                    return { kind: 'polygon', box, ring: G.offsetRectilinear(square, grow) };
                }
                // Curves. Small irregular scraps are lettering and symbols.
                if (count < scrapArea && !keepScraps) return null;
                const smooth = G.chaikin(G.simplifyRing(clean, 0.9), 2, 1.2);
                return smooth.length >= 3 ? { kind: 'curve', box, ring: smooth } : null;
            };

            // Faces a drawing encloses on its own. Low-resolution line-work
            // is rarely watertight, so the drawing is closed first (grow by
            // a pixel, fill what that encloses, shrink back): a seat whose
            // outline has a one-pixel break still counts.
            const localFaces = (c) => {
                const x0 = Math.max(0, c.minX - 2), y0 = Math.max(0, c.minY - 2);
                const x1 = Math.min(w - 1, c.maxX + 2), y1 = Math.min(h - 1, c.maxY + 2);
                const lw = x1 - x0 + 1, lh = y1 - y0 + 1;
                const L = new Uint8Array(lw * lh);
                for (let y = y0; y <= y1; y++) {
                    for (let x = x0; x <= x1; x++) if (cl[y * w + x] === c.id) L[(y - y0) * lw + (x - x0)] = 1;
                }
                const D = new Uint8Array(lw * lh);
                for (let y = 0; y < lh; y++) {
                    for (let x = 0; x < lw; x++) {
                        let on = 0;
                        for (let dy = -1; dy <= 1 && !on; dy++) {
                            for (let dx = -1; dx <= 1; dx++) {
                                const nx = x + dx, ny = y + dy;
                                if (nx >= 0 && ny >= 0 && nx < lw && ny < lh && L[ny * lw + nx]) { on = 1; break; }
                            }
                        }
                        D[y * lw + x] = on;
                    }
                }
                const outside = new Uint8Array(lw * lh);
                const st = [];
                for (let x = 0; x < lw; x++) st.push(x, (lh - 1) * lw + x);
                for (let y = 0; y < lh; y++) st.push(y * lw, y * lw + lw - 1);
                while (st.length) {
                    const i = st.pop();
                    if (outside[i] || D[i]) continue;
                    outside[i] = 1;
                    const x = i % lw, y = (i / lw) | 0;
                    if (x > 0) st.push(i - 1);
                    if (x < lw - 1) st.push(i + 1);
                    if (y > 0) st.push(i - lw);
                    if (y < lh - 1) st.push(i + lw);
                }
                const solid = new Uint8Array(lw * lh);
                const inner = new Uint8Array(lw * lh);
                for (let y = 1; y < lh - 1; y++) {
                    for (let x = 1; x < lw - 1; x++) {
                        const i = y * lw + x;
                        let all = 1;
                        for (let dy = -1; dy <= 1 && all; dy++) {
                            for (let dx = -1; dx <= 1; dx++) if (outside[i + dy * lw + dx]) { all = 0; break; }
                        }
                        if (all || L[i]) solid[i] = 1;
                        if (all && !L[i]) inner[i] = 1;
                    }
                }
                const { labels, comps: faces } = labelMask(inner, lw, lh, false);
                return { x0, y0, x1, y1, lw, lh, solid, labels, faces: faces.filter(fc => fc && fc.count >= minFace) };
            };

            for (const c of clusters) {
                if (!c) continue;
                if (furniture.length >= 1500) break;
                const cw = c.maxX - c.minX + 1, ch = c.maxY - c.minY + 1;
                if (c.count < minInk || (cw < 4 && ch < 4)) continue;

                // Pen width (median of each stroke pixel's shorter run), and
                // whether the drawing includes partition strokes.
                const widths = [];
                let solidRun = 0, hasPartition = false;
                for (let y = c.minY; y <= c.maxY; y++) {
                    for (let x = c.minX; x <= c.maxX; x++) {
                        const i = y * w + x;
                        if (cl[i] !== c.id) continue;
                        if (partInk[i]) hasPartition = true;
                        let a = 1, b = 1;
                        for (let k = x - 1; k >= c.minX && cl[y * w + k] === c.id; k--) a++;
                        for (let k = x + 1; k <= c.maxX && cl[y * w + k] === c.id; k++) a++;
                        for (let k = y - 1; k >= c.minY && cl[k * w + x] === c.id; k--) b++;
                        for (let k = y + 1; k <= c.maxY && cl[k * w + x] === c.id; k++) b++;
                        const t = Math.min(a, b);
                        widths.push(t);
                        if (t > solidRun) solidRun = t;
                    }
                }
                widths.sort((a, b) => a - b);
                const pen = widths[widths.length >> 1] || 1;
                const grow = Math.min(1, pen / 2);
                if (!hasPartition && (cw > maxDimX || ch > maxDimY)) continue;
                if (!hasPartition && solidRun < 4 && c.count < minInk * 2) continue;

                // Faces: what the drawing encloses by itself, plus pockets
                // it closes against a wall (a credenza drawn on three sides).
                const local = hasPartition ? null : localFaces(c);
                const localAt = (x, y) => (local && x >= local.x0 && x <= local.x1 && y >= local.y0 && y <= local.y1)
                    ? local.labels[(y - local.y0) * local.lw + (x - local.x0)] : 0;
                const faceTests = [];
                const keptLocal = new Set();
                if (local) {
                    for (const fc of local.faces) {
                        // A sliver that only closes because the drawing was
                        // grown (the crack between two chairs) is not a face.
                        if (Math.min(fc.maxX - fc.minX, fc.maxY - fc.minY) < 3) {
                            let leaky = false;
                            for (let y = fc.minY; y <= fc.maxY && !leaky; y++) {
                                for (let x = fc.minX; x <= fc.maxX; x++) {
                                    if (local.labels[y * local.lw + x] !== fc.id) continue;
                                    leaky = isFloor[fl[(y + local.y0) * w + x + local.x0]] === 1;
                                    break;
                                }
                            }
                            if (leaky) continue;
                        }
                        keptLocal.add(fc.id);
                        faceTests.push({
                            test: (x, y) => localAt(x, y) === fc.id,
                            x0: fc.minX + local.x0, y0: fc.minY + local.y0,
                            x1: fc.maxX + local.x0, y1: fc.maxY + local.y0
                        });
                    }
                }
                const wallPockets = [];
                for (const p of pocketsOf[c.id]) {
                    if (p.count < minFace) continue;
                    // Skip pockets the local pass already found.
                    let seen = 0;
                    for (let y = p.minY; y <= p.maxY; y++) {
                        for (let x = p.minX; x <= p.maxX; x++) {
                            if (fl[y * w + x] === p.id && keptLocal.has(localAt(x, y))) seen++;
                        }
                    }
                    if (seen >= p.count * 0.5) continue;
                    wallPockets.push(p.id);
                    faceTests.push({
                        test: (x, y) => fl[y * w + x] === p.id,
                        x0: p.minX, y0: p.minY, x1: p.maxX, y1: p.maxY
                    });
                }
                const inAnyFace = (x, y) => keptLocal.has(localAt(x, y)) ||
                    (fl[y * w + x] !== 0 && wallPockets.includes(fl[y * w + x]));

                // A compact free-standing symbol (a chair, a stool) is drawn
                // from its hull — low-resolution chair outlines are too
                // ragged to trust line by line — plus its seat if one shows.
                if (!hasPartition && Math.max(cw, ch) <= gapMax * 1.3) {
                    if (Math.min(cw, ch) < gapMax * 0.45) continue;       // lettering, ticks
                    const rowLo = new Int32Array(ch).fill(w), rowHi = new Int32Array(ch).fill(-1);
                    const colLo = new Int32Array(cw).fill(h), colHi = new Int32Array(cw).fill(-1);
                    for (let y = c.minY; y <= c.maxY; y++) {
                        for (let x = c.minX; x <= c.maxX; x++) {
                            if (cl[y * w + x] !== c.id) continue;
                            if (x < rowLo[y - c.minY]) rowLo[y - c.minY] = x;
                            if (x > rowHi[y - c.minY]) rowHi[y - c.minY] = x;
                            if (y < colLo[x - c.minX]) colLo[x - c.minX] = y;
                            if (y > colHi[x - c.minX]) colHi[x - c.minX] = y;
                        }
                    }
                    // Spanned along its row or its column: fills a shape
                    // drawn open on one side (a desk against a wall).
                    const hull = fitShape((x, y) => x >= c.minX && x <= c.maxX && y >= c.minY && y <= c.maxY &&
                        ((x >= rowLo[y - c.minY] && x <= rowHi[y - c.minY]) ||
                         (y >= colLo[x - c.minX] && y <= colHi[x - c.minX])),
                        c.minX, c.minY, c.maxX, c.maxY, -grow, false);
                    if (!hull || hull.kind !== 'box') continue;
                    furniture.push({ ring: hull.ring });
                    let seat = null, seatArea = cw * ch * 0.2;
                    for (const ft of faceTests) {
                        const face = fitShape(ft.test, ft.x0, ft.y0, ft.x1, ft.y1, grow, true);
                        if (!face || face.kind !== 'box') continue;
                        const area = (face.box.x1 - face.box.x0) * (face.box.y1 - face.box.y0);
                        if (area > seatArea) { seatArea = area; seat = face; }
                    }
                    if (seat) furniture.push({ ring: seat.ring });
                    continue;
                }

                // Fit the faces. A hairline face — straight, or curled
                // round a symbol — is the core of a double-line stroke (a
                // cubicle panel, a chair back) or a crack between two
                // symbols; either way not a shape of its own.
                const wx0 = Math.max(0, c.minX - 3), wy0 = Math.max(0, c.minY - 3);
                const wx1 = Math.min(w - 1, c.maxX + 3), wy1 = Math.min(h - 1, c.maxY + 3);
                const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1;
                const owner = new Int32Array(ww * wh);      // which face a pixel belongs to
                const dist = new Int32Array(ww * wh);
                const hairline = new Uint8Array(ww * wh);
                const kept = [null];
                const queue = [];
                for (const ft of faceTests) {
                    const face = fitShape(ft.test, ft.x0, ft.y0, ft.x1, ft.y1, grow, false);
                    if (!face) continue;
                    const { x0, y0, x1, y1 } = face.box;
                    const pixels = [];
                    for (let y = ft.y0; y <= ft.y1; y++) {
                        for (let x = ft.x0; x <= ft.x1; x++) if (ft.test(x, y)) pixels.push((y - wy0) * ww + (x - wx0));
                    }
                    const bw = ft.x1 - ft.x0 + 1, bh = ft.y1 - ft.y0 + 1;
                    if (Math.min(x1 - x0, y1 - y0) <= 2 ||
                        (pixels.length <= Math.max(bw, bh) * 4.5 && pixels.length < bw * bh * 0.4)) {
                        for (const k of pixels) hairline[k] = 1;
                        continue;
                    }
                    // Seat-sized faces may own a heavy band of ink around
                    // them (arms, back); larger ones just their own outline.
                    const seat = face.kind === 'box' && !hasPartition &&
                        Math.max(x1 - x0, y1 - y0) <= gapMax * 0.9;
                    kept.push({ face, seat, reach: seat ? Math.round(gapMax * 0.4) : Math.ceil(pen) + 1 });
                    for (const k of pixels) { owner[k] = kept.length - 1; queue.push(k); }
                }

                // Share the drawing's ink out among the faces: each stroke
                // pixel goes to the nearest face (breadth-first through the
                // ink and the slits inside double lines), so the band
                // between two chairs is split down the middle.
                const passable = (k, x, y) => {
                    if (hairline[k]) return true;
                    const i = (y + wy0) * w + (x + wx0);
                    if (cl[i] === c.id && !partInk[i]) return true;
                    return !!local && x + wx0 >= local.x0 && x + wx0 <= local.x1 &&
                        y + wy0 >= local.y0 && y + wy0 <= local.y1 &&
                        local.solid[(y + wy0 - local.y0) * local.lw + (x + wx0 - local.x0)] === 1;
                };
                for (let head = 0; head < queue.length; head++) {
                    const k = queue[head];
                    const x = k % ww, y = (k / ww) | 0;
                    if (dist[k] >= kept[owner[k]].reach) continue;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const nx = x + dx, ny = y + dy;
                            if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
                            const n = ny * ww + nx;
                            if (owner[n] || !passable(n, nx, ny)) continue;
                            owner[n] = owner[k];
                            dist[n] = dist[k] + 1;
                            queue.push(n);
                        }
                    }
                }

                const shapes = [];
                for (let id = 1; id < kept.length; id++) {
                    const { face, seat } = kept[id];
                    if (seat) {
                        // Seat plus everything it owns: the whole chair.
                        let ox0 = ww, oy0 = wh, ox1 = -1, oy1 = -1;
                        for (let k = 0; k < ww * wh; k++) {
                            if (owner[k] !== id) continue;
                            const x = k % ww, y = (k / ww) | 0;
                            if (x < ox0) ox0 = x;
                            if (x > ox1) ox1 = x;
                            if (y < oy0) oy0 = y;
                            if (y > oy1) oy1 = y;
                        }
                        const { x0, y0, x1, y1 } = face.box;
                        const margin = Math.max(x0 - wx0 - ox0, y0 - wy0 - oy0, ox1 + 1 - (x1 - wx0), oy1 + 1 - (y1 - wy0));
                        if (margin >= 2.5) {
                            const outer = fitShape((x, y) => x >= wx0 && x <= wx1 && y >= wy0 && y <= wy1 &&
                                owner[(y - wy0) * ww + (x - wx0)] === id,
                                ox0 + wx0, oy0 + wy0, ox1 + wx0, oy1 + wy0, -grow, true);
                            if (outer && outer.kind === 'box') shapes.push(outer.ring);
                        }
                    }
                    shapes.push(face.ring);
                }

                // Strokes the faces don't account for — cubicle panels,
                // brackets, solid blocks — are drawn as their own outline.
                // Only straight work qualifies: leftover curves are door
                // swings and lettering. (Partition ink is drawn separately.)
                const strokeMask = new Uint8Array(ww * wh);
                for (let y = wy0; y <= wy1; y++) {
                    for (let x = wx0; x <= wx1; x++) {
                        const i = y * w + x, k = (y - wy0) * ww + (x - wx0);
                        if (owner[k]) continue;
                        if ((cl[i] === c.id && !partInk[i]) || hairline[k]) strokeMask[k] = 1;
                    }
                }
                const minStroke = Math.max(5, Math.round(gapMax * 0.5));
                const { labels: sl, comps: strokes } = labelMask(strokeMask, ww, wh, true);
                for (const st of strokes) {
                    if (!st) continue;
                    if (Math.max(st.maxX - st.minX, st.maxY - st.minY) + 1 < minStroke) continue;
                    let inkCount = 0, straight = 0, onWall = 0;
                    const thick = [];
                    for (let y = st.minY; y <= st.maxY; y++) {
                        for (let x = st.minX; x <= st.maxX; x++) {
                            if (sl[y * ww + x] !== st.id) continue;
                            let a1 = 1, b1 = 1;
                            for (let k = x - 1; k >= 0 && sl[y * ww + k] === st.id; k--) a1++;
                            for (let k = x + 1; k < ww && sl[y * ww + k] === st.id; k++) a1++;
                            for (let k = y - 1; k >= 0 && sl[k * ww + x] === st.id; k--) b1++;
                            for (let k = y + 1; k < wh && sl[k * ww + x] === st.id; k++) b1++;
                            inkCount++;
                            if (Math.max(a1, b1) >= 5) straight++;
                            // Hugging a wall? (window frames, wall finishes)
                            const gx = x + wx0, gy = y + wy0;
                            for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
                                const px = gx + dx, py = gy + dy;
                                if (px >= 0 && py >= 0 && px < w && py < h && wallMask[py * w + px] && !absorbed[py * w + px]) { onWall++; break; }
                            }
                            thick.push(Math.min(a1, b1));
                        }
                    }
                    if (straight < inkCount * 0.6) continue;
                    thick.sort((p1, p2) => p1 - p2);
                    const weight = thick[thick.length >> 1];
                    if (weight < 3 && onWall >= inkCount * 0.6) continue;  // part of the wall's own drawing
                    // Thin strokes must run a fair way (a panel, a rail):
                    // short ones are the ragged ends of symbols.
                    if (weight < 3 && Math.max(st.maxX - st.minX, st.maxY - st.minY) + 1 < gapMax) continue;

                    const loops = G.traceLoops((x, y) => sl[y * ww + x] === st.id, st.minX, st.minY, st.maxX, st.maxY);
                    if (!loops.length) continue;
                    loops.sort((p1, p2) => Math.abs(G.ringArea(p2)) - Math.abs(G.ringArea(p1)));
                    // Straight work, so square it up; steps smaller than
                    // the stroke itself are raggedness (dash remnants).
                    const shrink = weight >= 3 ? 0.5 : 0;
                    const tol = weight >= 3 ? 2.5 : 0.9;
                    const toImage = ring => ring.map(([x, y]) => [x + wx0, y + wy0]);
                    const rings = [G.offsetRectilinear(G.rectilinearSimplify(loops[0], tol), -shrink)];
                    for (const hole of loops.slice(1)) {
                        if (Math.abs(G.ringArea(hole)) < 9) continue;
                        const hr = G.rectilinearSimplify(hole, tol);
                        if (hr.length >= 4) rings.push(G.offsetRectilinear(hr, shrink));
                    }
                    const pieces = rings.length === 1 ? rings : G.splitRectilinearHoles(rings);
                    for (const ring of pieces) if (ring.length >= 4) furniture.push({ ring: toImage(ring) });
                }
                for (const ring of shapes) furniture.push({ ring });
            }
        }

        // Back to source-image pixels.
        const up = (ring) => ring.map(([x, y]) => [x / s, y / s]);
        const result = {
            scale: s,
            footprint: up(footprint),
            footprintRectilinear,
            rooms: rooms.map(r => ({ ring: up(r.ring), rectilinear: r.rectilinear })),
            walkways: walkways.map(wk => ({
                rings: wk.rings.map(up), rectilinear: wk.rectilinear,
                point: [wk.point[0] / s, wk.point[1] / s]
            })),
            partitions: partitions.map(p => ({ ring: up(p.ring) })),
            furniture: furniture.map(f => ({ ring: up(f.ring) })),
            doors: doors.map(d => ({ x1: d.x1 / s, y1: d.y1 / s, x2: d.x2 / s, y2: d.y2 / s })),
            stats: { scale: s, bMax, gapMax, lMin, jogTol, footTol, minRoom, spaces: spaces.size }
        };
        if (opts.debug) {
            result.debug = { w, h, dashed, ink, mark, wallInk, structural, closed, wallMask, seal, label, absorbed, inFoot, isRoom, spaces: [...spaces.values()] };
        }
        return result;
    }

    return { trace };
});
